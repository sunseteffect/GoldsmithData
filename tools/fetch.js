#!/usr/bin/env node
// Goldsmith Data: fetches region-wide commodity prices from the Blizzard Game
// Data API and writes one Lua data file per region (Data_US.lua, ...) for the
// Goldsmith addon. Runs hourly: on GitHub Actions for releases, or on a PC
// for testing. Each run also compares the listings with the previous hour's to
// estimate what sold, and keeps that in hourly snapshots (for sales history).
//
//   BLIZZARD_CLIENT_ID=... BLIZZARD_CLIENT_SECRET=... node tools/fetch.js
//   node tools/fetch.js --regions us,eu --out . --state state
//
// Options:
//   --regions us,eu,kr,tw  regions to fetch (default all four; CN uses another API)
//   --out DIR              where Data_<REGION>.lua go (default: the addon folder)
//   --state DIR            listings, snapshots and logs per region (default: ./state)
//   --force                write even if Blizzard hasn't published new data
//   --from-file FILE       testing: read a saved commodities JSON (one region)
//   --keep-days N          days of hourly snapshots to keep (default 14)
//   --keep-archive-days N  days of the compact daily archive to keep (default
//                          0: forever)
//   --keep-listings R:H    also keep region R's raw hourly listings (gzipped)
//                          for H hours, to replay sales rules offline (us:72)
//
// Ported from Goldsmith's Tools\Fetch-PriceData.ps1 (same rules and output).
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const REGION_IDS = { us: 1, kr: 2, eu: 3, tw: 4 }; // GetCurrentRegion() in game
const TIME_LEFT = { SHORT: 1, MEDIUM: 2, LONG: 3, VERY_LONG: 4 };
const MAX_GAP = 180; // minutes; listings further apart than this aren't compared

// Sell levels (see sellLevels): how well each item sells, from the last week
// of hourly snapshots. Written as the 5th number of each item.
const LEVEL = { none: 1, slow: 2, sells: 3 };
const LEVEL_DAYS = 7;          // history looked at
const LEVEL_MIN_HOURS = 72;    // compared hours needed before any levels
const NEAR_MIN = 1.10;         // "near the lowest price": up to 10% above it
const SPIKE_CAP = 5;           // an hour counts at most 5x the item's usual selling hour
const SELLS_HOUR_SHARE = 0.5;  // sells: a sale in half the hours or more...
const SELLS_SUPPLY_DAYS = 2;   // ...and under 2 days of stock near the lowest price.
// Was 1 hour in 5 and a week: too loose. Of the user's posts of Sells items
// (Oct 8-29 2026), those under half the hours sold 0-36% of units, those
// over half sold 65-74%; with 2+ days of stock ~40% (tools/score-levels.js)
const NONE_DAY_SHARE = 0.5;    // doesn't sell: sales on under half the days,
const NONE_PER_DAY = 1;        // or under 1 a day,
const NONE_HOUR_SHARE = 0.05;  // or in under 1 hour in 20

// Usual prices (see usualPrices): what each item usually costs, from the
// daily archive, so Goldsmith can say "cheap today" on a fresh install
// instead of waiting days for its own history. Written as the 7th number.
const USUAL_DAYS = 7;          // finished days looked at
const USUAL_MIN_DAYS = 5;      // days with a price needed (Goldsmith's own rule)
const UNDERCUT_RATIO = 0.6;    // Goldsmith's price rule (GetBlizzardPrice):
const MARKET_TRUST_RATIO = 3;  // see hourPrice

function parseArgs(argv) {
    const opts = { regions: Object.keys(REGION_IDS), out: path.join(__dirname, '..'),
        state: path.join(process.cwd(), 'state'), force: false, fromFile: null, keepDays: 14, keepArchiveDays: 0,
        keepListings: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--regions') opts.regions = argv[++i].split(',').map(s => s.trim().toLowerCase());
        else if (a === '--out') opts.out = argv[++i];
        else if (a === '--state') opts.state = argv[++i];
        else if (a === '--force') opts.force = true;
        else if (a === '--from-file') opts.fromFile = argv[++i];
        else if (a === '--keep-days') opts.keepDays = Number(argv[++i]);
        else if (a === '--keep-archive-days') opts.keepArchiveDays = Number(argv[++i]);
        else if (a === '--keep-listings') {
            for (const part of argv[++i].split(',')) {
                const [r, h] = part.split(':');
                opts.keepListings[r.trim().toLowerCase()] = Number(h);
            }
        }
        else throw new Error(`Unknown option ${a}`);
    }
    for (const r of opts.regions) if (!REGION_IDS[r]) throw new Error(`Unknown region ${r}`);
    if (opts.fromFile && opts.regions.length !== 1) throw new Error('--from-file needs exactly one --regions');
    return opts;
}

