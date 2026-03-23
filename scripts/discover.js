#!/usr/bin/env node
'use strict';

/**
 * Discover Claude Code plugins via GitHub Code Search.
 * Searches for `filename:marketplace.json path:.claude-plugin`, deduplicates by repo,
 * fetches star counts, and writes discovered.json.
 *
 * Two modes set via CRAWL_MODE env var:
 *   full        — Sunday: processes all repos, rewrites discovered.json + known-repos.json,
 *                 spreads API calls evenly across 2 hours to avoid rate-limit spikes.
 *   incremental — Wednesday: skips repos already in known-repos.json, merges new findings
 *                 into existing discovered.json. Only new repos get API calls.
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

// Full run spreads API calls across this window to avoid rate-limit spikes
const TARGET_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

console.log(`Crawl mode: ${CRAWL_MODE.toUpperCase()}`);

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
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
        process.exit(0); // Don't overwrite existing file
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

async function fetchRepoDetails(owner, repo) {
  // 1. marketplace.json contents
  const contentsData = await githubGet(
    `repos/${owner}/${repo}/contents/.claude-plugin/marketplace.json`
  );
  await sleep(500);
  if (!contentsData?.content) return null;

  let marketplace;
  try {
    marketplace = JSON.parse(Buffer.from(contentsData.content, 'base64').toString('utf8'));
  } catch { return null; }

  // 2. Last commit date for marketplace.json
  const commits = await githubGet(
    `repos/${owner}/${repo}/commits?path=.claude-plugin/marketplace.json&per_page=1`
  );
  await sleep(500);
  const lastMarketplaceCommit = commits?.[0]?.commit?.committer?.date ?? null;

  // 3. Repo metadata — stars + creation date
  const repoData = await githubGet(`repos/${owner}/${repo}`);
  await sleep(500);
  const stars         = repoData?.stargazers_count ?? 0;
  const repoCreatedAt = repoData?.created_at ?? null;

  return { marketplace, lastMarketplaceCommit, stars, repoCreatedAt };
}

async function main() {
  console.log('Searching GitHub for .claude-plugin/marketplace.json files…');
  const allRepos = await searchCodePages();
  console.log(`Found ${allRepos.size} unique repos in code search`);

  if (allRepos.size === 0) {
    console.error('No repos found — aborting without overwriting existing file');
    process.exit(0);
  }

  // Load known-repos for incremental filtering
  const knownRepos = new Set(safeReadJson(KNOWN_FILE) ?? []);
  console.log(`Known repos from previous runs: ${knownRepos.size}`);

  const toProcess = IS_FULL
    ? allRepos
    : new Map([...allRepos].filter(([fn]) => !knownRepos.has(fn)));

  console.log(`Repos to process this run: ${toProcess.size}`);

  if (toProcess.size === 0) {
    console.log('No new repos — nothing to update.');
    process.exit(0);
  }

  // Compute inter-repo sleep so full run spreads over TARGET_DURATION_MS.
  // Each repo costs 3 x 500ms = 1,500ms in API calls; we pad the remainder.
  const API_MS_PER_REPO = 3 * 500;
  const interRepoSleep = IS_FULL
    ? Math.max(0, Math.floor((TARGET_DURATION_MS - toProcess.size * API_MS_PER_REPO) / toProcess.size))
    : 0;

  if (IS_FULL) {
    const estMin = Math.round(toProcess.size * (API_MS_PER_REPO + interRepoSleep) / 60_000);
    console.log(`Inter-repo sleep: ${interRepoSleep}ms → estimated ~${estMin} min total`);
  }

  const newPlugins = [];
  const newKnown   = new Set(knownRepos);
  let processed = 0;

  for (const [fullName, { owner, repo }] of toProcess) {
    processed++;
    try {
      console.log(`  [${processed}/${toProcess.size}] ${fullName}…`);
      const details = await fetchRepoDetails(owner, repo);
      if (!details) { console.log(`    skip — could not fetch details`); continue; }

      const { marketplace, lastMarketplaceCommit, stars, repoCreatedAt } = details;

      // Discard zero-star repos (test/abandoned)
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
          keywords:             p.keywords ?? [],
        });
      }

      newKnown.add(fullName);

      // Spread full run across TARGET_DURATION_MS
      if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);

    } catch (err) {
      console.warn(`  Error processing ${fullName}: ${err.message}`);
    }
  }

  // Full: replace entirely. Incremental: merge new findings into existing data.
  // Strip any entries from processed repos first (handles retries / re-indexing).
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
  fs.writeFileSync(KNOWN_FILE, JSON.stringify([...newKnown], null, 2), 'utf8');

  console.log(`\nWrote ${finalPlugins.length} plugins to discovered.json`);
  console.log(`Wrote ${newKnown.size} entries to known-repos.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
