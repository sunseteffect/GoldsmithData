#!/usr/bin/env node
// Development check: replays the raw hourly listings (fetch.js --keep-listings)
// with several sales rules and scores each against TSM's region numbers.
// Read-only: doesn't touch the hourly task's state or data files.
// Not part of the addon or the workflow. Rerun as more history piles up.
//
//   node tools/replay-sales.js <AppData.lua> <listings-history dir> [Goldsmith.lua]
//
// Goldsmith.lua (optional saved variables): item names for the examples.
'use strict';
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const [tsmFile, histDir, svFile] = process.argv.slice(2);
if (!tsmFile || !histDir) {
    console.error('Usage: node tools/replay-sales.js <AppData.lua> <listings-history dir> [Goldsmith.lua]');
    process.exit(1);
}
const MAX_GAP = 180;

// TSM region sales (US): soldPerDay and salePercent are x1000, base 32
const b32 = s => parseInt(s, 32);
const tsmText = fs.readFileSync(tsmFile, 'utf8');
const block = tsmText.match(/LoadData\("AUCTIONDB_REGION_SALE","US",\[\[return \{downloadTime=(\d+),fields=\{([^}]*)\},data=\{([\s\S]*?)\}\}\]\]/);
const tsm = new Map();
for (const m of block[3].matchAll(/\{("?[^,{}]+"?),([0-9A-V]+),([0-9A-V]+),([0-9A-V]+)\}/g)) {
    const id = Number(m[1]); if (!Number.isFinite(id)) continue;
    tsm.set(id, { soldPerDay: b32(m[3]) / 1000, salePercent: b32(m[4]) / 1000 });
}

const names = new Map();
if (svFile) {
    const sv = fs.readFileSync(svFile, 'utf8');
    for (const m of sv.matchAll(/\["itemID"\] = (\d+),[^{}]*?\["name"\] = "([^"]+)"/g)) names.set(Number(m[1]), m[2]);
}
const nameOf = id => (names.get(id) || '?') + ` (${id})`;

// Rules. Each sorts every listing that went since the hour before into
// sold / expired / cancelled. Options:
//   repost:  'exact' = a new listing of the same quantity at or below its price
//            (fetch.js today); 'volume' = units newly posted at or below its
//            price, highest gone listings matched first; 'none'
//   medium:  share of MEDIUM (30 min - 2 h left) listings counted as expired
//   ceilEq:  listings at the ceiling price itself count as cancelled too
const RULES = {
    today:            { repost: 'exact',  medium: 0 },
    volume:           { repost: 'volume', medium: 0 },
    volume_med50:     { repost: 'volume', medium: 0.5 },
    volume_med100:    { repost: 'volume', medium: 1 },
    volume_ceilEq:    { repost: 'volume', medium: 0, ceilEq: true },
    volume_med50_ceq: { repost: 'volume', medium: 0.5, ceilEq: true },
    no_repost:        { repost: 'none',   medium: 0 },
};
const ruleNames = Object.keys(RULES);

function load(file) {
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    const lines = text.split('\n');
    const time = Date.parse(lines[0].substring(2));
    const listings = new Map();
    for (let i = 1; i < lines.length; i++) {
        const l = lines[i]; if (!l) continue;
        const f = l.split('\t');
        listings.set(Number(f[0]), [Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4])]);
    }
    return { time, listings };
}

// One hour: returns Map(item -> { partial, gone: [[qty, price, timeLeft]], posted: [[qty, price]], ceiling })
function diffHour(prev, cur) {
    const out = new Map();
    const row = item => {
        let r = out.get(item);
        if (!r) { r = { partial: 0, partialValue: 0, gone: [], posted: [], ceiling: Infinity }; out.set(item, r); }
        return r;
    };
    for (const [id, p] of prev) {
        const c = cur.get(id);
        if (!c) { row(p[0]).gone.push([p[1], p[2], p[3]]); continue; }
        if (c[1] < p[1]) { const r = row(p[0]); r.partial += p[1] - c[1]; r.partialValue += (p[1] - c[1]) * p[2]; }
        else { const r = row(p[0]); if (p[2] < r.ceiling) r.ceiling = p[2]; }
    }
    for (const [id, c] of cur) if (!prev.has(id)) row(c[0]).posted.push([c[1], c[2]]);
    return out;
}