// .NET's Math.Round and [int] casts round halves to even; match them so the
// numbers are the same as the PowerShell version's
function roundHalfEven(x) {
    const f = Math.floor(x), d = x - f;
    if (d > 0.5) return f + 1;
    if (d < 0.5) return f;
    return f % 2 === 0 ? f : f + 1;
}

function pad(n) { return String(n).padStart(2, '0'); }
function stamp(date) { // UTC, for logs and snapshot names
    return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`
        + ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`;
}

function writeAtomic(file, text) {
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
}

async function getToken() {
    const id = process.env.BLIZZARD_CLIENT_ID, secret = process.env.BLIZZARD_CLIENT_SECRET;
    if (!id || !secret) throw new Error('Set BLIZZARD_CLIENT_ID and BLIZZARD_CLIENT_SECRET');
    const res = await fetch('https://oauth.battle.net/token', {
        method: 'POST',
        headers: { Authorization: 'Basic ' + Buffer.from(`${id}:${secret}`).toString('base64'),
            'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`OAuth token: HTTP ${res.status}`);
    return (await res.json()).access_token;
}

// Lua syntax check when luac is available (LUAC, or luac5.1 / luac on PATH)
function luacCheck(file) {
    for (const exe of [process.env.LUAC, 'luac5.1', 'luac'].filter(Boolean)) {
        try {
            execFileSync(exe, ['-p', file], { stdio: 'pipe' });
            return true;
        } catch (e) {
            if (e.code === 'ENOENT') continue;
            throw new Error(`Generated ${path.basename(file)} failed the syntax check: ${e.stderr || e.message}`);
        }
    }
    return false;
}

// Sell levels from the hourly snapshots of the last LEVEL_DAYS (only hours
// compared with the hour before). Our sold counts run high (a cancel can
// look like a sale), so levels lean on things that survive that:
// - how often an item sells (share of hours and of days with a sale)
// - sold per day with one-hour spikes damped (a flipper buying out the
//   market), only to judge "under 1 a day" and days of stock
// - days of stock near the lowest price (near / sold per day): buyers fill
//   from the cheapest up, so overpriced listings don't stand in your way
// Also what each item sold for: the median over its selling hours of that
// hour's average sale price (copper), so a lone shelf listing left after
// the cheap ones sold doesn't pass for the price (Goldsmith caps slow
// sellers' prices at a few times this).
// near = item -> units listed near the lowest price this hour. Returns
// { levels: Map(item -> 1..3), salePrices: Map(item -> copper), hours } or
// null without enough history.
function sellLevels(snapDir, near, now) {
    const stampOf = f => {
        const m = f.match(/^(\d{4})-(\d\d)-(\d\d)_(\d\d)(\d\d)\.csv$/);
        return m ? Date.UTC(m[1], m[2] - 1, m[3], m[4], m[5]) : null;
    };
    const from = now - LEVEL_DAYS * 86400000;
    const perItem = new Map(); // item -> { hourly: [sold], prices: [avg sale price], days: Set }
    const dayKeys = new Set();
    let hours = 0;
    for (const f of fs.readdirSync(snapDir).sort()) {
        const t = stampOf(f);
        if (t === null || t < from) continue;
        const lines = fs.readFileSync(path.join(snapDir, f), 'utf8').split(/\r?\n/);
        const minutes = Number((lines[1] || '').split(',')[12]);
        if (!minutes || minutes > MAX_GAP) continue;
        hours++;
        const day = f.slice(0, 10);
        dayKeys.add(day);
        for (let i = 1; i < lines.length; i++) {
            if (!lines[i]) continue;
            const c = lines[i].split(',');
            const sold = Number(c[5] || 0);
            if (!sold) continue;
            const item = Number(c[0]);
            let o = perItem.get(item);
            if (!o) { o = { hourly: [], prices: [], days: new Set() }; perItem.set(item, o); }
            o.hourly.push(sold);
            const value = Number(c[6] || 0);
            if (value > 0) o.prices.push(value / sold);
            o.days.add(day);
        }
    }
    if (hours < LEVEL_MIN_HOURS) return null;
    const levels = new Map();
    const salePrices = new Map();
    for (const [item, units] of near) {
        const o = perItem.get(item);
        levels.set(item, o ? levelFor(o.hourly, o.days.size, hours, dayKeys.size, units) : LEVEL.none);
        if (o && o.prices.length) {
            const prices = [...o.prices].sort((a, b) => a - b);
            salePrices.set(item, Math.round(prices[Math.floor(prices.length / 2)]));
        }
    }
    return { levels, salePrices, hours };
}

// One item's level (see sellLevels): hourly = units sold in each hour that had
// a sale, salesDays = days with a sale, hours / dayCount = compared hours and
// days in the window, nearUnits = units listed near the lowest price now.
// Shared with the offline scoring tool (tools/score-levels.js).
function levelFor(hourly, salesDays, hours, dayCount, nearUnits) {
    if (!hourly.length) return LEVEL.none;
    const sorted = [...hourly].sort((a, b) => a - b);
    const cap = Math.max(sorted[Math.floor(sorted.length / 2)] * SPIKE_CAP, 1);
    const perDay = hourly.reduce((s, x) => s + Math.min(x, cap), 0) / (hours / 24);
    const hourShare = hourly.length / hours;
    const dayShare = salesDays / dayCount;
    const supplyDays = perDay > 0 ? nearUnits / perDay : Infinity;
    if (dayShare < NONE_DAY_SHARE || perDay < NONE_PER_DAY || hourShare < NONE_HOUR_SHARE) return LEVEL.none;
    if (hourShare >= SELLS_HOUR_SHARE && supplyDays <= SELLS_SUPPLY_DAYS) return LEVEL.sells;
    return LEVEL.slow;
}

// Compact daily archive, kept far longer than the snapshots: the history for
// time-of-week patterns (when an item is cheapest or sells most), which need
// many weeks, each kept separately so we can check a pattern repeats. One file
// per UTC day, written from the hourly snapshots once the day is over (so the
// first run archives every finished day still in the snapshots):
//   archive/YYYY-MM-DD.tsv.gz
//   # hours 0:60 1:60 2: ...   hour:minutes compared (blank: sales not known)
//   item <TAB> min <TAB> market <TAB> quantity <TAB> near <TAB> sold <TAB> sold_value
// each column 24 values (UTC hours 0-23) separated by spaces: "-" = no
// snapshot or no listing that hour, "=" = same as the hour before. Two
// snapshots in one hour: the later one counts.
const ARCHIVE_COLS = [1, 2, 4, 13, 5, 6]; // snapshot columns, in archive order

function archiveDays(snapDir, archDir, now, keepDays) {
    fs.mkdirSync(archDir, { recursive: true });
    const today = new Date(now).toISOString().slice(0, 10);
    const byDay = new Map(); // day -> [snapshot file names]
    for (const f of fs.readdirSync(snapDir).sort()) {
        if (!/^\d{4}-\d\d-\d\d_\d{4}\.csv$/.test(f)) continue;
        const day = f.slice(0, 10);
        if (day >= today || fs.existsSync(path.join(archDir, `${day}.tsv.gz`))) continue;
        if (!byDay.has(day)) byDay.set(day, []);
        byDay.get(day).push(f);
    }
    const written = [];
    for (const [day, files] of byDay) {
        const items = new Map(); // item -> [column][hour]
        const minutes = Array(24).fill(null);
        for (const f of files) {
            const hour = Number(f.slice(11, 13));
            const lines = fs.readFileSync(path.join(snapDir, f), 'utf8').split(/\r?\n/);
            minutes[hour] = (lines[1] || '').split(',')[12] || '';
            for (const o of items.values()) for (const col of o) col[hour] = '-';
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i]) continue;
                const c = lines[i].split(',');
                let o = items.get(c[0]);
                if (!o) { o = ARCHIVE_COLS.map(() => Array(24).fill('-')); items.set(c[0], o); }
                ARCHIVE_COLS.forEach((k, j) => { o[j][hour] = c[k] === undefined || c[k] === '' ? '-' : c[k]; });
            }
        }
        const out = [`# hours ${minutes.map((m, h) => m === null ? null : `${h}:${m}`).filter(Boolean).join(' ')}`];
        for (const [item, cols] of [...items].sort((a, b) => a[0] - b[0])) {
            out.push(item + '\t' + cols.map(col => {
                let prev = null;
                return col.map(v => { if (v === prev && v !== '-') return '='; prev = v; return v; }).join(' ');
            }).join('\t'));
        }
        const file = path.join(archDir, `${day}.tsv.gz`);
        fs.writeFileSync(file + '.tmp', require('zlib').gzipSync(out.join('\n') + '\n', { level: 9 }));
        fs.renameSync(file + '.tmp', file);
        written.push(day);
    }
    if (keepDays > 0) {
        const keepFrom = new Date(now - keepDays * 86400000).toISOString().slice(0, 10);
        for (const f of fs.readdirSync(archDir)) {
            if (/^\d{4}-\d\d-\d\d\.tsv\.gz$/.test(f) && f.slice(0, 10) < keepFrom) fs.unlinkSync(path.join(archDir, f));
        }
    }
    return written;
}

