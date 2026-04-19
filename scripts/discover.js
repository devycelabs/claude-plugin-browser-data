#!/usr/bin/env node
'use strict';

/**
 * Discover Claude Code plugins and MCP tools.
 *
 * Phase 1 — Plugins:    Code Search for `filename:marketplace.json path:.claude-plugin`
 * Phase 2 — Tools:      Multiple repo-topic searches (each gets its own 1,000-result window)
 * Phase 3 — Additional: npm registry + official MCP registry (modelcontextprotocol/*)
 *
 * Grace-period pruning: repos absent from discovery for 1-2 full runs are carried forward
 * with maybeGone:true. Pruning only fires on the 3rd consecutive miss.
 *
 * Two modes set via CRAWL_MODE env var:
 *   full        — Sunday: checks every repo, skips unchanged via change-detection.
 *   incremental — Wednesday: only processes repos not yet in known-repos / known-tools.
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

const TARGET_DURATION_MS = 2 * 60 * 60 * 1000;

if (!TOKEN) {
  console.error('GITHUB_TOKEN is required');
  process.exit(1);
}

console.log(`Crawl mode: ${CRAWL_MODE.toUpperCase()}`);

// Topics stripped from tool entries — discovery-only, not useful as UI filters
const STRIP_TOPICS = new Set(['mcp-server', 'claude-code', 'anthropic']);

// ── Helpers ──────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function safeReadJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
  catch { return null; }
}

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
        'User-Agent':    'claude-scout/1.6',
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

function httpsGetJson(hostname, urlPath, headers = {}) {
  return new Promise((resolve) => {
    const req = https.get({
      hostname,
      path: urlPath,
      headers: { 'User-Agent': 'claude-scout/1.6', ...headers },
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try {
          if (res.statusCode === 200) {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } else {
            console.warn(`  HTTP ${res.statusCode} for ${hostname}${urlPath}`);
            resolve(null);
          }
        } catch { resolve(null); }
      });
    });
    req.setTimeout(15_000, () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
  });
}

// Extract { owner, name, fullName } from a GitHub URL string, or null
function parseGithubUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/github\.com[/:]([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:[/#?]|$)/);
  if (!m) return null;
  const owner = m[1], name = m[2].replace(/\.git$/, '');
  if (!owner || !name || owner === 'topics' || owner === 'orgs') return null;
  return { owner, name, fullName: `${owner}/${name}` };
}

// ── Phase 1: Plugin fetchers ──────────────────────────────────

async function searchCodePages() {
  const repos = new Map();
  const perPage = 100;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page++) {
    const q = encodeURIComponent('filename:marketplace.json path:.claude-plugin');
    const data = await githubGet(`search/code?q=${q}&per_page=${perPage}&page=${page}`);
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
        repos.set(fn, { owner: item.repository.owner.login, repo: item.repository.name });
      }
    }

    if (data.items.length < perPage) break;
  }

  return repos;
}

async function fetchRepoMeta(owner, repo) {
  const data = await githubGet(`repos/${owner}/${repo}`);
  await sleep(500);
  if (!data) return null;
  return {
    stars:         data.stargazers_count ?? 0,
    repoCreatedAt: data.created_at ?? null,
    repoUpdatedAt: data.updated_at ?? null,
  };
}

// Like fetchRepoMeta but also returns desc + topics — used for Phase 3 additional repos
async function fetchFullRepoMeta(owner, repo) {
  const data = await githubGet(`repos/${owner}/${repo}`);
  await sleep(500);
  if (!data) return null;
  return {
    stars:         data.stargazers_count ?? 0,
    desc:          data.description || '',
    topics:        (data.topics ?? []).filter(t => !STRIP_TOPICS.has(t)),
    repoCreatedAt: data.created_at ?? null,
    repoUpdatedAt: data.updated_at ?? null,
  };
}

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

// ── Phase 2: Tool repo search — multiple queries ──────────────

// Each entry runs an independent repo search with its own 1,000-result cap.
const TOOL_QUERIES = [
  { q: 'topic:mcp-server topic:claude-code',           sort: 'stars',   maxPages: 9, label: 'mcp-server+claude-code (stars desc)'  },
  { q: 'topic:mcp-server topic:claude-code stars:<25', sort: 'updated', maxPages: 9, label: 'mcp-server+claude-code <25 stars'      },
  { q: 'topic:claude-code',                            sort: 'updated', maxPages: 5, label: 'claude-code (updated)'                 },
  { q: 'topic:mcp-server topic:anthropic',             sort: 'stars',   maxPages: 5, label: 'mcp-server+anthropic (stars desc)'    },
];

async function searchReposByQuery(q, sort, maxPages) {
  const repos = new Map();
  const perPage = 100;

  for (let page = 1; page <= maxPages; page++) {
    const data = await githubGet(
      `search/repositories?q=${encodeURIComponent(q)}&per_page=${perPage}&page=${page}&sort=${sort}`,
    );
    await sleep(2000);

    if (!data?.items?.length) {
      if (page === 1 && !data) { console.warn(`  "${q}" returned no data — skipping`); break; }
      break;
    }

    for (const item of data.items) {
      if (!repos.has(item.full_name)) {
        repos.set(item.full_name, {
          owner:         item.owner.login,
          name:          item.name,
          desc:          item.description || '',
          stars:         item.stargazers_count ?? 0,
          topics:        (item.topics ?? []).filter(t => !STRIP_TOPICS.has(t)),
          repoCreatedAt: item.created_at ?? null,
          repoUpdatedAt: item.updated_at ?? null,
        });
      }
    }

    if (data.items.length < perPage) break;
  }

  return repos;
}

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

// ── Phase 3: Additional discovery sources ─────────────────────

/**
 * Mine npm registry for MCP/Claude Code packages.
 * Runs multiple search terms to maximise coverage. Extracts GitHub repo URLs
 * from package metadata (repository field).
 */
