import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname } from 'path';
import type { Response } from 'express';
import type { AuthorizationParams, OAuthServerProvider } from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import { InvalidGrantError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type { OAuthClientInformationFull, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import { logger } from '../utils/logger.js';

/**
 * A minimal OAuth 2.1 authorization server for a single owner.
 *
 * Claude registers itself (dynamic client registration) and sends the user to
 * /authorize; the consent page asks for the owner's passphrase, and only then
 * is an authorization code issued. The SDK's handlers do the protocol work
 * (metadata, PKCE checks, token endpoint); this class decides who may sign in
 * and keeps clients and tokens.
 *
 * Tokens are stored as SHA-256 hashes in one JSON file, so a copy of the file
 * does not hand out working tokens. Access tokens last an hour; refresh tokens
 * 30 days and are rotated on every use, as OAuth 2.1 asks for public clients.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_MS = 5 * 60_000;
const PENDING_TTL_MS = 10 * 60_000;
export const OAUTH_SCOPE = 'mcp';

interface StoredToken {
  clientId: string;
  scopes: string[];
  expiresAt: number; // seconds
  resource?: string;
}

interface StoreFile {
  clients: Record<string, OAuthClientInformationFull>;
  access: Record<string, StoredToken>;
  refresh: Record<string, StoredToken>;
}

interface Pending {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
}

interface Code {
  clientId: string;
  params: AuthorizationParams;
  createdAt: number;
}

const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

/** Constant-time passphrase comparison (hashing first evens out the lengths). */
export function passphraseMatches(given: string, expected: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export function page(title: string, body: string): string {
  return `<!doctype html><html lang="it"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:26rem;margin:3rem auto;padding:0 1rem;color:#1d2433}
h1{font-size:1.3rem}input,button{font-size:1rem;padding:.6rem;width:100%;box-sizing:border-box;margin:.4rem 0}
button{background:#1e5bc6;color:#fff;border:0;border-radius:.4rem;cursor:pointer}.err{color:#b3261e}
.muted{color:#5b6475;font-size:.9rem}</style></head><body>${body}</body></html>`;
}

export class OwnerOAuthProvider implements OAuthServerProvider {
  private store: StoreFile = { clients: {}, access: {}, refresh: {} };
  private pending = new Map<string, Pending>();
  private codes = new Map<string, Code>();

  constructor(
    private readonly passphrase: string,
    private readonly file: string,
    /** A fixed bearer token for non-OAuth callers (a PWA backend, the Claude API). */
    private readonly apiToken?: string
  ) {
    if (existsSync(file)) {
      try {
        this.store = { ...this.store, ...(JSON.parse(readFileSync(file, 'utf8')) as Partial<StoreFile>) };
      } catch (error) {
        logger.error('Could not read the OAuth store, starting empty', { error: String(error) });
      }
    }
  }

  private persist(): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      writeFileSync(this.file, JSON.stringify(this.store, null, 2), { mode: 0o600 });
    } catch (error) {
      logger.error('Could not save the OAuth store', { error: String(error) });
    }
  }

  get clientsStore(): OAuthRegisteredClientsStore {
    return {
      getClient: (clientId) => this.store.clients[clientId],
      registerClient: (client) => {
        const full = {
          ...client,
          client_id: (client as Partial<OAuthClientInformationFull>).client_id ?? randomUUID(),
          client_id_issued_at: now(),
        } as OAuthClientInformationFull;
        this.store.clients[full.client_id] = full;
        this.persist();
        logger.info('OAuth client registered', { clientId: full.client_id, name: full.client_name });
        return full;
      },
    };
  }

  /** Show the consent page; the code is only issued by `approve` once the passphrase is right. */
  async authorize(client: OAuthClientInformationFull, params: AuthorizationParams, res: Response): Promise<void> {
    for (const [key, value] of this.pending) {
      if (Date.now() - value.createdAt > PENDING_TTL_MS) this.pending.delete(key);
    }
    for (const [key, value] of this.codes) {
      if (Date.now() - value.createdAt > CODE_TTL_MS) this.codes.delete(key);
    }
    const id = token();
    this.pending.set(id, { clientId: client.client_id, params, createdAt: Date.now() });
    res.status(200).type('html').send(this.consentPage(id, client));
  }

  consentPage(pendingId: string, client: OAuthClientInformationFull | undefined, error?: string): string {
    const name = escapeHtml(client?.client_name ?? 'Un client MCP');
    const host = (() => {
      try {
        return escapeHtml(new URL(this.pending.get(pendingId)?.params.redirectUri ?? '').host);
      } catch {
        return '';
      }
    })();
    return page(
      'Autorizza accesso',
      `<h1>Collegare ${name} a Carrefour Italia MCP?</h1>
<p>Potrà cercare prodotti, gestire carrello e liste e preparare ordini a tuo nome.</p>
<p class="muted">Dopo l'approvazione tornerai su <b>${host}</b>.</p>
${error ? `<p class="err">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/oauth/consent">
<input type="hidden" name="pending" value="${escapeHtml(pendingId)}">
<input type="password" name="passphrase" placeholder="Passphrase del server" autocomplete="current-password" required autofocus>
<button type="submit">Autorizza</button></form>`
    );
  }

  /**
   * The consent form's answer. Right passphrase: a redirect URL carrying a fresh
   * code. Wrong one: null, and the same pending request stays usable.
   */
  approve(pendingId: string, passphrase: string): { redirect: string } | { error: string } | null {
    const pending = this.pending.get(pendingId);
    if (!pending || Date.now() - pending.createdAt > PENDING_TTL_MS) {
      this.pending.delete(pendingId);
      return { error: 'Richiesta scaduta: ricomincia il collegamento da Claude.' };
    }
    if (!passphraseMatches(passphrase, this.passphrase)) return null;

    this.pending.delete(pendingId);
    const code = token();
    this.codes.set(code, { clientId: pending.clientId, params: pending.params, createdAt: Date.now() });
    const target = new URL(pending.params.redirectUri);
    target.searchParams.set('code', code);
    if (pending.params.state !== undefined) target.searchParams.set('state', pending.params.state);
    logger.info('OAuth access approved', { clientId: pending.clientId });
    return { redirect: target.toString() };
  }

  private liveCode(client: OAuthClientInformationFull, authorizationCode: string): Code {
    const code = this.codes.get(authorizationCode);
    if (!code || code.clientId !== client.client_id || Date.now() - code.createdAt > CODE_TTL_MS) {
      throw new InvalidGrantError('Invalid or expired authorization code');
    }
    return code;
  }

  async challengeForAuthorizationCode(client: OAuthClientInformationFull, authorizationCode: string): Promise<string> {
    return this.liveCode(client, authorizationCode).params.codeChallenge;
  }

  private issue(clientId: string, scopes: string[], resource?: string): OAuthTokens {
    const access = token();
    const refresh = token();
    this.store.access[sha256(access)] = { clientId, scopes, expiresAt: now() + ACCESS_TTL_S, resource };
    this.store.refresh[sha256(refresh)] = { clientId, scopes, expiresAt: now() + REFRESH_TTL_S, resource };
    this.prune();
    this.persist();
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: scopes.join(' '),
    };
  }

  private prune(): void {
    const t = now();
    for (const table of [this.store.access, this.store.refresh]) {
      for (const [key, value] of Object.entries(table)) if (value.expiresAt < t) delete table[key];
    }
  }

  async exchangeAuthorizationCode(
    client: OAuthClientInformationFull,
    authorizationCode: string,
    _codeVerifier?: string,
    redirectUri?: string
  ): Promise<OAuthTokens> {
    const code = this.liveCode(client, authorizationCode);
    if (redirectUri !== undefined && redirectUri !== code.params.redirectUri) {
      throw new InvalidGrantError('redirect_uri does not match the authorization request');
    }
    this.codes.delete(authorizationCode); // single use
    const scopes = code.params.scopes?.length ? code.params.scopes : [OAUTH_SCOPE];
    return this.issue(client.client_id, scopes, code.params.resource?.toString());
  }

  async exchangeRefreshToken(client: OAuthClientInformationFull, refreshToken: string): Promise<OAuthTokens> {
    const key = sha256(refreshToken);
    const stored = this.store.refresh[key];
    if (!stored || stored.clientId !== client.client_id || stored.expiresAt < now()) {
      throw new InvalidGrantError('Invalid or expired refresh token');
    }
    delete this.store.refresh[key]; // rotation: the old one stops working
    return this.issue(client.client_id, stored.scopes, stored.resource);
  }

  async verifyAccessToken(accessToken: string): Promise<AuthInfo> {
    if (this.apiToken && passphraseMatches(accessToken, this.apiToken)) {
      return { token: accessToken, clientId: 'api-token', scopes: [OAUTH_SCOPE], expiresAt: now() + 365 * 24 * 3600 };
    }
    const stored = this.store.access[sha256(accessToken)];
    if (!stored || stored.expiresAt < now()) throw new InvalidTokenError('Invalid or expired access token');
    return {
      token: accessToken,
      clientId: stored.clientId,
      scopes: stored.scopes,
      expiresAt: stored.expiresAt,
      resource: stored.resource ? new URL(stored.resource) : undefined,
    };
  }

  async revokeToken(_client: OAuthClientInformationFull, request: { token: string }): Promise<void> {
    const key = sha256(request.token);
    delete this.store.access[key];
    delete this.store.refresh[key];
    this.persist();
  }
}
