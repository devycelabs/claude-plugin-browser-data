#!/usr/bin/env node
'use strict';

/**
 * Discover Claude Code plugins via GitHub Code Search.
 * Searches for `filename:marketplace.json path:.claude-plugin`, deduplicates by repo,
 * fetches star counts, and writes discovered.json.
 *
 * Two modes set via CRAWL_MODE env var:
 *   full        — Sunday: checks every repo found in code search. Skips re-fetching repos
 *                 whose GitHub updated_at hasn't changed since last scan (saves 2 API calls
 *                 per unchanged repo). Spreads remaining calls over ~2 hours.
 *   incremental — Wednesday: only processes repos not yet in known-repos.json. Merges new
 *                 findings into existing discovered.json.
 *
 * known-repos.json format — map, not array:
 *   { "owner/repo": { "lastScannedAt": "<ISO>", "repoUpdatedAt": "<ISO>" } }
 *
 * Run by .github/workflows/discover-plugins.yml (authenticated: 5,000 req/hr).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN       = process.env.GITHUB_TOKEN;
const CRAWL_MODE  = (process.env.CRAWL_MODE || 'full').toLowerCase();
const IS_FULL     = CRAWL_MODE !== 'incremental';
const OUT_FILE    = path.join(__dirname, '..', 'discovered.json');
const KNOWN_FILE  = path.join(__dirname, '..', 'known-repos.json');

const TARGET_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours (full run spread)

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

console.log(`Crawl mode: ${CRAWL_MODE.toUpperCase()}`);

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

/**
 * Load known-repos.json as a map.
 * Handles one-time migration from old flat-array format.
 */
function loadKnownRepos() {
  const data = safeReadJson(KNOWN_FILE);
  if (!data) return {};
  if (Array.isArray(data)) {
    console.log(`Migrating known-repos.json from array (${data.length}) to map format`);
    return Object.fromEntries(data.map(name => [name, {}]));
  }
  return data;
}

