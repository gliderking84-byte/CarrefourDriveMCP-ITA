#!/usr/bin/env node
/**
 * Can this machine reach carrefour.it the way the server does?
 *
 * carrefour.it sits behind Cloudflare, which trusts a home connection far more
 * than a datacenter IP. Run this on a candidate machine (a VPS, a container
 * host) before deploying there: it drives the very transport the MCP server
 * uses (headless Chromium, masked user agent, requests issued from inside a
 * carrefour.it page) and reports whether Cloudflare lets it through.
 *
 * No account and no login: only public pages and a public search endpoint.
 *
 *   npm run build && node scripts/cloudflare-probe.mjs [rounds]
 *
 * Exit code: 0 = PASS, 1 = BLOCKED, 2 = could not run.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const rounds = Math.max(1, parseInt(process.argv[2] || '8', 10));
const ORIGIN = 'https://www.carrefour.it';
const SFCC = `${ORIGIN}/on/demandware.store/Sites-carrefour-IT-Site/it_IT`;

// A throwaway profile and session: never the real ones.
const scratch = mkdtempSync(join(tmpdir(), 'carrefour-probe-'));
process.env.CARREFOUR_DATA_DIR = scratch;
process.env.LOG_LEVEL = process.env.LOG_LEVEL || 'error';
process.env.MIN_DELAY_MS = '2000';
process.env.MAX_DELAY_MS = '4000';

/** Signs that Cloudflare answered instead of carrefour.it. */
function challenged(text) {
  return /Just a moment|challenge-platform|cf-chl|Attention Required|cf-error-details/i.test(text);
}

async function publicIp() {
  try {
    const response = await fetch('https://api.ipify.org?format=json');
    return (await response.json()).ip;
  } catch {
    return 'unknown';
  }
}

const results = [];
function record(step, ok, detail) {
  results.push({ step, ok, detail });
  console.log(`${ok ? 'PASS   ' : 'BLOCKED'}  ${step.padEnd(34)} ${detail}`);
}

let browserService;
try {
  ({ browserService } = await import(pathToFileURL(join(root, 'dist', 'services', 'browser.service.js')).href));
} catch (error) {
  console.error(`Build the project first (npm run build): ${error.message}`);
  process.exit(2);
}

console.log(`carrefour.it reachability probe — public IP ${await publicIp()}, ${rounds} rounds\n`);

try {
  // 0. Plain Node fetch, for reference: Cloudflare usually challenges it everywhere.
  try {
    const response = await fetch(`${ORIGIN}/`, { headers: { 'user-agent': 'Mozilla/5.0' } });
    const text = await response.text();
    console.log(
      `info     plain fetch (reference only)        HTTP ${response.status}` +
        `${response.headers.get('cf-mitigated') ? ` cf-mitigated=${response.headers.get('cf-mitigated')}` : ''}` +
        `${challenged(text) ? ' (challenge page)' : ''}\n`
    );
  } catch (error) {
    console.log(`info     plain fetch (reference only)        failed: ${error.message}\n`);
  }

  // 1. A real page load in the server's browser.
  const page = await browserService.visit(`${ORIGIN}/spesa-online/`);
  record('page load /spesa-online/', page.status === 200, `HTTP ${page.status} -> ${new URL(page.finalUrl).pathname}`);

  // 2. The server's in-page XHRs, repeated: challenges often start after a few requests.
  const xhr = { accept: 'application/json, text/plain, */*', 'x-requested-with': 'XMLHttpRequest' };
  const queries = ['latte', 'pasta', 'tonno', 'acqua', 'uova', 'caffe', 'pane', 'mele'];
  for (let i = 0; i < rounds; i += 1) {
    const q = queries[i % queries.length];
    const response = await browserService.fetch({
      method: 'GET',
      url: `${SFCC}/SearchRouter-Suggestions?q=${q}`,
      headers: xhr,
    });
    let json = false;
    try {
      json = JSON.parse(response.text).action === 'SearchRouter-Suggestions';
    } catch {
      json = false;
    }
    const ok = response.status === 200 && json && !challenged(response.text);
    record(
      `XHR search #${i + 1} (${q})`,
      ok,
      `HTTP ${response.status}${json ? ', JSON ok' : ''}${challenged(response.text) ? ', challenge page' : ''}`
    );
  }

  // 3. A bigger HTML fragment, like browse_category.
  const grid = await browserService.fetch({
    method: 'GET',
    url: `${SFCC}/Search-UpdateGrid?cgid=latte&start=0&sz=12`,
    headers: xhr,
  });
  const tiles = (grid.text.match(/data-product-json=/g) || []).length;
  record('category grid (latte)', grid.status === 200 && tiles > 0, `HTTP ${grid.status}, ${tiles} products`);
} catch (error) {
  console.error(`\nThe probe could not run: ${error.message.split('\n')[0]}`);
  console.error(
    /Executable doesn't exist|browserType\.launch/.test(error.message)
      ? 'Chromium is missing: npx playwright install --with-deps chromium'
      : 'carrefour.it could not be reached at all (DNS, firewall, proxy or TLS): fix the network first.'
  );
  await browserService.close().catch(() => undefined);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(2);
}

await browserService.close().catch(() => undefined);
rmSync(scratch, { recursive: true, force: true });

const blocked = results.filter((r) => !r.ok);
console.log(
  blocked.length === 0
    ? `\nVERDICT: PASS — carrefour.it answers this machine like a normal browser. It is a candidate for the server.`
    : `\nVERDICT: BLOCKED — ${blocked.length}/${results.length} steps were refused. Run the server from a home connection instead.`
);
process.exit(blocked.length === 0 ? 0 : 1);