// Reads one archive day: { minutes: [24] (null: no snapshot), items: Map(item ->
// { min, market, quantity, near, sold, soldValue }: arrays of 24, null where
// "-") }. For the pattern tools.
function readArchive(file) {
    const lines = require('zlib').gunzipSync(fs.readFileSync(file)).toString('utf8').split('\n');
    const minutes = Array(24).fill(null);
    for (const part of lines[0].replace(/^# hours ?/, '').split(' ').filter(Boolean)) {
        const [h, m] = part.split(':');
        minutes[Number(h)] = m === '' ? '' : Number(m);
    }
    const names = ['min', 'market', 'quantity', 'near', 'sold', 'soldValue'];
    const items = new Map();
    for (let i = 1; i < lines.length; i++) {
        if (!lines[i]) continue;
        const f = lines[i].split('\t');
        const o = {};
        names.forEach((name, j) => {
            let prev = null;
            o[name] = f[j + 1].split(' ').map(v => {
                if (v === '=') return prev;
                prev = v === '-' ? null : Number(v);
                return prev;
            });
        });
        items.set(Number(f[0]), o);
    }
    return { minutes, items };
}

// One hour's price as Goldsmith works it out from this data (GetBlizzardPrice):
// the lowest listing, or the market price when the lowest looks like a small
// undercut (under UNDERCUT_RATIO of market) and market isn't itself a few
// silly listings (over MARKET_TRUST_RATIO times the lowest). Same rule, so
// "today vs usual" compares like with like.
function hourPrice(min, market) {
    if (min == null) return null;
    if (market != null && min < market * UNDERCUT_RATIO && market <= min * MARKET_TRUST_RATIO) return market;
    return min;
}

// One item's line in the data file. Positions are fixed (Goldsmith reads
// entry[7]), so a missing number before one that's there is written as nil;
// missing ones at the end are left off.
function itemLine(item, values) {
    let last = values.length - 1;
    const missing = (v, i) => v == null || v === false || (i >= 4 && !v); // first 4 always there
    while (last >= 0 && missing(values[last], last)) last--;
    return `[${item}]={${values.slice(0, last + 1).map((v, i) => missing(v, i) ? 'nil' : v).join(',')}},`;
}

function medianOf(sorted) {
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// Usual prices from the last USUAL_DAYS finished days of the archive: each
// day's price is the median of its hourly prices (hourPrice), and the usual
// price is the median of those days, like Goldsmith's own history (one price
// a day, median of the days). Only items with a price on USUAL_MIN_DAYS or
// more of those days. Returns Map(item -> copper), empty without an archive.
function usualPrices(archDir, now) {
    const today = new Date(now).toISOString().slice(0, 10);
    const files = fs.existsSync(archDir)
        ? fs.readdirSync(archDir).filter(f => /^\d{4}-\d\d-\d\d\.tsv\.gz$/.test(f) && f.slice(0, 10) < today).sort().slice(-USUAL_DAYS)
        : [];
    const daily = new Map(); // item -> [day prices]
    for (const f of files) {
        for (const [item, o] of readArchive(path.join(archDir, f)).items) {
            const hours = [];
            for (let h = 0; h < 24; h++) {
                const p = hourPrice(o.min[h], o.market[h]);
                if (p != null && p > 0) hours.push(p);
            }
            if (!hours.length) continue;
            let list = daily.get(item);
            if (!list) { list = []; daily.set(item, list); }
            list.push(medianOf(hours.sort((a, b) => a - b)));
        }
    }
    const usual = new Map();
    for (const [item, days] of daily) {
        if (days.length >= USUAL_MIN_DAYS) usual.set(item, Math.round(medianOf(days.sort((a, b) => a - b))));
    }
    return usual;
}

async function fetchRegion(region, opts, token) {
    const stateDir = path.join(opts.state, region);
    const snapDir = path.join(stateDir, 'snapshots');
    const stateFile = path.join(stateDir, 'last-modified.txt');
    const listFile = path.join(stateDir, 'listings.tsv'); // the previous hour's listings
    const outFile = path.join(opts.out, `Data_${region.toUpperCase()}.lua`);
    fs.mkdirSync(snapDir, { recursive: true });
    const log = msg => {
        const line = `${stamp(new Date())}  ${region.toUpperCase()}  ${msg}`;
        fs.appendFileSync(path.join(stateDir, 'fetch.log'), line + '\n');
        console.log(line);
    };

    // 1. Region-wide commodities (tens of MB, updated about hourly)
    let json, lastModified;
    if (opts.fromFile) {
        json = fs.readFileSync(opts.fromFile, 'utf8');
        lastModified = fs.statSync(opts.fromFile).mtime.toUTCString();
    } else {
        const uri = `https://${region}.api.blizzard.com/data/wow/auctions/commodities?namespace=dynamic-${region}&locale=en_US`;
        const res = await fetch(uri, { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`Commodities: HTTP ${res.status}`);
        lastModified = res.headers.get('last-modified');
        if (!opts.force && fs.existsSync(stateFile) && fs.readFileSync(stateFile, 'utf8').trim() === lastModified) {
            log(`No new data (Last-Modified ${lastModified})`);
            return;
        }
        json = await res.text();
    }

    // 2. Per item: price -> units at that price. Per listing: auction ID ->
    //    [item, quantity, price, time left 1-4]. Maps keep insertion order, which
    //    the repost matching below depends on (as the PowerShell version did).
    const auctions = JSON.parse(json).auctions || [];
    json = null;
    const items = new Map();
    const listings = new Map();
    let count = 0;
    for (const a of auctions) {
        if (!a || !a.item || a.unit_price == null || TIME_LEFT[a.time_left] == null) continue;
        const item = a.item.id, qty = a.quantity, price = a.unit_price;
        let book = items.get(item);
        if (!book) { book = new Map(); items.set(item, book); }
        book.set(price, (book.get(price) || 0) + qty);
        listings.set(a.id, [item, qty, price, TIME_LEFT[a.time_left]]);
        count++;
    }
    if (count === 0) throw new Error('No auctions found in the response (format changed?)');

    // 3. What sold since the previous hour. Commodity buyers can't pick a listing:
    //    each purchase fills from the cheapest listings up. So, per item:
    //    - a listing still there with fewer units was partly bought (the surest sign)
    //    - the cheapest listing that's still there untouched is a ceiling: nothing
    //      above it was bought, so listings above it that went were cancelled
    //    - one that went with under 30 minutes left (SHORT) most likely expired
    //    - one that went while a new listing of the same quantity appeared at the
    //      same price or lower was most likely cancelled and reposted (undercutting)
    //    - anything else that went below the ceiling is counted as sold
    //    Listings posted and bought within the same hour are never seen, so sold
    //    is a floor. Per item: [sold units, sold value (copper, BigInt), of which
    //    partial, expired, cancelled, reposted, new units posted].
    const sales = new Map();
    const salesRow = item => {
        let row = sales.get(item);
        if (!row) { row = [0, 0n, 0, 0, 0, 0, 0]; sales.set(item, row); }
        return row;
    };
    let minutes = '';
    if (fs.existsSync(listFile)) {
        const lines = fs.readFileSync(listFile, 'utf8').split(/\r?\n/);
        const gap = (Date.parse(lastModified) - Date.parse(lines[0].substring(2))) / 60000;
        if (gap > 0 && gap <= MAX_GAP) {
            minutes = roundHalfEven(gap);
            const prev = new Map();
            for (let i = 1; i < lines.length; i++) {
                if (!lines[i]) continue;
                const f = lines[i].split('\t');
                prev.set(Number(f[0]), [Number(f[1]), Number(f[2]), Number(f[3]), Number(f[4])]);
            }

            const ceiling = new Map();
            const gone = [];
            for (const [id, p] of prev) {
                const c = listings.get(id);
                if (!c) { gone.push(p); continue; }
                if (c[1] < p[1]) {
                    const n = p[1] - c[1], row = salesRow(p[0]);
                    row[0] += n; row[1] += BigInt(n) * BigInt(p[2]); row[2] += n;
                } else if (!ceiling.has(p[0]) || p[2] < ceiling.get(p[0])) {
                    ceiling.set(p[0], p[2]);
                }
            }

            // New listings, by item and quantity, for spotting reposts
            const posted = new Map();
            for (const [id, c] of listings) {
                if (prev.has(id)) continue;
                salesRow(c[0])[6] += c[1];
                const key = `${c[0]}:${c[1]}`;
                let list = posted.get(key);
                if (!list) { list = []; posted.set(key, list); }
                list.push(c[2]);
            }

            for (const p of gone) {
                const n = p[1], row = salesRow(p[0]);
                if (p[3] === 1) { row[3] += n; continue; }
                if (ceiling.has(p[0]) && p[2] > ceiling.get(p[0])) { row[4] += n; continue; }
                const list = posted.get(`${p[0]}:${n}`);
                if (list) {
                    const at = list.findIndex(price => price <= p[2]);
                    if (at >= 0) { list.splice(at, 1); row[5] += n; continue; }
                }
                row[0] += n; row[1] += BigInt(n) * BigInt(p[2]);
            }
        }
    }

    // 4. Stats per item (copper): lowest price, median by quantity, and the
    //    quantity-weighted average of the cheapest 15% of units ("market"), plus
    //    units listed.
    const now = Math.floor(Date.now() / 1000);
    //    Snapshot columns after quantity: see step 3 (blank when there was
    //    nothing to compare with); minutes = time since the listings compared
    //    with; near = units listed within NEAR_MIN of the lowest price.
    const csv = ['item,min,market,median,quantity,sold,sold_value,partial,expired,cancelled,reposted,posted,minutes,near'];
    const stats = []; // [item, min, market, median, quantity]
    const near = new Map();
    const ids = [...items.keys()].sort((a, b) => a - b);
    for (const item of ids) {
        const prices = [...items.get(item).entries()].sort((a, b) => a[0] - b[0]);
        let total = 0;
        for (const [, units] of prices) total += units;
        const cut = Math.max(1, Math.ceil(total * 0.15));
        const half = Math.ceil(total / 2);
        let seen = 0, sum = 0, taken = 0, median = null, min = null;
        for (const [price, units] of prices) {
            if (min === null) min = price;
            if (taken < cut) {
                const n = Math.min(units, cut - taken);
                sum += n * price; taken += n;
            }
            seen += units;
            if (median === null && seen >= half) { median = price; if (taken >= cut) break; }
        }
        const market = roundHalfEven(sum / taken);
        let nearUnits = 0;
        for (const [price, units] of prices) {
            if (price > min * NEAR_MIN) break;
            nearUnits += units;
        }
        near.set(item, nearUnits);
        stats.push([item, min, market, median, total]);
        const row = sales.get(item);
        const diff = row ? row.join(',') : (minutes !== '' ? '0,0,0,0,0,0,0' : ',,,,,,');
        csv.push(`${item},${min},${market},${median},${total},${diff},${minutes},${nearUnits}`);
    }
    //    Items with no listings left this hour (sold out, or cancelled)
    const goneItems = [...sales.keys()].filter(item => !items.has(item)).sort((a, b) => a - b);
    for (const item of goneItems) csv.push(`${item},,,,0,${sales.get(item).join(',')},${minutes},0`);

    // Hourly snapshots for price and sales history (written before the data
    // file: the sell levels include this hour); drop old ones
    const d = new Date();
    const snapName = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.csv`;
    fs.writeFileSync(path.join(snapDir, snapName), csv.join('\n') + '\n');
    const cutoff = Date.now() - opts.keepDays * 86400000;
    for (const f of fs.readdirSync(snapDir)) {
        const file = path.join(snapDir, f);
        if (f.endsWith('.csv') && fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }
    //    Finished days into the long-term archive (a failure here mustn't
    //    stop the data file)
    let archived = [];
    try {
        archived = archiveDays(snapDir, path.join(stateDir, 'archive'), Date.now(), opts.keepArchiveDays);
    } catch (e) {
        log(`Archive failed: ${e.message}`);
    }

    // 5. The data file. Levels only once there's enough history (sellLevels)
    const sell = sellLevels(snapDir, near, Date.now());
    let usual = new Map();
    try {
        usual = usualPrices(path.join(stateDir, 'archive'), Date.now());
    } catch (e) {
        log(`Usual prices failed: ${e.message}`);
    }
    const lua = [
        '-- Generated by tools/fetch.js (Goldsmith Data). Do not edit.',
        '-- items[itemID] = { min, market, median, quantity, sells, sold, usual }  (copper)',
        '-- sells: 3 sells, 2 slow, 1 hardly sells (last 7 days of hourly listings;',
        '-- left out until there are 3 days of them). sold: what it sold for, the',
        '-- median of hourly average sale prices over those days (with sells only).',
        '-- usual: the median of the last 7 days\' daily prices (with 5+ days only).',
        '-- levelHours = hours they used.',
        '-- Only the region you play in is loaded; the others return here.',
        `if (GetCurrentRegion and GetCurrentRegion()) ~= ${REGION_IDS[region]} then return end`,
        `GoldsmithPriceData = { region = "${region}", updated = ${now}${sell ? `, levelHours = ${sell.hours}` : ''}, items = {`,
    ];
    for (const [item, min, market, median, total] of stats) {
        const level = sell && sell.levels.get(item);
        const sold = level && sell.salePrices.get(item);
        lua.push(itemLine(item, [min, market, median, total, level, sold, usual.get(item)]));
    }
    lua.push('} }');
    //    Written to a temp file, checked, then swapped in so WoW never loads
    //    half a file
    const tmp = outFile + '.tmp';
    fs.writeFileSync(tmp, lua.join('\n') + '\n');
    luacCheck(tmp);
    fs.renameSync(tmp, outFile);

    // This hour's listings, for the next run to compare with. First line: "# <Last-Modified>"
    const tsv = [`# ${lastModified}`];
    for (const [id, c] of listings) tsv.push(`${id}\t${c[0]}\t${c[1]}\t${c[2]}\t${c[3]}`);
    writeAtomic(listFile, tsv.join('\n') + '\n');

    // Raw listings history, for trying other sales rules offline
    const keepHours = opts.keepListings[region];
    if (keepHours > 0) {
        const histDir = path.join(stateDir, 'listings-history');
        fs.mkdirSync(histDir, { recursive: true });
        const name = snapName.replace(/\.csv$/, '.tsv.gz');
        fs.writeFileSync(path.join(histDir, name), require('zlib').gzipSync(tsv.join('\n') + '\n'));
        const keepFrom = Date.now() - keepHours * 3600000;
        for (const f of fs.readdirSync(histDir)) {
            const file = path.join(histDir, f);
            if (fs.statSync(file).mtimeMs < keepFrom) fs.unlinkSync(file);
        }
    }

    fs.writeFileSync(stateFile, lastModified + '\n');
    let sold = 0;
    for (const row of sales.values()) sold += row[0];
    const compared = minutes !== '' ? `, ${sold} units sold over ${minutes} min` : ', no listings to compare with';
    let levels = ', no sell levels yet (under 3 days of history)';
    if (sell) {
        const n = [0, 0, 0, 0];
        for (const level of sell.levels.values()) n[level]++;
        levels = `, levels from ${sell.hours} h: ${n[3]} sell, ${n[2]} slow, ${n[1]} hardly`;
    }
    const arch = archived.length ? `, archived ${archived.join(', ')}` : '';
    log(`OK: ${count} auctions, ${items.size} items -> ${path.basename(outFile)} (Last-Modified ${lastModified})${compared}${levels}, ${usual.size} usual prices${arch}`);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    fs.mkdirSync(opts.out, { recursive: true });
    const token = opts.fromFile ? null : await getToken();
    let failed = 0;
    // One region failing (an API hiccup) doesn't stop the others
    for (const region of opts.regions) {
        try {
            await fetchRegion(region, opts, token);
        } catch (e) {
            failed++;
            console.error(`${stamp(new Date())}  ${region.toUpperCase()}  FAILED: ${e.message}`);
        }
    }
    process.exitCode = failed > 0 ? 1 : 0;
}

if (require.main === module) {
    main().catch(e => { console.error(`FAILED: ${e.message}`); process.exitCode = 1; });
}

module.exports = { roundHalfEven, sellLevels, levelFor, archiveDays, readArchive, hourPrice, usualPrices, itemLine, LEVEL, LEVEL_DAYS, LEVEL_MIN_HOURS, MAX_GAP };
