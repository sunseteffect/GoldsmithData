#!/usr/bin/env node
// Checks Goldsmith Data's sell levels (Sells / Slow / Hardly sells) offline,
// from the daily archive (fetch.js archiveDays) and, optionally, a player's
// own posts and sales:
//
//   node tools/score-levels.js <archive dir> [Goldsmith.lua] [--days-old N]
//
// 1. Stability: the levels each day would have had (same rule as fetch.js,
//    from the 7 archived days before it), and how often an item's level
//    changes from one day to the next. A level that flips a lot is noise,
//    not advice.
// 2. Scorecard (with Goldsmith.lua): each of your posts, the level its item
//    had that day, and whether it sold. A sale is matched to your oldest
//    open post of the same item on the same character before it: within 2
//    days of when it sold (sales saved with soldAt), else within 7 days of
//    when you collected the mail. Posts newer than --days-old (default 3)
//    before your latest entry aren't scored (their sales may not be
//    collected yet). Reposts count as new posts, so an item you undercut
//    and repost scores lower (like TSM's sale rate).
// Posts and sales name the item; where silver and gold of an item have
// different levels the post shows as "mixed" (posts saved with postedID
// know the exact item). Reads only.
'use strict';

const fs = require('fs');
const path = require('path');
const { levelFor, readArchive, LEVEL, LEVEL_DAYS, LEVEL_MIN_HOURS, MAX_GAP } = require('./fetch.js');

const args = process.argv.slice(2);
let daysOld = 3;
const files = [];
for (let i = 0; i < args.length; i++) {
    if (args[i] === '--days-old') daysOld = Number(args[++i]);
    else files.push(args[i]);
}
const [archDir, svFile] = files;
if (!archDir) {
    console.error('Usage: node tools/score-levels.js <archive dir> [Goldsmith.lua] [--days-old N]');
    process.exit(1);
}

const NAME = { [LEVEL.sells]: 'Sells', [LEVEL.slow]: 'Slow', [LEVEL.none]: 'Hardly' };
const LETTER = { [LEVEL.sells]: 'S', [LEVEL.slow]: 'w', [LEVEL.none]: '.' };
const DAY = 86400000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const pct = (a, b) => b ? `${Math.round(100 * a / b)}%` : '-';

// --- Per archived day: what the level rule needs ----------------------------
const days = []; // { day, hours, dayCount(0/1), items: Map(id -> { hourly: [], units }), near: Map(id -> units) }
for (const f of fs.readdirSync(archDir).filter(f => /^\d{4}-\d\d-\d\d\.tsv\.gz$/.test(f)).sort()) {
    const a = readArchive(path.join(archDir, f));
    const compared = a.minutes.map(m => typeof m === 'number' && m > 0 && m <= MAX_GAP);
    let lastHour = -1;
    a.minutes.forEach((m, h) => { if (m !== null) lastHour = h; });
    const items = new Map(), near = new Map();
    for (const [id, o] of a.items) {
        const hourly = [];
        let units = 0;
        for (let h = 0; h < 24; h++) {
            if (compared[h] && o.sold[h] > 0) { hourly.push(o.sold[h]); units += o.sold[h]; }
        }
        if (hourly.length) items.set(id, { hourly, units });
        if (lastHour >= 0 && o.near[lastHour] !== null) near.set(id, o.near[lastHour]);
    }
    days.push({ day: f.slice(0, 10), hours: compared.filter(Boolean).length, items, near });
}
if (!days.length) { console.error('No archive days in ' + archDir); process.exit(1); }

// Levels in effect on a day: from the LEVEL_DAYS archived days before it,
// with the near-lowest stock at the end of the day before. Map(id -> { level,
// perDay }) or null without enough hours.
function levelsOn(day) {
    const start = dayOf(Date.parse(day) - LEVEL_DAYS * DAY);
    const window = days.filter(d => d.day >= start && d.day < day);
    if (!window.length || window[window.length - 1].day !== dayOf(Date.parse(day) - DAY)) return null;
    // Snapshots before 2026-10-07 have no near-lowest stock: no levels
    if (!window[window.length - 1].near.size) return null;
    const hours = window.reduce((s, d) => s + d.hours, 0);
    if (hours < LEVEL_MIN_HOURS) return null;
    const dayCount = window.filter(d => d.hours > 0).length;
    const out = new Map();
    for (const [id, units] of window[window.length - 1].near) {
        const hourly = [];
        let salesDays = 0, sold = 0;
        for (const d of window) {
            const o = d.items.get(id);
            if (!o) continue;
            hourly.push(...o.hourly);
            salesDays++;
            sold += o.units;
        }
        out.set(id, { level: levelFor(hourly, salesDays, hours, dayCount, units), perDay: sold / (hours / 24),
            full: window.length >= LEVEL_DAYS });
    }
    return out;
}