async function mineNpm() {
  const repos = new Map();
  const size  = 250;
  const terms = ['mcp claude-code', 'mcp-server claude', 'mcp anthropic'];

  for (const text of terms) {
    let from = 0;
    for (let page = 0; page < 4; page++) { // max 1,000 results per term
      const data = await httpsGetJson(
        'registry.npmjs.org',
        `/-/v1/search?text=${encodeURIComponent(text)}&size=${size}&from=${from}`,
      );
      await sleep(1000);
      if (!data?.objects?.length) break;

      for (const { package: pkg } of data.objects) {
        const repoUrl = pkg.links?.repository || pkg.repository?.url || '';
        const parsed  = parseGithubUrl(repoUrl);
        if (parsed && !repos.has(parsed.fullName)) {
          repos.set(parsed.fullName, { owner: parsed.owner, name: parsed.name });
        }
      }

      if (data.objects.length < size) break;
      from += size;
    }
  }

  console.log(`  npm: ${repos.size} unique GitHub repos across ${terms.length} search terms`);
  return repos;
}

/**
 * Mine Anthropic's official MCP registries.
 * modelcontextprotocol/servers and modelcontextprotocol/registry are
 * Anthropic-maintained canonical sources — not community lists.
 * Extracts all third-party GitHub repo URLs referenced in their READMEs.
 */
async function mineOfficialRegistry() {
  const repos = new Map();
  const sources = [
    { owner: 'modelcontextprotocol', repo: 'servers',  file: 'README.md' },
    { owner: 'modelcontextprotocol', repo: 'registry', file: 'README.md' },
  ];

  for (const { owner, repo, file } of sources) {
    const data = await githubGet(`repos/${owner}/${repo}/contents/${file}`);
    await sleep(500);
    if (!data?.content) {
      console.log(`  Official registry: ${owner}/${repo} — not found, skipping`);
      continue;
    }

    const content = Buffer.from(data.content, 'base64').toString('utf8');
    const ghUrlRe = /https?:\/\/github\.com\/([\w.-]+)\/([\w.-]+)/g;
    let m, extracted = 0;

    while ((m = ghUrlRe.exec(content)) !== null) {
      const repoOwner = m[1], repoName = m[2].replace(/\.git$/, '');
      if (repoOwner === 'modelcontextprotocol' || repoOwner === 'topics' || repoOwner === 'orgs') continue;
      const fullName = `${repoOwner}/${repoName}`;
      if (!repos.has(fullName)) {
        repos.set(fullName, { owner: repoOwner, name: repoName });
        extracted++;
      }
    }

    console.log(`  Official registry: ${owner}/${repo} — ${extracted} repos extracted`);
  }

  return repos;
}

