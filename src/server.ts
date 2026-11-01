import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerSpecTools } from './spec/register.js';
import { loadToolSpecs, type LoadResult } from './spec/loader.js';
import { registerSessionTools } from './tools/session.tools.js';
import { registerCheckoutTools } from './tools/checkout.tools.js';
import { registerListTools } from './tools/lists.tools.js';
import { logger } from './utils/logger.js';

let loaded: LoadResult | null = null;

/** The JSON tool definitions, read once: an HTTP server builds an McpServer per client session. */
function toolSpecs(): LoadResult {
  if (loaded) return loaded;
  loaded = loadToolSpecs();
  for (const f of loaded.failures) {
    process.stderr.write(`[carrefour-it] skipped ${f.file}: ${f.reason}\n`);
  }
  logger.info('Tools loaded', { declarative: loaded.specs.length, failed: loaded.failures.length, dir: loaded.dir });
  return loaded;
}

/** An MCP server with every carrefour.it tool registered, ready to connect to any transport. */
export function createServer(): { server: McpServer; toolCount: number } {
  const server = new McpServer({ name: 'carrefour-it', version: '3.0.0' });
  registerSessionTools(server);
  registerCheckoutTools(server);
  registerListTools(server);
  const load = toolSpecs();
  registerSpecTools(server, load);
  return { server, toolCount: load.specs.length };
}
