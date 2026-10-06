#!/usr/bin/env node
// Development check: compares the sales estimated from our hourly snapshots
// with TSM's region numbers (TradeSkillMaster_AppHelper's AppData.lua, US).
// Not part of the addon or the workflow.
//
//   node tools/compare-tsm.js <AppData.lua> <snapshots dir> [names.tsv]
//
// names.tsv (optional): itemID <tab> kind <tab> name, to list your items.
// TSM stores regionSoldPerDay and regionSalePercent x1000, in base 32.
const fs = require('fs'), path = require('path');
const [tsmFile, snapDir, namesFile] = process.argv.slice(2);
if (!tsmFile || !snapDir) {
    console.error('Usage: node tools/compare-tsm.js <AppData.lua> <snapshots dir> [names.tsv]');
    process.exit(1);
}
const b32 = s => parseInt(s, 32);
// TSM region sales (US)
const tsmText = fs.readFileSync(tsmFile, 'utf8');
const block = tsmText.match(/LoadData\("AUCTIONDB_REGION_SALE","US",\[\[return \{downloadTime=(\d+),fields=\{([^}]*)\},data=\{([\s\S]*?)\}\}\]\]/);
const fields = block[2].replace(/"/g, '').split(',');
const tsm = new Map();
for (const m of block[3].matchAll(/\{("?[^,{}]+"?),([0-9A-V]+),([0-9A-V]+),([0-9A-V]+)\}/g)) {
    const id = Number(m[1]); if (!Number.isFinite(id)) continue;
    tsm.set(id, { sale: b32(m[2]), soldPerDay: b32(m[3]) / 1000, salePercent: b32(m[4]) / 1000 });
}
// Our snapshots
const ours = new Map(); let minutes = 0, hours = 0;
for (const f of fs.readdirSync(snapDir).filter(f => f.endsWith('.csv')).sort()) {
    const lines = fs.readFileSync(path.join(snapDir, f), 'utf8').trim().split(/\r?\n/).slice(1);
    const mins = Number((lines[0] || '').split(',')[12]);
    if (!mins) continue;
    minutes += mins; hours++;
    for (const l of lines) {
        const c = l.split(',');
        const id = Number(c[0]); const sold = Number(c[5] || 0), value = Number(c[6] || 0);
        let o = ours.get(id); if (!o) { o = { sold: 0, value: 0, expired: 0, cancelled: 0, reposted: 0, posted: 0, hourly: [] }; ours.set(id, o); }
        o.sold += sold; o.value += value; o.expired += Number(c[8] || 0); o.cancelled += Number(c[9] || 0);
        o.reposted += Number(c[10] || 0); o.posted += Number(c[11] || 0); o.hourly.push(sold);
    }
}
const days = minutes / 1440;
const names = new Map();
if (namesFile) for (const l of fs.readFileSync(namesFile, 'utf8').split('\n')) { const [id, kind, name] = l.split('\t'); if (name) names.set(Number(id), { kind, name: name.trim() }); }
const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// Damped: each hour capped at 10x the item's median nonzero-hour... use cap = max(10*median hour, 3*mean of hours without the top 1%)
function damped(o) {
    const h = o.hourly; const med = median(h);
    const cap = Math.max(med * 10, 1);
    return h.reduce((s, x) => s + Math.min(x, Math.max(cap, median(h.filter(v => v > 0)) * 5)), 0);
}
const rows = [];
for (const [id, t] of tsm) {
    const o = ours.get(id); if (!o) continue;
    rows.push({ id, t, o, raw: o.sold / days, damp: damped(o) / days });
}
console.log(`TSM region sale items: ${tsm.size}; our items: ${ours.size}; overlap: ${rows.length}; our coverage: ${hours} hours, ${days.toFixed(2)} days`);
// Overall agreement on items TSM says sell >= 1/day
function stats(label, pick) {
    const r = rows.filter(x => x.t.soldPerDay >= 1 && pick(x) > 0);
    const ratios = r.map(x => pick(x) / x.t.soldPerDay).sort((a, b) => a - b);
    const q = p => ratios[Math.floor(p * (ratios.length - 1))];
    const lx = r.map(x => Math.log10(x.t.soldPerDay)), ly = r.map(x => Math.log10(pick(x)));
    const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < lx.length; i++) { sxy += (lx[i] - mx) * (ly[i] - my); sxx += (lx[i] - mx) ** 2; syy += (ly[i] - my) ** 2; }
    const within2 = ratios.filter(x => x >= 0.5 && x <= 2).length / ratios.length;
    console.log(`${label}: n=${r.length}, ours/TSM ratio p10 ${q(0.1).toFixed(2)} p25 ${q(0.25).toFixed(2)} median ${q(0.5).toFixed(2)} p75 ${q(0.75).toFixed(2)} p90 ${q(0.9).toFixed(2)}; log correlation ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}; within 2x: ${(within2 * 100).toFixed(0)}%`);
}
stats('raw    ', x => x.raw);
stats('damped ', x => x.damp);
const zeroOurs = rows.filter(x => x.t.soldPerDay >= 1 && x.raw === 0).length;
console.log(`TSM >= 1/day but we saw none: ${zeroOurs}`);
// Named items (yours), largest TSM first
const named = rows.filter(x => names.has(x.id) && x.t.soldPerDay >= 0.5).sort((a, b) => b.t.soldPerDay - a.t.soldPerDay);
console.log('\nYour items (TSM sold/day | ours raw | ours damped | TSM sale% | ours sold/(sold+expired) | sold/(sold+expired+cancelled))');
for (const x of named.slice(0, 45)) {
    const o = x.o;
    const r1 = o.sold / Math.max(o.sold + o.expired, 1), r2 = o.sold / Math.max(o.sold + o.expired + o.cancelled, 1);
    console.log(`${names.get(x.id).name.padEnd(36).slice(0, 36)} ${x.t.soldPerDay.toFixed(1).padStart(9)} ${x.raw.toFixed(1).padStart(9)} ${x.damp.toFixed(1).padStart(9)}   ${(x.t.salePercent).toFixed(2).padStart(5)}  ${r1.toFixed(2)}  ${r2.toFixed(2)}`);
}
// Sale rate agreement
function rateStats(label, f) {
    const r = rows.filter(x => x.t.soldPerDay >= 5 && x.o.sold > 0);
    const d = r.map(x => Math.abs(f(x.o) - x.t.salePercent)).sort((a, b) => a - b);
    const lx = r.map(x => x.t.salePercent), ly = r.map(x => f(x.o));
    const mx = lx.reduce((a, b) => a + b, 0) / lx.length, my = ly.reduce((a, b) => a + b, 0) / ly.length;
    let sxy = 0, sxx = 0, syy = 0; for (let i = 0; i < lx.length; i++) { sxy += (lx[i] - mx) * (ly[i] - my); sxx += (lx[i] - mx) ** 2; syy += (ly[i] - my) ** 2; }
    console.log(`${label}: n=${r.length}, median abs diff ${d[Math.floor(d.length / 2)].toFixed(3)}, correlation ${(sxy / Math.sqrt(sxx * syy)).toFixed(3)}`);
}
console.log('');
rateStats('sale rate sold/(sold+expired)          ', o => o.sold / Math.max(o.sold + o.expired, 1));
rateStats('sale rate sold/(sold+expired+cancelled)', o => o.sold / Math.max(o.sold + o.expired + o.cancelled, 1));
rateStats('sale rate sold/posted                  ', o => Math.min(o.sold / Math.max(o.posted, 1), 1));