// ── Main ──────────────────────────────────────────────────────

async function main() {
  // ── Phase 1: Plugins ─────────────────────────────────────────

  console.log('Phase 1: Searching for plugins (filename:marketplace.json path:.claude-plugin)...');
  const allPluginRepos = await searchCodePages();
  console.log(`Found ${allPluginRepos.size} unique plugin repos in code search`);

  if (allPluginRepos.size === 0) {
    console.error('No plugin repos found — aborting without overwriting existing file');
    process.exit(0);
  }

  const knownRepos = loadKnownMap(KNOWN_FILE);
  console.log(`Known plugin repos: ${Object.keys(knownRepos).length}`);

  const existingByRepo = new Map();
  for (const p of (safeReadJson(OUT_FILE)?.plugins ?? [])) {
    if (!existingByRepo.has(p.repo)) existingByRepo.set(p.repo, []);
    existingByRepo.get(p.repo).push(p);
  }

  const toProcessPlugins = IS_FULL
    ? allPluginRepos
    : new Map([...allPluginRepos].filter(([fn]) => !(fn in knownRepos)));

  console.log(`Plugin repos to process: ${toProcessPlugins.size}`);

  const interRepoSleep = IS_FULL && toProcessPlugins.size > 0
    ? Math.max(0, Math.floor((TARGET_DURATION_MS - toProcessPlugins.size * 500) / toProcessPlugins.size))
    : 0;

  if (IS_FULL && toProcessPlugins.size > 0) {
    const estMin = Math.round(toProcessPlugins.size * (500 + interRepoSleep) / 60_000);
    console.log(`Inter-repo sleep: ${interRepoSleep}ms => estimated <=${estMin} min for plugins`);
  }

  const scanTime     = new Date().toISOString();
  const newPlugins   = [];
  const updatedKnown = { ...knownRepos };
  let pluginsFetched = 0, pluginsReused = 0;

  for (const [fullName, { owner, repo }] of toProcessPlugins) {
    try {
      const meta = await fetchRepoMeta(owner, repo);
      if (!meta) { console.log(`  ${fullName} — skip (metadata failed)`); continue; }

      const known      = knownRepos[fullName];
      const hasChanged = !known?.repoUpdatedAt || meta.repoUpdatedAt !== known.repoUpdatedAt;

      if (!hasChanged && existingByRepo.has(fullName)) {
        const existing = existingByRepo.get(fullName);
        for (const e of existing) newPlugins.push({ ...e, repoUpdatedAt: meta.repoUpdatedAt, maybeGone: false });
        updatedKnown[fullName] = { lastScannedAt: scanTime, repoUpdatedAt: meta.repoUpdatedAt, missedFullRuns: 0 };
        pluginsReused++;
        if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);
        continue;
      }

      const mktDetails = await fetchMarketplaceDetails(owner, repo);
      if (!mktDetails) { console.log(`  ${fullName} — skip (marketplace fetch failed)`); continue; }

      const { marketplace, lastMarketplaceCommit } = mktDetails;
      const { stars, repoCreatedAt, repoUpdatedAt } = meta;
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
          stars, tier,
          lastMarketplaceCommit,
          repoCreatedAt, repoUpdatedAt,
          keywords:             p.keywords ?? [],
        });
      }

      updatedKnown[fullName] = { lastScannedAt: scanTime, repoUpdatedAt, missedFullRuns: 0 };
      pluginsFetched++;
      if (IS_FULL && interRepoSleep > 0) await sleep(interRepoSleep);

    } catch (err) {
      console.warn(`  ${fullName} — error: ${err.message}`);
    }
  }

  // Grace-period pruning for plugins
  const gracePeriodPlugins = [];
  if (IS_FULL) {
    let pruned = 0, graced = 0;
    for (const fn of Object.keys(knownRepos)) {
      if (allPluginRepos.has(fn)) continue;
      const misses = (knownRepos[fn].missedFullRuns ?? 0) + 1;
      if (misses >= 3) {
        delete updatedKnown[fn];
        pruned++;
      } else {
        updatedKnown[fn] = { ...knownRepos[fn], missedFullRuns: misses };
        for (const p of (existingByRepo.get(fn) ?? [])) {
          gracePeriodPlugins.push({ ...p, maybeGone: true });
        }
        graced++;
      }
    }
    if (pruned > 0) console.log(`Pruned ${pruned} plugin repos (absent 3+ full runs)`);
    if (graced > 0) console.log(`Grace period: ${graced} plugin repos carried forward as maybeGone`);
  }

  let finalPlugins;
  if (IS_FULL) {
    finalPlugins = [...newPlugins, ...gracePeriodPlugins];
  } else {
    const processedRepos = new Set([...toProcessPlugins.keys()]);
    const existing = (safeReadJson(OUT_FILE)?.plugins ?? [])
      .filter(p => !processedRepos.has(p.repo));
    finalPlugins = [...existing, ...newPlugins];
    console.log(`Plugins merged: ${existing.length} existing + ${newPlugins.length} new = ${finalPlugins.length}`);
  }

  console.log(`Plugin phase: ${pluginsFetched} full fetch · ${pluginsReused} reused (saved ~${pluginsReused * 2} calls)`);

  // ── Phase 2: Tools — multiple search queries ──────────────────

  console.log('\nPhase 2: Searching for MCP tools across multiple queries...');
  const allTools = new Map();

  for (const { q, sort, maxPages, label } of TOOL_QUERIES) {
    console.log(`  Query: ${label}`);
    const results = await searchReposByQuery(q, sort, maxPages);
    let added = 0;
    for (const [fn, meta] of results) {
      if (!allPluginRepos.has(fn) && !allTools.has(fn)) {
        allTools.set(fn, meta);
        added++;
      }
    }
    console.log(`  -> ${results.size} found, ${added} new after dedup`);
  }

  console.log(`Phase 2 total: ${allTools.size} unique tool repos`);

  // ── Phase 3: Additional discovery sources ─────────────────────

  console.log('\nPhase 3: Mining additional sources...');
  const npmRepos      = await mineNpm();
  const registryRepos = await mineOfficialRegistry();

  // Merge all additional repos, excluding anything already found in phases 1 & 2
  const additionalRepos = new Map();
  for (const [fn, meta] of [...npmRepos, ...registryRepos]) {
    if (!allPluginRepos.has(fn) && !allTools.has(fn) && !additionalRepos.has(fn)) {
      additionalRepos.set(fn, meta);
    }
  }
  console.log(`Phase 3: ${additionalRepos.size} net-new repos (after dedup with phases 1+2)`);

  // ── Tool processing ───────────────────────────────────────────

  const knownTools    = loadKnownMap(KNOWN_TOOLS_FILE);
  const existingTools = new Map(
    (safeReadJson(OUT_FILE)?.tools ?? []).map(t => [t.repo, t])
  );

  const toProcessTools = IS_FULL
    ? allTools
    : new Map([...allTools].filter(([fn]) => !(fn in knownTools)));

  const toProcessAdditional = IS_FULL
    ? additionalRepos
    : new Map([...additionalRepos].filter(([fn]) => !(fn in knownTools)));

  console.log(`Tool repos to process: ${toProcessTools.size} topic-search + ${toProcessAdditional.size} additional`);

  const newTools          = [];
  const updatedKnownTools = { ...knownTools };
  let toolsFetched = 0, toolsReused = 0;

  // Process topic-search tools — metadata already available from search results
  for (const [fullName, toolMeta] of toProcessTools) {
    try {
      const { owner, name, desc, stars, topics, repoCreatedAt, repoUpdatedAt } = toolMeta;
      const known      = knownTools[fullName];
      const hasChanged = !known?.repoUpdatedAt || repoUpdatedAt !== known.repoUpdatedAt;

      if (!hasChanged && existingTools.has(fullName)) {
        newTools.push({ ...existingTools.get(fullName), maybeGone: false });
        updatedKnownTools[fullName] = { lastScannedAt: scanTime, repoUpdatedAt, missedFullRuns: 0 };
        toolsReused++;
        continue;
      }

      const ageDays = repoCreatedAt
        ? (Date.now() - new Date(repoCreatedAt).getTime()) / 86_400_000
        : 0;
      const tier = (stars >= 25 || (stars >= 10 && ageDays >= 90)) ? 'established' : 'new';

      let installHint = null;
      if (stars >= 10) installHint = await fetchToolInstallHint(owner, name);

      newTools.push({
        name, desc, author: owner,
        repo:    fullName,
        repoUrl: `https://github.com/${fullName}`,
        stars, tier, repoCreatedAt, repoUpdatedAt, topics,
        installHint,
        source: 'topic-search',
      });

      updatedKnownTools[fullName] = { lastScannedAt: scanTime, repoUpdatedAt, missedFullRuns: 0 };
      toolsFetched++;

    } catch (err) {
      console.warn(`  ${fullName} (tool) — error: ${err.message}`);
    }
  }

  // Process additional-source tools — need explicit metadata fetch (one API call each)
  for (const [fullName, { owner, name: repoName }] of toProcessAdditional) {
    try {
      const known = knownTools[fullName];
      const meta  = await fetchFullRepoMeta(owner, repoName);
      if (!meta) { console.log(`  ${fullName} — skip (metadata failed)`); continue; }

      const { stars, desc, topics, repoCreatedAt, repoUpdatedAt } = meta;
      const hasChanged = !known?.repoUpdatedAt || repoUpdatedAt !== known.repoUpdatedAt;

      if (!hasChanged && existingTools.has(fullName)) {
        newTools.push({ ...existingTools.get(fullName), maybeGone: false });
        updatedKnownTools[fullName] = { lastScannedAt: scanTime, repoUpdatedAt, missedFullRuns: 0 };
        toolsReused++;
        continue;
      }

      const ageDays = repoCreatedAt
        ? (Date.now() - new Date(repoCreatedAt).getTime()) / 86_400_000
        : 0;
      const tier = (stars >= 25 || (stars >= 10 && ageDays >= 90)) ? 'established' : 'new';

      let installHint = null;
      if (stars >= 10) installHint = await fetchToolInstallHint(owner, repoName);

      const source = npmRepos.has(fullName) ? 'npm' : 'official-registry';

      newTools.push({
        name: repoName, desc, author: owner,
        repo:    fullName,
        repoUrl: `https://github.com/${fullName}`,
        stars, tier, repoCreatedAt, repoUpdatedAt, topics,
        installHint,
        source,
      });

      updatedKnownTools[fullName] = { lastScannedAt: scanTime, repoUpdatedAt, missedFullRuns: 0 };
      toolsFetched++;

    } catch (err) {
      console.warn(`  ${fullName} (additional) — error: ${err.message}`);
    }
  }

  // Grace-period pruning for tools
  // A repo must be absent from ALL discovery paths to count as missing
  const allDiscoveredTools = new Map([...allTools, ...additionalRepos]);
  const gracePeriodTools   = [];
  if (IS_FULL) {
    let pruned = 0, graced = 0;
    for (const fn of Object.keys(knownTools)) {
      if (allDiscoveredTools.has(fn)) continue;
      const misses = (knownTools[fn].missedFullRuns ?? 0) + 1;
      if (misses >= 3) {
        delete updatedKnownTools[fn];
        pruned++;
      } else {
        updatedKnownTools[fn] = { ...knownTools[fn], missedFullRuns: misses };
        const existing = existingTools.get(fn);
        if (existing) gracePeriodTools.push({ ...existing, maybeGone: true });
        graced++;
      }
    }
    if (pruned > 0) console.log(`Pruned ${pruned} tool repos (absent 3+ full runs)`);
    if (graced > 0) console.log(`Grace period: ${graced} tool repos carried forward as maybeGone`);
  }

  let finalTools;
  if (IS_FULL) {
    finalTools = [...newTools, ...gracePeriodTools];
  } else {
    const processedToolRepos = new Set([...toProcessTools.keys(), ...toProcessAdditional.keys()]);
    const existingFinal = (safeReadJson(OUT_FILE)?.tools ?? [])
      .filter(t => !processedToolRepos.has(t.repo));
    finalTools = [...existingFinal, ...newTools];
    console.log(`Tools merged: ${existingFinal.length} existing + ${newTools.length} new = ${finalTools.length}`);
  }

  console.log(`Tool phase: ${toolsFetched} full fetch · ${toolsReused} reused`);

  // ── Write outputs ─────────────────────────────────────────────

  const out = {
    generatedAt: new Date().toISOString(),
    pluginCount: finalPlugins.length,
    toolCount:   finalTools.length,
    plugins:     finalPlugins,
    tools:       finalTools,
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