function githubGet(apiPath, accept = 'application/vnd.github.v3+json') {
  return new Promise((resolve) => {
    const req = https.get({
      hostname: 'api.github.com',
      path: '/' + apiPath,
      headers: {
        'User-Agent':    'claude-scout/1.5',
        'Accept':        accept,
        'Authorization': `Bearer ${TOKEN}`,
      },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } else {
            console.warn(`  HTTP ${res.statusCode} for /${apiPath}`);
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// ── Search ────────────────────────────────────────────────────

async function searchCodePages() {
  const repos = new Map(); // full_name → { owner, repo }
  const perPage = 100;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page++) {
    const q = encodeURIComponent('filename:marketplace.json path:.claude-plugin');
    const data = await githubGet(
      `search/code?q=${q}&per_page=${perPage}&page=${page}`,
      'application/vnd.github.v3+json'
    );
    await sleep(500);

    if (!data?.items?.length) {
      if (page === 1 && !data) {
        console.error('Code search returned no data — possible API outage, aborting');
        process.exit(0);
      }
      break;
    }

    for (const item of data.items) {
      const fn = item.repository.full_name;
      if (!repos.has(fn)) {
        repos.set(fn, {
          owner: item.repository.owner.login,
          repo:  item.repository.name,
        });
      }
    }

    if (data.items.length < perPage) break;
  }

  return repos;
}

// ── Fetchers ──────────────────────────────────────────────────

/**
 * Fetch repo metadata: stars, created_at, updated_at.
 * Always called first — used for change detection before committing to 2 more calls.
 */
async function fetchRepoMeta(owner, repo) {
  const data = await githubGet(`repos/${owner}/${repo}`);
  await sleep(500);
  if (!data) return null;
  return {
    stars:          data.stargazers_count ?? 0,
    repoCreatedAt:  data.created_at ?? null,
    repoUpdatedAt:  data.updated_at ?? null,
  };
}

/**
 * Fetch marketplace.json content + last commit date.
 * Only called when repo metadata has changed since last scan.
 */
async function fetchMarketplaceDetails(owner, repo) {
  const contentsData = await githubGet(
    `repos/${owner}/${repo}/contents/.claude-plugin/marketplace.json`
  );
  await sleep(500);
  if (!contentsData?.content) return null;

  let marketplace;
  try {
    marketplace = JSON.parse(Buffer.from(contentsData.content, 'base64').toString('utf8'));
  } catch { return null; }

  const commits = await githubGet(
    `repos/${owner}/${repo}/commits?path=.claude-plugin/marketplace.json&per_page=1`
  );
  await sleep(500);
  const lastMarketplaceCommit = commits?.[0]?.commit?.committer?.date ?? null;

  return { marketplace, lastMarketplaceCommit };
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  console.log('Searching GitHub for .claude-plugin/marketplace.json files…');
  const allRepos = await searchCodePages();
  console.log(`Found ${allRepos.size} unique repos in code search`);

  if (allRepos.size === 0) {
    console.error('No repos found — aborting without overwriting existing file');
    process.exit(0);
  }

  const knownRepos = loadKnownRepos();
  console.log(`Known repos from previous runs: ${Object.keys(knownRepos).length}`);

  // Build lookup of existing plugin entries by repo for reuse when unchanged
  const existingByRepo = new Map();
  for (const p of (safeReadJson(OUT_FILE)?.plugins ?? [])) {
    if (!existingByRepo.has(p.repo)) existingByRepo.set(p.repo, []);
    existingByRepo.get(p.repo).push(p);
  }

  // Incremental: only new repos; full: everything (but may skip unchanged via change-detection)
  const toProcess = IS_FULL
    ? allRepos
    : new Map([...allRepos].filter(([fn]) => !(fn in knownRepos)));

  console.log(`Repos to process this run: ${toProcess.size}`);

  if (toProcess.size === 0) {
    console.log('No new repos — nothing to update.');
    process.exit(0);
  }

  // Full run: spread based on 1 metadata call per repo (minimum cost).
  // Changed repos cost 2 more calls but we can't predict how many upfront.
  const interRepoSleep = IS_FULL
    ? Math.max(0, Math.floor((TARGET_DURATION_MS - toProcess.size * 500) / toProcess.size))
    : 0;

  if (IS_FULL) {
    const estMin = Math.round(toProcess.size * (500 + interRepoSleep) / 60_000);
    console.log(`Inter-repo sleep: ${interRepoSleep}ms → estimated ≤${estMin} min (less for unchanged repos)`);
  }

  const scanTime   = new Date().toISOString();
  const newPlugins = [];
  const updatedKnown = { ...knownRepos };
  let processed = 0, fetched = 0, reused = 0;

  for (const [fullName, { owner, repo }] of toProcess) {
    processed++;
    try {
      console.log(`  [${processed}/${toProcess.size}] ${fullName}…`);

      // Step 1: always fetch repo metadata (1 call) for change detection
      const meta = await fetchRepoMeta(owner, repo);
      if (!meta) { console.log(`    skip — metadata fetch failed`); continue; }

      const known      = knownRepos[fullName];
      const hasChanged = !known?.repoUpdatedAt || meta.repoUpdatedAt !== known.repoUpdatedAt;

      // Step 2: if unchanged and we have existing entries, reuse them
      if (!hasChanged && existingByRepo.has(fullName)) {
        const existing = existingByRepo.get(fullName);
        // Carry forward with refreshed repoUpdatedAt (in case field was absent before)
        for (const e of existing) newPlugins.push({ ...e, repoUpdatedAt: meta.repoUpdatedAt });
        updatedKnown[fullName] = { lastScannedAt: scanTime, repoUpdatedAt: meta.repoUpdatedAt };
        console.log(`    unchanged — reused ${existing.length} entr${existing.length === 1 ? 'y' : 'ies'} (saved 2 API calls)`);
        reused++;
        if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);
        continue;
      }

      // Step 3: changed or new — fetch marketplace details (2 more calls)
      const mktDetails = await fetchMarketplaceDetails(owner, repo);
      if (!mktDetails) { console.log(`    skip — could not fetch marketplace details`); continue; }

      const { marketplace, lastMarketplaceCommit } = mktDetails;
      const { stars, repoCreatedAt, repoUpdatedAt } = meta;

      if (stars < 1) { console.log(`    skip — 0 stars`); continue; }

      const tier = stars >= 5 ? 'established' : 'new';
      const mktPlugins = marketplace.plugins ?? (Array.isArray(marketplace) ? marketplace : [marketplace]);

      for (const p of mktPlugins) {
        if (!p?.name) continue;
        newPlugins.push({
          name:                 p.name,
          desc:                 p.description || p.desc || '',
          author:               p.author?.name || p.author || owner,
          repo:                 fullName,
          repoUrl:              `https://github.com/${fullName}`,
          stars,
          tier,
          lastMarketplaceCommit,
          repoCreatedAt,
          repoUpdatedAt,
          keywords:             p.keywords ?? [],
        });
      }

      updatedKnown[fullName] = { lastScannedAt: scanTime, repoUpdatedAt };
      fetched++;

      if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);

    } catch (err) {
      console.warn(`  Error processing ${fullName}: ${err.message}`);
    }
  }

  // Full run: remove stale known-repo entries for repos no longer in code search
  if (IS_FULL) {
    const before = Object.keys(updatedKnown).length;
    for (const fn of Object.keys(updatedKnown)) {
      if (!allRepos.has(fn)) delete updatedKnown[fn];
    }
    const removed = before - Object.keys(updatedKnown).length;
    if (removed > 0) console.log(`Pruned ${removed} stale entr${removed === 1 ? 'y' : 'ies'} from known-repos`);
  }

  console.log(`\nSummary: ${fetched} full fetch · ${reused} unchanged (saved ~${reused * 2} API calls)`);

  // Full: replace entirely. Incremental: merge new into existing.
  let finalPlugins;
  if (IS_FULL) {
    finalPlugins = newPlugins;
  } else {
    const processedRepos = new Set([...toProcess.keys()]);
    const existing = (safeReadJson(OUT_FILE)?.plugins ?? [])
      .filter(p => !processedRepos.has(p.repo));
    finalPlugins = [...existing, ...newPlugins];
    console.log(`Merged: ${existing.length} existing + ${newPlugins.length} new = ${finalPlugins.length} total`);
  }

  const out = {
    generatedAt:  new Date().toISOString(),
    pluginCount:  finalPlugins.length,
    plugins:      finalPlugins,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE,   JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(KNOWN_FILE, JSON.stringify(updatedKnown, null, 2), 'utf8');

  console.log(`Wrote ${finalPlugins.length} plugins to discovered.json`);
  console.log(`Wrote ${Object.keys(updatedKnown).length} entries to known-repos.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
