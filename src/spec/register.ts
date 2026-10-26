import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { buildRequest } from './resolve.js';
import { schemaToZodShape } from './params.js';
import type { ToolSpec } from './types.js';
import { loadToolSpecs, type LoadResult } from './loader.js';
import { extract } from './extract.js';
import { httpService, redactUrl } from '../services/http.service.js';
import { sessionService, NO_SESSION_MESSAGE } from '../services/session.service.js';
import { getCsrfToken, isLoggedIn } from '../services/auth.service.js';
import { logger } from '../utils/logger.js';

const MAX_RESPONSE_CHARS = parseInt(process.env.CARREFOUR_MAX_RESPONSE_CHARS || '60000', 10);

interface ToolResult {
  [key: string]: unknown;
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

function text(body: string, isError = false): ToolResult {
  return { content: [{ type: 'text', text: body }], isError };
}

function render(data: unknown): string {
  const out = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  if (out.length <= MAX_RESPONSE_CHARS) return out;
  return `${out.slice(0, MAX_RESPONSE_CHARS)}\n\n[truncated: ${out.length} chars total — refine your query or raise CARREFOUR_MAX_RESPONSE_CHARS]`;
}

/** Execute one declarative tool. Exported so the smoke test can drive it directly. */
export async function executeSpec(spec: ToolSpec, args: Record<string, unknown>): Promise<ToolResult> {
  if (spec.requires_auth && !sessionService.hasSession()) {
    return text(NO_SESSION_MESSAGE, true);
  }

  try {
    // SFCC never answers 401: an expired session is silently a guest one, which
    // would show an empty cart or take a write into an anonymous one.
    if (spec.requires_auth && (await isLoggedIn()) === false) {
      return text(`carrefour.it no longer sees you as signed in, so ${spec.name} was not sent.\n\n${NO_SESSION_MESSAGE}`, true);
    }

    // The token is a reserved argument: templates read it as {"$param": "csrf_token"}.
    const callArgs = spec.csrf ? { ...args, csrf_token: await getCsrfToken() } : args;

    let request;
    try {
      request = buildRequest(spec, callArgs);
    } catch (error) {
      return text(`Could not build the request for "${spec.name}": ${(error as Error).message}`, true);
    }

    const result = await httpService.send(request, { withAuth: spec.requires_auth !== false });

    if (result.status === 403) {
      return text(
        `Carrefour returned 403 for ${spec.name}: the Cloudflare challenge or the CSRF check rejected the ` +
          'request. Try again; if it persists, sign in again with carrefour_browser_login.',
        true
      );
    }

    if (!result.ok) {
      return text(
        `HTTP ${result.status} ${result.statusText} on ${request.method} ${redactUrl(request.url)}\n\n${render(extract(result.data))}`,
        true
      );
    }

    return text(render(extract(result.data, spec.response)));
  } catch (error) {
    logger.error('Tool execution failed', { tool: spec.name, error: String(error) });
    return text(`Request failed for "${spec.name}": ${(error as Error).message}`, true);
  }
}

/**
 * Register every JSON-declared tool on the MCP server.
 * Every carrefour.it endpoint is served by this one generic executor.
 */
export function registerSpecTools(server: McpServer, load: LoadResult = loadToolSpecs()): LoadResult {
  for (const spec of load.specs) {
    const shape = schemaToZodShape(spec.parameters);
    const description = spec.requires_auth
      ? `${spec.description} (requires an authenticated Carrefour session)`
      : spec.description;

    server.tool(spec.name, description, shape, async (args: Record<string, unknown>) =>
      executeSpec(spec, args ?? {})
    );
  }

  for (const failure of load.failures) {
    logger.error('Skipped tool definition', failure);
  }

  return load;
}
