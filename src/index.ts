#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { config } from 'dotenv';
import { createServer } from './server.js';
import { startKeepAlive } from './services/auth.service.js';
import { browserService } from './services/browser.service.js';
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

  if (wantsHttp()) {
    const { startHttpServer, httpConfigFromEnv } = await import('./http/server.js');
    const http = await startHttpServer(httpConfigFromEnv());
    process.stderr.write(`[carrefour-it] MCP server ready on ${http.mcpUrl}\n`);
  } else {
    const { server, toolCount } = createServer();
    await server.connect(new StdioServerTransport());
    process.stderr.write(`[carrefour-it] MCP server ready — ${toolCount} API tools loaded\n`);
  }

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
