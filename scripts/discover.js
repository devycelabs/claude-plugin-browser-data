#!/usr/bin/env node
'use strict';

/**
 * Discover Claude Code plugins and MCP tools via GitHub.
 *
 * Phase 1 — Plugins: Code Search for `filename:marketplace.json path:.claude-plugin`
 * Phase 2 — Tools:   Repo Search for `topic:mcp-server topic:claude-code`
 *
 * Both phases use change-detection via known-repos.json / known-tools.json:
 *   { "owner/repo": { "lastScannedAt": "<ISO>", "repoUpdatedAt": "<ISO>" } }
 * Repos whose updated_at hasn't changed since last scan are reused without extra API calls.
 *
 * Two modes set via CRAWL_MODE env var:
 *   full        — Sunday: checks every repo in search results, skips unchanged.
 *                 Spreads plugin API calls over ~2 hours.
 *   incremental — Wednesday: only processes repos not yet in known-repos / known-tools.
 *
 * Run by .github/workflows/discover-plugins.yml (authenticated: 5,000 req/hr).
 */

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const TOKEN            = process.env.GITHUB_TOKEN;
const CRAWL_MODE       = (process.env.CRAWL_MODE || 'full').toLowerCase();
const IS_FULL          = CRAWL_MODE !== 'incremental';
const OUT_FILE         = path.join(__dirname, '..', 'discovered.json');
const KNOWN_FILE       = path.join(__dirname, '..', 'known-repos.json');
const KNOWN_TOOLS_FILE = path.join(__dirname, '..', 'known-tools.json');

const TARGET_DURATION_MS = 2 * 60 * 60 * 1000; // 2 hours (full plugin run spread)

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
 * Load a known-repos map file. Handles migration from old flat-array format.
 */
