import { randomUUID } from 'crypto';
import type { Server } from 'http';
import express, { type Request, type Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { mcpAuthRouter, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../server.js';
import { OwnerOAuthProvider, OAUTH_SCOPE, page } from './oauth.js';
import { AttemptLimiter, deskAvailable, mountDesk } from './desk.js';
import { dataPath } from '../utils/paths.js';
import { logger } from '../utils/logger.js';

/**
 * MCP over Streamable HTTP, for remote clients: a Claude custom connector, a
 * PWA backend, the Claude API's MCP connector.
 *
 *   /mcp                                   the MCP endpoint (bearer token required)
 *   /.well-known/oauth-*, /authorize, /token, /register, /revoke   OAuth 2.1 (SDK handlers)
 *   /oauth/consent                         the owner approves a client with the passphrase
 *   /desk                                  the server's screen through noVNC (when available)
 *   /health                                liveness, no auth
 *
 * Claude finds the authorization server from the 401's resource_metadata
 * pointer, registers itself, sends the user to the consent page, and gets
 * tokens. Other callers can use MCP_API_TOKEN as a fixed bearer token.
 */

export interface HttpConfig {
  /** The public HTTPS origin users reach, e.g. https://mcp.example.com (http://localhost allowed). */
  publicUrl: URL;
  port: number;
  host: string;
  /** Path of the MCP endpoint. */
  mcpPath: string;
  passphrase: string;
  apiToken?: string;
  novncDir?: string;
  vncPort: number;
}

export function httpConfigFromEnv(env: NodeJS.ProcessEnv = process.env): HttpConfig {
  const missing = ['PUBLIC_URL', 'MCP_OWNER_PASSPHRASE'].filter((k) => !env[k]);
  if (missing.length) throw new Error(`HTTP mode needs ${missing.join(' and ')} (see .env.example).`);
  if ((env.MCP_OWNER_PASSPHRASE ?? '').length < 12) {
    throw new Error('MCP_OWNER_PASSPHRASE must be at least 12 characters: it guards your carrefour.it account.');
  }
  if (env.MCP_API_TOKEN !== undefined && env.MCP_API_TOKEN.length < 32) {
    throw new Error('MCP_API_TOKEN must be at least 32 characters (e.g. openssl rand -hex 32).');
  }
  return {
    publicUrl: new URL(env.PUBLIC_URL!),
    port: parseInt(env.PORT || '3000', 10),
    host: env.HOST || '127.0.0.1',
    mcpPath: env.MCP_PATH || '/mcp',
    passphrase: env.MCP_OWNER_PASSPHRASE!,
    apiToken: env.MCP_API_TOKEN || undefined,
    novncDir: env.NOVNC_DIR,
    vncPort: parseInt(env.VNC_PORT || '5900', 10),
  };
}

export interface RunningHttpServer {
  server: Server;
  port: number;
  mcpUrl: string;
  close(): Promise<void>;
}

export async function startHttpServer(config: HttpConfig): Promise<RunningHttpServer> {
  const mcpUrl = new URL(config.mcpPath, config.publicUrl);
  const provider = new OwnerOAuthProvider(config.passphrase, dataPath('oauth.json'), config.apiToken);
  const limiter = new AttemptLimiter();

  const app = express();
  // The client address (for the passphrase limiter) comes from X-Forwarded-For
  // only when the request arrives from a private or loopback hop, such as
  // cloudflared next to the server: exposed directly, the header can't be forged.
  app.set('trust proxy', process.env.TRUST_PROXY || 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  app.use(
    mcpAuthRouter({
      provider,
      issuerUrl: new URL(config.publicUrl.origin),
      resourceServerUrl: mcpUrl,
      scopesSupported: [OAUTH_SCOPE],
      resourceName: 'Carrefour Italia MCP',
    })
  );

  app.post('/oauth/consent', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    const pendingId = String(req.body?.pending ?? '');
    if (limiter.blocked(ip)) {
      return res.status(429).type('html').send(page('Troppi tentativi', '<h1>Troppi tentativi</h1><p>Riprova tra qualche minuto.</p>'));
    }
    const result = provider.approve(pendingId, String(req.body?.passphrase ?? ''));
    if (result === null) {
      limiter.fail(ip);
      return res.status(401).type('html').send(provider.consentPage(pendingId, undefined, 'Passphrase errata.'));
    }
    if ('error' in result) return res.status(400).type('html').send(page('Richiesta scaduta', `<p class="err">${result.error}</p>`));
    limiter.reset(ip);
    res.redirect(302, result.redirect);
  });

  // --- MCP endpoint ----------------------------------------------------------
  const bearer = requireBearerAuth({
    verifier: provider,
    requiredScopes: [OAUTH_SCOPE],
    resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(mcpUrl),
  });
  const transports = new Map<string, StreamableHTTPServerTransport>();

  app.post(config.mcpPath, bearer, express.json({ limit: '4mb' }), async (req: Request, res: Response) => {
    const sessionId = req.header('mcp-session-id');
    let transport = sessionId ? transports.get(sessionId) : undefined;

    if (!transport) {
      if (sessionId || !isInitializeRequest(req.body)) {
        return res.status(400).json({
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: unknown or missing MCP session' },
          id: null,
        });
      }
      const created = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports.set(id, created);
        },
      });
      created.onclose = () => {
        if (created.sessionId) transports.delete(created.sessionId);
      };
      await createServer().server.connect(created);
      transport = created;
    }
    await transport.handleRequest(req, res, req.body);
  });

  const sessionRequest = async (req: Request, res: Response) => {
    const transport = transports.get(req.header('mcp-session-id') ?? '');
    if (!transport) return res.status(400).send('Unknown or missing MCP session');
    await transport.handleRequest(req, res);
  };
  app.get(config.mcpPath, bearer, sessionRequest);
  app.delete(config.mcpPath, bearer, sessionRequest);

  // --- Listen ----------------------------------------------------------------
  const server = await new Promise<Server>((resolve) => {
    const s = app.listen(config.port, config.host, () => resolve(s));
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : config.port;

  if (deskAvailable(config.novncDir)) {
    mountDesk(app, server, {
      passphrase: config.passphrase,
      limiter,
      novncDir: config.novncDir,
      vncPort: config.vncPort,
      secureCookies: config.publicUrl.protocol === 'https:',
    });
    // Tools that open a window tell the user where to see it.
    process.env.CARREFOUR_DESK_URL = new URL('/desk', config.publicUrl).toString();
  }

  logger.info('HTTP server listening', { host: config.host, port, mcpUrl: mcpUrl.toString(), desk: !!process.env.CARREFOUR_DESK_URL });

  return {
    server,
    port,
    mcpUrl: mcpUrl.toString(),
    close: async () => {
      for (const t of transports.values()) await t.close().catch(() => undefined);
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
