#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { createServer } from './server.js';
import { startKeepAlive } from './services/auth.service.js';
import { browserService } from './services/browser.service.js';
import { scheduleSessionCheckOnStart } from './services/relogin.service.js';
import { buildInfo } from './utils/build.js';
import { logger } from './utils/logger.js';

config();

/** `--http` or MCP_TRANSPORT=http serves MCP over HTTP; the default is stdio. */
function wantsHttp(): boolean {
  return process.argv.includes('--http') || process.env.MCP_TRANSPORT === 'http';
}

async function main(): Promise<void> {
  // SFCC sessions die after ~30 min idle, which a long-running server would
  // otherwise hit between two user requests.
  startKeepAlive();

  const build = buildInfo();
  logger.info('Carrefour MCP server starting', { version: process.env.npm_package_version, commit: build.commit });
  if (build.stale) {
    logger.warn('dist/ is older than src/: this is the OLD code. Run "npm run build" and restart the server.', { commit: build.commit });
    process.stderr.write('[carrefour-it] WARNING: dist/ is older than src/ — the server runs the OLD code. Run "npm run build" and restart.\n');
  }

  if (wantsHttp()) {
    const { startHttpServer, httpConfigFromEnv } = await import('./http/server.js');
    const http = await startHttpServer(httpConfigFromEnv());
    process.stderr.write(`[carrefour-it] MCP server ready on ${http.mcpUrl}${build.commit ? ` (commit ${build.commit})` : ''}\n`);
  } else {
    const { server, toolCount } = createServer();
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[carrefour-it] MCP server ready — ${toolCount} API tools loaded${build.commit ? ` (commit ${build.commit})` : ''}\n`);
  }

  // With CARREFOUR_RELOGIN_ON_START=1, sign in again now rather than on the first request.
  scheduleSessionCheckOnStart();

  // The browser is a child process; leaving it behind would lock the profile.
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
      browserService.close().finally(() => process.exit(0));
    });
  }
}

main().catch((error) => {
  logger.error('Failed to start server', { error: String(error) });
  process.stderr.write(`[carrefour-it] fatal: ${String(error)}\n`);
  process.exit(1);
});