// Applies a rule to one item's hour: { sold, value, expired, cancelled }
function classify(h, rule) {
    let sold = h.partial, value = h.partialValue, expired = 0, cancelled = 0;
    const candidates = [];
    for (const [qty, price, left] of h.gone) {
        if (left === 1) { expired += qty; continue; }
        if (price > h.ceiling || (rule.ceilEq && price >= h.ceiling)) { cancelled += qty; continue; }
        let q = qty;
        if (left === 2 && rule.medium > 0) { const e = qty * rule.medium; expired += e; q -= e; }
        if (q > 0) candidates.push([q, price]);
    }
    if (rule.repost === 'exact') {
        const posted = new Map();
        for (const [qty, price] of h.posted) { const k = qty; if (!posted.has(k)) posted.set(k, []); posted.get(k).push(price); }
        for (const [q, price] of candidates) {
            const list = posted.get(q);
            const at = list ? list.findIndex(p => p <= price) : -1;
            if (at >= 0) { list.splice(at, 1); cancelled += q; } else { sold += q; value += q * price; }
        }
    } else if (rule.repost === 'volume') {
        candidates.sort((a, b) => b[1] - a[1]);
        const pool = h.posted.map(([q, p]) => [q, p]).sort((a, b) => b[1] - a[1]);
        let i = 0;
        for (const [q0, price] of candidates) {
            let q = q0;
            while (i < pool.length && pool[i][1] > price) i++;
            let j = i;
            while (q > 0 && j < pool.length) {
                const take = Math.min(q, pool[j][0]);
                pool[j][0] -= take; q -= take; cancelled += take;
                if (pool[j][0] === 0) j++;
            }
            i = j;
            sold += q; value += q * price;
        }
    } else {
        for (const [q, price] of candidates) { sold += q; value += q * price; }
    }
    return { sold, value, expired, cancelled };
}

// Replay
const files = fs.readdirSync(histDir).filter(f => f.endsWith('.tsv.gz')).sort();
const per = new Map(); // item -> { [rule]: { hourly: [], expired, cancelled, posted } }
let minutes = 0, hours = 0, skipped = 0;
const hourTotals = []; // [time, rule today total sold]
let prev = null;
for (const f of files) {
    const cur = load(path.join(histDir, f));
    if (prev) {
        const gap = (cur.time - prev.time) / 60000;
        if (gap > 0 && gap <= MAX_GAP) {
            minutes += gap; hours++;
            const diff = diffHour(prev.listings, cur.listings);
            const totals = {};
            for (const [item, h] of diff) {
                let o = per.get(item);
                if (!o) { o = {}; for (const r of ruleNames) o[r] = { hourly: [], byHour: [], value: 0, expired: 0, cancelled: 0 }; o.posted = 0; per.set(item, o); }
                for (const [q] of h.posted) o.posted += q;
                for (const r of ruleNames) {
                    const c = classify(h, RULES[r]), s = o[r];
                    s.hourly.push(c.sold); s.byHour[hours - 1] = c.sold; s.value += c.value; s.expired += c.expired; s.cancelled += c.cancelled;
                    totals[r] = (totals[r] || 0) + c.sold;
                }
            }
            hourTotals.push([f, totals]);
        } else skipped++;
    }
    prev = cur;
}
const days = minutes / 1440;
console.log(`Replayed ${hours} hours (${days.toFixed(2)} days, ${files[0]} .. ${files[files.length - 1]}), ${skipped} gaps skipped`);
console.log(`TSM: ${tsm.size} items, downloaded ${new Date(Number(block[1]) * 1000).toISOString().slice(0, 16)}`);

// Market-wide hours: total sold per hour vs the median hour (rule "volume")
const tv = hourTotals.map(([, t]) => t.volume || 0);
const medHour = [...tv].sort((a, b) => a - b)[Math.floor(tv.length / 2)];
const reset = new Set();
hourTotals.forEach(([f, t], i) => { if ((t.volume || 0) > medHour * 3) reset.add(i); });
console.log(`Median hour (volume rule): ${Math.round(medHour)} units sold; hours over 3x: ${[...reset].map(i => hourTotals[i][0].slice(0, 15)).join(', ') || 'none'}`);

const median = a => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; };
// Per-day sold with damping: 'raw'; 'item5' caps an hour at 5x the item's
// median selling hour (fetch.js sell levels); 'reset' also drops market-wide spike hours
function perDay(hourly, mode) {
    if (mode === 'raw') return hourly.reduce((a, b) => a + b, 0) / days;
    const cap = Math.max(median(hourly.filter(x => x > 0)) * 5, 1);
    let sum = 0, mins = minutes;
    hourly.forEach((x, i) => sum += Math.min(x, cap));
    return sum / days;
}

function corr(xs, ys) {
    const n = xs.length, mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0, sxx = 0, syy = 0;
    for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; syy += (ys[i] - my) ** 2; }
    return sxy / Math.sqrt(sxx * syy);
}

// hourly arrays only hold hours where the item changed; that's fine for sums
// and for the median selling hour
function score(rule, mode, filter = () => true) {
    const ratios = [], lx = [], ly = [];
    let zero = 0;
    for (const [id, t] of tsm) {
        if (t.soldPerDay < 1 || !filter(t)) continue;
        const o = per.get(id);
        const v = o ? perDay(o[rule].hourly, mode) : 0;
        if (v <= 0) { zero++; continue; }
        ratios.push(v / t.soldPerDay); lx.push(Math.log10(t.soldPerDay)); ly.push(Math.log10(v));
    }
    ratios.sort((a, b) => a - b);
    const q = p => ratios[Math.floor(p * (ratios.length - 1))];
    return { n: ratios.length, zero, p25: q(0.25), med: q(0.5), p75: q(0.75),
        within2: ratios.filter(x => x >= 0.5 && x <= 2).length / ratios.length, corr: corr(lx, ly) };
}
function rateScore(rule) {
    const xs = [], ys = [], d = [];
    for (const [id, t] of tsm) {
        if (t.soldPerDay < 5) continue;
        const o = per.get(id); if (!o) continue;
        const s = o[rule], sold = s.hourly.reduce((a, b) => a + b, 0);
        if (!sold) continue;
        const r = sold / (sold + s.expired);
        xs.push(t.salePercent); ys.push(r); d.push(Math.abs(r - t.salePercent));
    }
    return { n: xs.length, corr: corr(xs, ys), mad: median(d) };
}

