#!/usr/bin/env node
// Goldsmith Data: packages the region files written by fetch.js and uploads
// a new version to CurseForge. Run by the hourly workflow after fetching; it
// only releases when the last release is MIN_HOURS old or more, so one
// release a day goes out even when GitHub skips or delays a scheduled run.
//
//   CF_API_TOKEN=... CF_PROJECT_ID=... node tools/release.js --data state/data --state state
//
// Options:
//   --data DIR       where the Data_<REGION>.lua files are
//   --state DIR      where last-release.txt is kept
//   --min-hours N    hours between releases (default 20)
//   --force          release now whatever the last release time
//   --dry-run        build the zip in dist/ but don't upload
'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const NAME = 'GoldsmithData';
const REGIONS = ['US', 'EU', 'KR', 'TW'];
const STALE_HOURS = 24; // a region file older than this is called out in the changelog
const API = 'https://wow.curseforge.com/api';

function parseArgs(argv) {
    const opts = { data: ROOT, state: path.join(process.cwd(), 'state'), minHours: 20, force: false, dryRun: false };
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];
        if (a === '--data') opts.data = argv[++i];
        else if (a === '--state') opts.state = argv[++i];
        else if (a === '--min-hours') opts.minHours = Number(argv[++i]);
        else if (a === '--force') opts.force = true;
        else if (a === '--dry-run') opts.dryRun = true;
        else throw new Error(`Unknown option ${a}`);
    }
    return opts;
}

function pad(n) { return String(n).padStart(2, '0'); }

// "updated = 1791324543" from a region file
function updatedAt(file) {
    const head = fs.readFileSync(file, 'utf8').slice(0, 1000);
    const m = head.match(/updated = (\d+)/);
    return m ? Number(m[1]) * 1000 : null;
}

// ## Interface: 120100 -> "12.1.0"
function gameVersionName(toc) {
    const m = toc.match(/^## Interface:\s*(\d+)/m);
    if (!m) throw new Error('No ## Interface line in the TOC');
    const n = Number(m[1]);
    return `${Math.floor(n / 10000)}.${Math.floor(n / 100) % 100}.${n % 100}`;
}

async function api(pathname, token, init = {}) {
    const res = await fetch(API + pathname, { ...init, headers: { 'X-Api-Token': token, ...(init.headers || {}) } });
    const text = await res.text();
    if (!res.ok) throw new Error(`CurseForge ${pathname}: HTTP ${res.status} ${text.slice(0, 300)}`);
    return text ? JSON.parse(text) : null;
}

// The CurseForge game version ID for the TOC's interface, on retail
async function gameVersionIds(token, wanted) {
    const [types, versions] = await Promise.all([api('/game/version-types', token), api('/game/versions', token)]);
    const retail = new Set(types.filter(t => /retail/i.test(t.slug || '') || /retail/i.test(t.name || '')).map(t => t.id));
    let matches = versions.filter(v => v.name === wanted && (retail.size === 0 || retail.has(v.gameVersionTypeID)));
    if (matches.length === 0) matches = versions.filter(v => v.name === wanted);
    if (matches.length === 0) {
        throw new Error(`CurseForge has no game version "${wanted}" yet; newest: `
            + versions.slice(-5).map(v => v.name).join(', '));
    }
    return matches.map(v => v.id);
}

async function main() {
    const opts = parseArgs(process.argv.slice(2));
    fs.mkdirSync(opts.state, { recursive: true });
    const lastFile = path.join(opts.state, 'last-release.txt');
    const last = fs.existsSync(lastFile) ? Number(fs.readFileSync(lastFile, 'utf8').trim()) : 0;
    const hoursSince = (Date.now() - last) / 3600000;
    if (!opts.force && hoursSince < opts.minHours) {
        console.log(`Not due: last release ${hoursSince.toFixed(1)} hours ago (every ${opts.minHours}).`);
        return;
    }

    // Region files, and how fresh each is
    const files = [], notes = [];
    for (const region of REGIONS) {
        const file = path.join(opts.data, `Data_${region}.lua`);
        if (!fs.existsSync(file)) { notes.push(`${region}: no data this time`); continue; }
        files.push(file);
        const at = updatedAt(file);
        const hours = at ? (Date.now() - at) / 3600000 : Infinity;
        if (hours > STALE_HOURS) notes.push(`${region}: data is ${Math.round(hours)} hours old`);
    }
    if (files.length === 0) throw new Error(`No Data_*.lua files in ${opts.data}`);

    // dist/GoldsmithData/: the TOC with the version filled in, the logo, and the data
    const d = new Date();
    const version = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}.${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}`;
    const dist = path.join(ROOT, 'dist');
    const pkg = path.join(dist, NAME);
    fs.rmSync(dist, { recursive: true, force: true });
    fs.mkdirSync(pkg, { recursive: true });
    const toc = fs.readFileSync(path.join(ROOT, `${NAME}.toc`), 'utf8').replace('@version@', version);
    fs.writeFileSync(path.join(pkg, `${NAME}.toc`), toc);
    fs.mkdirSync(path.join(pkg, 'Media'));
    fs.copyFileSync(path.join(ROOT, 'Media', 'Logo.tga'), path.join(pkg, 'Media', 'Logo.tga'));
    for (const file of files) fs.copyFileSync(file, path.join(pkg, path.basename(file)));
    const zip = path.join(dist, `${NAME}-${version}.zip`);
    execFileSync('zip', ['-rq', path.basename(zip), NAME], { cwd: dist });
    const regions = files.map(f => path.basename(f).match(/Data_(\w+)\.lua/)[1]).join(', ');
    const changelog = `Auction house prices for ${regions}, as of ${d.toISOString().slice(0, 16).replace('T', ' ')} UTC.`
        + (notes.length ? `\n${notes.join('\n')}` : '');
    console.log(`Built ${path.basename(zip)} (${(fs.statSync(zip).size / 1024).toFixed(0)} KB): ${changelog}`);
    if (opts.dryRun) return;

    const token = process.env.CF_API_TOKEN, projectId = process.env.CF_PROJECT_ID;
    if (!token || !projectId) {
        // Before CurseForge is set up: not an error, so hourly runs don't fail
        console.log('::notice::CurseForge isn\'t set up yet (CF_API_TOKEN, CF_PROJECT_ID): built but not uploaded.');
        return;
    }
    const metadata = {
        changelog, changelogType: 'text', displayName: `Goldsmith Data ${version}`,
        gameVersions: await gameVersionIds(token, gameVersionName(toc)), releaseType: 'release',
    };
    const form = new FormData();
    form.append('metadata', JSON.stringify(metadata));
    form.append('file', new Blob([fs.readFileSync(zip)], { type: 'application/zip' }), path.basename(zip));
    const result = await api(`/projects/${projectId}/upload-file`, token, { method: 'POST', body: form });
    fs.writeFileSync(lastFile, String(Date.now()) + '\n');
    console.log(`Uploaded to CurseForge: file ${result && result.id}, version ${version}`);
}

main().catch(e => { console.error(`FAILED: ${e.message}`); process.exitCode = 1; });
