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

function parseArgs(argv) {
    const opts = { regions: Object.keys(REGION_IDS), out: path.join(__dirname, '..'),
        state: path.join(process.cwd(), 'state'), force: false, fromFile: null, keepDays: 14, keepListings: {} };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--regions') opts.regions = argv[++i].split(',').map(s => s.trim().toLowerCase());
        else if (a === '--out') opts.out = argv[++i];
        else if (a === '--state') opts.state = argv[++i];
        else if (a === '--force') opts.force = true;
        else if (a === '--from-file') opts.fromFile = argv[++i];
        else if (a === '--keep-days') opts.keepDays = Number(argv[++i]);
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
    const lua = [
        '-- Generated by tools/fetch.js (Goldsmith Data). Do not edit.',
        '-- items[itemID] = { min, market, median, quantity }  (copper)',
        '-- Only the region you play in is loaded; the others return here.',
        `if (GetCurrentRegion and GetCurrentRegion()) ~= ${REGION_IDS[region]} then return end`,
        `GoldsmithPriceData = { region = "${region}", updated = ${now}, items = {`,
    ];
    //    Snapshot columns after quantity: see step 3 (blank when there was
    //    nothing to compare with); minutes = time since the listings compared with.
    const csv = ['item,min,market,median,quantity,sold,sold_value,partial,expired,cancelled,reposted,posted,minutes'];
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
        lua.push(`[${item}]={${min},${market},${median},${total}},`);
        const row = sales.get(item);
        const diff = row ? row.join(',') : (minutes !== '' ? '0,0,0,0,0,0,0' : ',,,,,,');
        csv.push(`${item},${min},${market},${median},${total},${diff},${minutes}`);
    }
    //    Items with no listings left this hour (sold out, or cancelled)
    const goneItems = [...sales.keys()].filter(item => !items.has(item)).sort((a, b) => a - b);
    for (const item of goneItems) csv.push(`${item},,,,0,${sales.get(item).join(',')},${minutes}`);
    lua.push('} }');

    // 5. Write to a temp file, check it, then swap it in so WoW never loads half a file
    const tmp = outFile + '.tmp';
    fs.writeFileSync(tmp, lua.join('\n') + '\n');
    luacCheck(tmp);
    fs.renameSync(tmp, outFile);

    // Hourly snapshots for price and sales history; drop old ones
    const d = new Date();
    const snapName = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}.csv`;
    fs.writeFileSync(path.join(snapDir, snapName), csv.join('\n') + '\n');
    const cutoff = Date.now() - opts.keepDays * 86400000;
    for (const f of fs.readdirSync(snapDir)) {
        const file = path.join(snapDir, f);
        if (f.endsWith('.csv') && fs.statSync(file).mtimeMs < cutoff) fs.unlinkSync(file);
    }

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
    log(`OK: ${count} auctions, ${items.size} items -> ${path.basename(outFile)} (Last-Modified ${lastModified})${compared}`);
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

module.exports = { roundHalfEven };