const fx = x => x.toFixed(2);
console.log('\nSold per day, ours / TSM, items TSM says sell 1+/day (target: median 0.8-1.25, most within 2x)');
console.log('rule              damping   n     none   p25   median  p75   within2x  log corr');
for (const r of ruleNames) for (const m of ['raw', 'item5']) {
    const s = score(r, m);
    console.log(`${r.padEnd(17)} ${m.padEnd(8)} ${String(s.n).padStart(5)} ${String(s.zero).padStart(6)}  ${fx(s.p25).padStart(5)}  ${fx(s.med).padStart(5)}  ${fx(s.p75).padStart(5)}   ${(s.within2 * 100).toFixed(0).padStart(4)}%    ${s.corr.toFixed(3)}`);
}

console.log('\nBy how busy the item is (TSM sold/day), damped, median ratio | within 2x');
const bands = [[1, 10], [10, 100], [100, 1000], [1000, Infinity]];
console.log('rule              ' + bands.map(([a, b]) => `${a}-${b === Infinity ? '' : b}`.padEnd(16)).join(''));
for (const r of ruleNames) {
    console.log(r.padEnd(17) + ' ' + bands.map(([a, b]) => {
        const s = score(r, 'item5', t => t.soldPerDay >= a && t.soldPerDay < b);
        return `${fx(s.med)} | ${(s.within2 * 100).toFixed(0)}% (${s.n})`.padEnd(16);
    }).join(''));
}

console.log('\nSale rate sold/(sold+expired) vs TSM sale %, items TSM 5+/day');
for (const r of ruleNames) { const s = rateScore(r); console.log(`${r.padEnd(17)} n=${s.n}  correlation ${s.corr.toFixed(3)}  median abs diff ${s.mad.toFixed(3)}`); }

// Self-agreement: the first half of the hours against the second half. If
// our own halves agree far better than we agree with TSM, the gap is in what
// TSM measures (or its window), not noise from too few days
{
    const half = Math.floor(hours / 2);
    console.log(`\nOur first ${half} hours vs the last ${hours - half}, items TSM says sell 1+/day`);
    for (const r of ['today', 'volume', 'volume_med100']) {
        const ratios = [];
        for (const [id, t] of tsm) {
            if (t.soldPerDay < 1) continue;
            const o = per.get(id); if (!o) continue;
            const a = o[r].byHour.slice(0, half).reduce((s, x) => s + x, 0), b = o[r].byHour.slice(half).reduce((s, x) => s + x, 0);
            if (a > 0 && b > 0) ratios.push(a / b * (hours - half) / half);
        }
        const within = ratios.filter(x => x >= 0.5 && x <= 2).length / ratios.length;
        console.log(`${r.padEnd(17)} n=${ratios.length}  halves within 2x of each other: ${(within * 100).toFixed(0)}%`);
    }
}

// Examples: the best rule's worst items each way, and named items
const best = ruleNames.map(r => [r, score(r, 'item5')]).sort((a, b) => Math.abs(Math.log(a[1].med)) - Math.abs(Math.log(b[1].med)) || b[1].within2 - a[1].within2)[0][0];
const rows = [];
for (const [id, t] of tsm) {
    if (t.soldPerDay < 20) continue;
    const o = per.get(id); if (!o) continue;
    rows.push({ id, t, today: perDay(o.today.hourly, 'item5'), best: perDay(o[best].hourly, 'item5') });
}
rows.sort((a, b) => b.best / b.t.soldPerDay - a.best / a.t.soldPerDay);
const show = x => `${nameOf(x.id).padEnd(44).slice(0, 44)} TSM ${x.t.soldPerDay.toFixed(0).padStart(6)}  today ${x.today.toFixed(0).padStart(6)} (${fx(x.today / x.t.soldPerDay)}x)  ${best} ${x.best.toFixed(0).padStart(6)} (${fx(x.best / x.t.soldPerDay)}x)`;
console.log(`\nClosest rule (damped): ${best}. Most overcounted, TSM 20+/day:`);
rows.slice(0, 12).forEach(x => console.log(show(x)));
console.log('Most undercounted:');
rows.slice(-8).forEach(x => console.log(show(x)));
if (names.size) {
    console.log('\nYour items (from saved data), busiest first:');
    rows.filter(x => names.has(x.id)).sort((a, b) => b.t.soldPerDay - a.t.soldPerDay).slice(0, 25).forEach(x => console.log(show(x)));
}