function loadKnownMap(filePath) {
  const data = safeReadJson(filePath);
  if (!data) return {};
  if (Array.isArray(data)) {
    console.log(`Migrating ${path.basename(filePath)} from array to map format`);
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

// ── Phase 1: Plugin fetchers ──────────────────────────────────

async function searchCodePages() {
  const repos = new Map(); // full_name → { owner, repo }
  const perPage = 100;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page++) {
    const q = encodeURIComponent('filename:marketplace.json path:.claude-plugin');
    const data = await githubGet(
      `search/code?q=${q}&per_page=${perPage}&page=${page}`,
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

// ── Phase 2: Tools fetchers ───────────────────────────────────

/**
 * Search for MCP tools via GitHub repo search (topic:mcp-server + topic:claude-code).
 * Results include full repo metadata — no extra API calls needed for basic info.
 * Strip the two discovery topics from the returned topics list (not useful as filters).
 */
async function searchToolsPages(pluginRepos) {
  const tools = new Map();
  const perPage = 100;
  const maxPages = 9; // ~830 results max

  for (let page = 1; page <= maxPages; page++) {
    const q = encodeURIComponent('topic:mcp-server topic:claude-code');
    const data = await githubGet(
      `search/repositories?q=${q}&per_page=${perPage}&page=${page}&sort=stars`,
    );
    await sleep(2000); // repo search: 30 req/min, be conservative

    if (!data?.items?.length) {
      if (page === 1 && !data) { console.warn('Tools search returned no data — skipping tools phase'); break; }
      break;
    }

    for (const item of data.items) {
      const fn = item.full_name;
      if (pluginRepos.has(fn)) continue; // already captured as a plugin
      if (!tools.has(fn)) {
        tools.set(fn, {
          owner:         item.owner.login,
          name:          item.name,
          desc:          item.description || '',
          stars:         item.stargazers_count ?? 0,
          topics:        (item.topics ?? []).filter(t => t !== 'mcp-server' && t !== 'claude-code'),
          repoCreatedAt: item.created_at ?? null,
          repoUpdatedAt: item.updated_at ?? null,
        });
      }
    }

    if (data.items.length < perPage) break;
  }

  return tools;
}

/**
 * Fetch optional install hint from server.json (MCP registry format).
 * Only called for tools with ≥10 stars. Returns e.g. "npx zikkaron" or "uvx zikkaron".
 */
async function fetchToolInstallHint(owner, repo) {
  const data = await githubGet(`repos/${owner}/${repo}/contents/server.json`);
  await sleep(500);
  if (!data?.content) return null;
  try {
    const json = JSON.parse(Buffer.from(data.content, 'base64').toString('utf8'));
    const pkg = json.packages?.[0];
    if (!pkg) return null;
    if (pkg.registryType === 'npm')  return `npx ${pkg.identifier}`;
    if (pkg.registryType === 'pypi') return `uvx ${pkg.identifier}`;
    return null;
  } catch { return null; }
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  // ── Phase 1: Plugins ─────────────────────────────────────────

  console.log('Phase 1: Searching for plugins (filename:marketplace.json path:.claude-plugin)…');
  const allRepos = await searchCodePages();
  console.log(`Found ${allRepos.size} unique plugin repos in code search`);

  if (allRepos.size === 0) {
    console.error('No plugin repos found — aborting without overwriting existing file');
    process.exit(0);
  }

  const knownRepos = loadKnownMap(KNOWN_FILE);
  console.log(`Known plugin repos: ${Object.keys(knownRepos).length}`);

  // Build lookup of existing plugin entries by repo for reuse when unchanged
  const existingByRepo = new Map();
  for (const p of (safeReadJson(OUT_FILE)?.plugins ?? [])) {
    if (!existingByRepo.has(p.repo)) existingByRepo.set(p.repo, []);
    existingByRepo.get(p.repo).push(p);
  }

  const toProcessPlugins = IS_FULL
    ? allRepos
    : new Map([...allRepos].filter(([fn]) => !(fn in knownRepos)));

  console.log(`Plugin repos to process: ${toProcessPlugins.size}`);

  // Full run: spread based on 1 metadata call per repo (minimum cost)
  const interRepoSleep = IS_FULL && toProcessPlugins.size > 0
    ? Math.max(0, Math.floor((TARGET_DURATION_MS - toProcessPlugins.size * 500) / toProcessPlugins.size))
    : 0;

  if (IS_FULL && toProcessPlugins.size > 0) {
    const estMin = Math.round(toProcessPlugins.size * (500 + interRepoSleep) / 60_000);
    console.log(`Inter-repo sleep: ${interRepoSleep}ms → estimated ≤${estMin} min for plugins`);
  }

  const scanTime     = new Date().toISOString();
  const newPlugins   = [];
  const updatedKnown = { ...knownRepos };
  let pluginsFetched = 0, pluginsReused = 0;

  for (const [fullName, { owner, repo }] of toProcessPlugins) {
    try {
      // Step 1: metadata (1 call) for change detection
      const meta = await fetchRepoMeta(owner, repo);
      if (!meta) { console.log(`  ${fullName} — skip (metadata failed)`); continue; }

      const known      = knownRepos[fullName];
      const hasChanged = !known?.repoUpdatedAt || meta.repoUpdatedAt !== known.repoUpdatedAt;

      // Step 2: unchanged — reuse existing entries
      if (!hasChanged && existingByRepo.has(fullName)) {
        const existing = existingByRepo.get(fullName);
        for (const e of existing) newPlugins.push({ ...e, repoUpdatedAt: meta.repoUpdatedAt });
        updatedKnown[fullName] = { lastScannedAt: scanTime, repoUpdatedAt: meta.repoUpdatedAt };
        pluginsReused++;
        if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);
        continue;
      }

      // Step 3: changed or new — fetch marketplace details (2 more calls)
      const mktDetails = await fetchMarketplaceDetails(owner, repo);
      if (!mktDetails) { console.log(`  ${fullName} — skip (marketplace fetch failed)`); continue; }

      const { marketplace, lastMarketplaceCommit } = mktDetails;
      const { stars, repoCreatedAt, repoUpdatedAt } = meta;

      if (stars < 1) continue;

      const ageDays = repoCreatedAt
        ? (Date.now() - new Date(repoCreatedAt).getTime()) / 86_400_000
        : 0;
      const tier = (stars >= 25 || (stars >= 10 && ageDays >= 90)) ? 'established' : 'new';
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
      pluginsFetched++;

      if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);

    } catch (err) {
      console.warn(`  ${fullName} — error: ${err.message}`);
    }
  }

  // Full run: prune stale known-repo entries no longer in code search
  if (IS_FULL) {
    const before = Object.keys(updatedKnown).length;
    for (const fn of Object.keys(updatedKnown)) {
      if (!allRepos.has(fn)) delete updatedKnown[fn];
    }
    const removed = before - Object.keys(updatedKnown).length;
    if (removed > 0) console.log(`Pruned ${removed} stale plugin entries`);
  }

  let finalPlugins;
  if (IS_FULL) {
    finalPlugins = newPlugins;
  } else {
    const processedRepos = new Set([...toProcessPlugins.keys()]);
    const existing = (safeReadJson(OUT_FILE)?.plugins ?? [])
      .filter(p => !processedRepos.has(p.repo));
    finalPlugins = [...existing, ...newPlugins];
    console.log(`Plugins merged: ${existing.length} existing + ${newPlugins.length} new = ${finalPlugins.length}`);
  }

  console.log(`Plugin phase: ${pluginsFetched} full fetch · ${pluginsReused} reused (saved ~${pluginsReused * 2} calls)`);

  // ── Phase 2: Tools ────────────────────────────────────────────

  console.log('\nPhase 2: Searching for MCP tools (topic:mcp-server topic:claude-code)…');
  const allTools = await searchToolsPages(allRepos);
  console.log(`Found ${allTools.size} tool repos (excluding plugin repos)`);

  const knownTools    = loadKnownMap(KNOWN_TOOLS_FILE);
  const existingTools = new Map(
    (safeReadJson(OUT_FILE)?.tools ?? []).map(t => [t.repo, t])
  );

  const toProcessTools = IS_FULL
    ? allTools
    : new Map([...allTools].filter(([fn]) => !(fn in knownTools)));

  console.log(`Tool repos to process: ${toProcessTools.size}`);

  const newTools          = [];
  const updatedKnownTools = { ...knownTools };
  let toolsFetched = 0, toolsReused = 0;

  for (const [fullName, toolMeta] of toProcessTools) {
    try {
      const { owner, name, desc, stars, topics, repoCreatedAt, repoUpdatedAt } = toolMeta;

      // Metadata came free from search results — use directly for change detection
      const known      = knownTools[fullName];
      const hasChanged = !known?.repoUpdatedAt || repoUpdatedAt !== known.repoUpdatedAt;

      if (!hasChanged && existingTools.has(fullName)) {
        newTools.push(existingTools.get(fullName));
        updatedKnownTools[fullName] = { lastScannedAt: scanTime, repoUpdatedAt };
        toolsReused++;
        continue;
      }

      if (stars < 1) continue;

      const ageDays = repoCreatedAt
        ? (Date.now() - new Date(repoCreatedAt).getTime()) / 86_400_000
        : 0;
      const tier = (stars >= 25 || (stars >= 10 && ageDays >= 90)) ? 'established' : 'new';

      // Fetch install hint from server.json for tools with enough stars
      let installHint = null;
      if (stars >= 10) {
        installHint = await fetchToolInstallHint(owner, fullName.split('/')[1]);
      }

      newTools.push({
        name,
        desc,
        author:       owner,
        repo:         fullName,
        repoUrl:      `https://github.com/${fullName}`,
        stars,
        tier,
        repoCreatedAt,
        repoUpdatedAt,
        topics,
        installHint,
      });

      updatedKnownTools[fullName] = { lastScannedAt: scanTime, repoUpdatedAt };
      toolsFetched++;

    } catch (err) {
      console.warn(`  ${fullName} (tool) — error: ${err.message}`);
    }
  }

  // Full run: prune stale tool entries no longer in topic search
  if (IS_FULL) {
    const before = Object.keys(updatedKnownTools).length;
    for (const fn of Object.keys(updatedKnownTools)) {
      if (!allTools.has(fn)) delete updatedKnownTools[fn];
    }
    const removed = before - Object.keys(updatedKnownTools).length;
    if (removed > 0) console.log(`Pruned ${removed} stale tool entries`);
  }

  let finalTools;
  if (IS_FULL) {
    finalTools = newTools;
  } else {
    const processedToolRepos = new Set([...toProcessTools.keys()]);
    const existingFinal = (safeReadJson(OUT_FILE)?.tools ?? [])
      .filter(t => !processedToolRepos.has(t.repo));
    finalTools = [...existingFinal, ...newTools];
    console.log(`Tools merged: ${existingFinal.length} existing + ${newTools.length} new = ${finalTools.length}`);
  }

  console.log(`Tool phase: ${toolsFetched} full fetch · ${toolsReused} reused (saved ~${toolsReused} calls)`);

  // ── Write outputs ─────────────────────────────────────────────

  const out = {
    generatedAt:  new Date().toISOString(),
    pluginCount:  finalPlugins.length,
    toolCount:    finalTools.length,
    plugins:      finalPlugins,
    tools:        finalTools,
  };

  fs.mkdirSync(path.dirname(OUT_FILE), { recursive: true });
  fs.writeFileSync(OUT_FILE,         JSON.stringify(out, null, 2), 'utf8');
  fs.writeFileSync(KNOWN_FILE,       JSON.stringify(updatedKnown, null, 2), 'utf8');
  fs.writeFileSync(KNOWN_TOOLS_FILE, JSON.stringify(updatedKnownTools, null, 2), 'utf8');

  console.log(`\nWrote ${finalPlugins.length} plugins + ${finalTools.length} tools to discovered.json`);
  console.log(`Wrote ${Object.keys(updatedKnown).length} entries to known-repos.json`);
  console.log(`Wrote ${Object.keys(updatedKnownTools).length} entries to known-tools.json`);
}

main().catch(err => { console.error(err); process.exit(1); });