const levelDays = []; // [day, Map]
for (let t = Date.parse(days[0].day) + DAY; t <= Date.parse(days[days.length - 1].day) + DAY; t += DAY) {
    const lv = levelsOn(dayOf(t));
    if (lv) levelDays.push([dayOf(t), lv]);
}
console.log(`Archive: ${days.length} days (${days[0].day} .. ${days[days.length - 1].day}); levels for ${levelDays.length} days`
    + (levelDays.length ? ` (${levelDays[0][0]} .. ${levelDays[levelDays.length - 1][0]})` : ''));

// --- 1. Stability ------------------------------------------------------------
const band = perDay => perDay < 1 ? 'under 1/day' : perDay < 10 ? '1-10/day' : perDay < 100 ? '10-100/day'
    : perDay < 1000 ? '100-1000/day' : '1000+/day';
const BANDS = ['under 1/day', '1-10/day', '10-100/day', '100-1000/day', '1000+/day'];
const full = levelDays.filter(([, lv]) => [...lv.values()][0] && [...lv.values()][0].full);
console.log(`\n== Stability: day-to-day level changes (${full.length} days with a full ${LEVEL_DAYS}-day window) ==`);
const moves = new Map(); // "from>to" -> count
const byBand = new Map(BANDS.map(b => [b, { pairs: 0, changed: 0 }]));
const changesPer = new Map(); // id -> changes
let pairs = 0, changed = 0, jumps = 0;
for (let i = 1; i < full.length; i++) {
    const [, a] = full[i - 1], [, b] = full[i];
    for (const [id, x] of a) {
        const y = b.get(id);
        if (!y) continue;
        pairs++;
        const bb = byBand.get(band(x.perDay));
        bb.pairs++;
        if (x.level !== y.level) {
            changed++; bb.changed++;
            const key = `${NAME[x.level]} > ${NAME[y.level]}`;
            moves.set(key, (moves.get(key) || 0) + 1);
            if (Math.abs(x.level - y.level) === 2) jumps++;
            changesPer.set(id, (changesPer.get(id) || 0) + 1);
        }
    }
}
console.log(`Item-days compared: ${pairs}; level changed: ${changed} (${pct(changed, pairs)}); Sells <> Hardly in one day: ${jumps} (${pct(jumps, pairs)})`);
for (const [k, v] of [...moves].sort((a, b) => b[1] - a[1])) console.log(`  ${k.padEnd(18)} ${v}`);
console.log('By how much the item sells:');
for (const [b, o] of byBand) console.log(`  ${b.padEnd(14)} ${pct(o.changed, o.pairs).padStart(4)} of ${o.pairs} item-days changed`);
const flippers = [...changesPer.values()];
const items = full.length ? full[full.length - 1][1].size : 0;
console.log(`Items changing level 3+ times in ${full.length} days: ${flippers.filter(n => n >= 3).length} of ${items}`
    + ` (2: ${flippers.filter(n => n === 2).length}, 1: ${flippers.filter(n => n === 1).length})`);

if (!svFile) process.exit(0);

// --- Saved variables: posts, sales, item names -------------------------------
// The file as WoW writes it: NAME = <table>, with ["key"] = value and [n] =
// value fields, one per line. Returns { NAME: value }.
function parseSavedVariables(text) {
    let i = 0;
    const ws = () => { while (i < text.length && /[\s,;]/.test(text[i])) i++; if (text.startsWith('--', i)) { i = text.indexOf('\n', i); if (i < 0) i = text.length; ws(); } };
    function value() {
        ws();
        const c = text[i];
        if (c === '{') {
            i++;
            const t = {};
            let n = 1;
            for (;;) {
                ws();
                if (text[i] === '}') { i++; return t; }
                let key;
                if (text[i] === '[') {
                    i++; key = value(); ws(); i++; // ]
                    ws(); i++; // =
                    t[key] = value();
                } else {
                    t[n++] = value();
                }
            }
        }
        if (c === '"') {
            let s = '';
            i++;
            while (text[i] !== '"') {
                if (text[i] === '\\') {
                    i++;
                    const e = text[i];
                    s += e === 'n' ? '\n' : e === 't' ? '\t' : e === '\n' ? '\n' : /\d/.test(e)
                        ? (() => { const m = text.slice(i).match(/^\d{1,3}/)[0]; i += m.length - 1; return String.fromCharCode(Number(m)); })()
                        : e;
                } else s += text[i];
                i++;
            }
            i++;
            return s;
        }
        const m = text.slice(i, i + 40).match(/^(true|false|nil|-?[\d.]+(?:e[-+]?\d+)?)/i);
        if (!m) throw new Error(`Can't read the saved variables at ${i}: ${text.slice(i, i + 30)}`);
        i += m[0].length;
        return m[0] === 'true' ? true : m[0] === 'false' ? false : m[0] === 'nil' ? null : Number(m[0]);
    }
    const out = {};
    for (;;) {
        ws();
        if (i >= text.length) return out;
        const m = text.slice(i).match(/^([A-Za-z_]\w*)\s*=/);
        if (!m) throw new Error(`Can't read the saved variables at ${i}`);
        i += m[0].length;
        out[m[1]] = value();
    }
}

const db = parseSavedVariables(fs.readFileSync(svFile, 'utf8')).GoldsmithDB || {};
const idsByName = new Map();
const addName = (id, name) => {
    if (typeof id !== 'number' || typeof name !== 'string' || !name) return;
    if (!idsByName.has(name)) idsByName.set(name, new Set());
    idsByName.get(name).add(id);
};
// Every table that pairs an item with its name: item links, recipes and their
// material slots (one name for all qualities), each tier's output of a recipe
const listOf = t => t && typeof t === 'object' ? Object.keys(t).filter(k => /^\d+$/.test(k)).map(k => t[k]) : [];
(function walk(t, depth) {
    if (!t || typeof t !== 'object' || depth > 12) return;
    addName(t.itemID, t.name);
    addName(t.outputItemID, t.outputName || t.name);
    if (t.itemIDs && t.names) {
        const ids = listOf(t.itemIDs), names = listOf(t.names);
        ids.forEach((id, k) => addName(id, names.length === ids.length ? names[k] : names[0]));
    }
    for (const v of Object.values(t)) {
        if (typeof v === 'string' && v.includes('|Hitem:')) {
            for (const m of v.matchAll(/\|Hitem:(\d+):[^|]*\|h\[([^\]|]+?)\s*(?:\|A[^\]]*)?\]/g)) addName(Number(m[1]), m[2]);
        } else if (v && typeof v === 'object') walk(v, depth + 1);
    }
})(db, 0);
// tierData[recipeID].outputs: the item of each quality, named after the recipe
for (const [recipeID, tier] of Object.entries(db.tierData || {})) {
    const recipe = (db.recipes || {})[recipeID];
    for (const o of listOf(tier && tier.outputs)) addName(o && o.itemID, recipe && (recipe.outputName || recipe.name));
}

const posts = [], sales = [];
for (const f of listOf(db.entries)) {
    const isPost = f.type === 'COST' && f.kind === 'DEPOSIT', isSale = f.type === 'REVENUE';
    if (!(isPost || isSale) || !f.item || !f.timestamp) continue;
    if (isSale) addName(f.itemID, f.item);
    if (isPost) addName(f.postedID, f.item);
    const e = { name: f.item, who: `${f.character}-${f.realm}`, qty: f.quantity || 0, at: f.timestamp * 1000 };
    if (isPost) posts.push({ ...e, id: f.postedID, savedLevel: f.sellLevel, sold: 0 });
    else sales.push({ ...e, at: (f.soldAt || f.timestamp) * 1000, exact: !!f.soldAt });
}
const latest = Math.max(...posts.map(p => p.at), ...sales.map(s => s.at));
console.log(`\n== Scorecard: your posts (${posts.length}) and sales (${sales.length}), latest ${dayOf(latest)} ==`);

// Level of a post: saved at posting, else from the archive by exact item,
// else by name (all its items must agree). Posts from before the first day
// with levels also get the nearest day's level (approx: levels move ~8% a day)
const levelMap = new Map(levelDays);
function levelIn(p, lv) {
    const ids = p.id ? [p.id] : [...(idsByName.get(p.name) || [])];
    if (!ids.length) return 'unknown item';
    const found = new Set(ids.map(id => lv.get(id)).filter(Boolean).map(x => x.level));
    return found.size === 1 ? [...found][0] : found.size ? 'mixed' : 'not listed';
}
for (const p of posts) {
    if (p.savedLevel) { p.level = p.approx = p.savedLevel; continue; }
    const lv = levelMap.get(dayOf(p.at));
    p.level = lv ? levelIn(p, lv) : 'no data';
    if (lv || !levelDays.length) { p.approx = p.level; continue; }
    const nearest = levelDays.reduce((best, d) => Math.abs(Date.parse(d[0]) - p.at) < Math.abs(Date.parse(best[0]) - p.at) ? d : best);
    p.approx = levelIn(p, nearest[1]);
}

// Match sales to posts (oldest open post first)
const byKey = new Map();
const keyOf = e => `${e.who}|${e.name}`;
for (const p of posts) { if (!byKey.has(keyOf(p))) byKey.set(keyOf(p), []); byKey.get(keyOf(p)).push(p); }
for (const list of byKey.values()) list.sort((a, b) => a.at - b.at);
let unmatched = 0;
for (const s of [...sales].sort((a, b) => a.at - b.at)) {
    const reach = (s.exact ? 2.1 : 7) * DAY;
    let left = s.qty;
    for (const p of byKey.get(keyOf(s)) || []) {
        if (left <= 0) break;
        if (p.at > s.at || s.at - p.at > reach || p.sold >= p.qty) continue;
        const n = Math.min(left, p.qty - p.sold);
        p.sold += n; left -= n;
    }
    unmatched += left;
}

const scored = posts.filter(p => p.at <= latest - daysOld * DAY);
console.log(`Scored: ${scored.length} posts at least ${daysOld} days old; sold units not matched to a post: ${unmatched}`);
function scoreBy(field, title) {
    const groups = new Map();
    for (const p of scored) {
        const g = typeof p[field] === 'number' ? NAME[p[field]] : p[field];
        if (!groups.has(g)) groups.set(g, { posts: 0, units: 0, sold: 0, none: 0, items: new Map() });
        const o = groups.get(g);
        o.posts++; o.units += p.qty; o.sold += p.sold; if (!p.sold) o.none++;
        const it = o.items.get(p.name) || { posts: 0, units: 0, sold: 0 };
        it.posts++; it.units += p.qty; it.sold += p.sold;
        o.items.set(p.name, it);
    }
    console.log(`\n${title}\nLevel          posts  units   sold  share sold  posts with no sale`);
    for (const g of ['Sells', 'Slow', 'Hardly', 'mixed', 'not listed', 'unknown item', 'no data']) {
        const o = groups.get(g);
        if (!o) continue;
        console.log(`${g.padEnd(13)} ${String(o.posts).padStart(6)} ${String(o.units).padStart(6)} ${String(o.sold).padStart(6)}  ${pct(o.sold, o.units).padStart(10)}  ${pct(o.none, o.posts).padStart(18)}`);
    }
    return groups;
}
scoreBy('level', 'Level that day:');
const groups = scoreBy('approx', 'Including earlier posts at the nearest day\'s level (approximate):');
for (const g of ['Sells', 'Slow', 'Hardly', 'mixed']) {
    const o = groups.get(g);
    if (!o) continue;
    console.log(`\n${g}: by item (units sold / posted)`);
    for (const [name, it] of [...o.items].sort((a, b) => b[1].units - a[1].units)) {
        console.log(`  ${pct(it.sold, it.units).padStart(4)}  ${String(it.sold).padStart(4)}/${String(it.units).padEnd(4)} ${it.posts} posts  ${name}`);
    }
}

// Your items' levels day by day (S sells, w slow, . hardly, blank not listed)
console.log(`\nYour posted items, level each day ${levelDays.length ? levelDays[0][0] + ' ..' : ''} (S sells, w slow, . hardly):`);
const names = [...new Set(posts.map(p => p.name))].sort();
for (const name of names) {
    const ids = [...(idsByName.get(name) || [])].sort((a, b) => a - b);
    for (const id of ids) {
        const line = levelDays.map(([, lv]) => lv.has(id) ? LETTER[lv.get(id).level] : ' ').join('');
        if (line.trim()) console.log(`  ${line}  ${name} (${id})`);
    }
}
