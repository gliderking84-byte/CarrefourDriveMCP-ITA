import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer as createTcpServer, type Server as TcpServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The HTTP server end to end on a local port: OAuth as Claude performs it, then MCP calls.

const dir = mkdtempSync(join(tmpdir(), 'carrefour-http-test-'));
process.env.CARREFOUR_DATA_DIR = dir;
process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
process.env.LOG_LEVEL = 'error';

const { startHttpServer, httpConfigFromEnv } = await import('../http/server.js');
const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { WebSocket } = await import('ws');

const PASSPHRASE = 'correct horse battery staple';
const API_TOKEN = 'a'.repeat(40);
const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';

let http: Awaited<ReturnType<typeof startHttpServer>>;
let base: string;
let vnc: TcpServer;
let vncPort: number;

before(async () => {
  // A stand-in for x11vnc: echoes what the desk proxy sends.
  vnc = createTcpServer((socket) => socket.pipe(socket));
  await new Promise<void>((r) => vnc.listen(0, '127.0.0.1', r));
  vncPort = (vnc.address() as { port: number }).port;

  const novnc = join(dir, 'novnc');
  rmSync(novnc, { recursive: true, force: true });
  (await import('node:fs')).mkdirSync(novnc);
  writeFileSync(join(novnc, 'vnc.html'), '<html>noVNC</html>');

  // Bind first to learn the port, then restart with the matching public URL.
  const probe = await startHttpServer({ ...config(0), publicUrl: new URL('http://localhost:1') });
  const port = probe.port;
  await probe.close();
  http = await startHttpServer({ ...config(port), novncDir: novnc, vncPort });
  base = `http://localhost:${port}`;
});

after(async () => {
  await http?.close();
  vnc?.close();
  rmSync(dir, { recursive: true, force: true });
});

function config(port: number) {
  return {
    publicUrl: new URL(`http://localhost:${port}`),
    port,
    host: '127.0.0.1',
    mcpPath: '/mcp',
    passphrase: PASSPHRASE,
    apiToken: API_TOKEN,
    vncPort: 1,
  };
}

const form = (fields: Record<string, string>) => ({
  method: 'POST',
  headers: { 'content-type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams(fields).toString(),
  redirect: 'manual' as const,
});

/** The OAuth dance Claude performs: discovery, registration, consent, code, token. */
async function signIn(passphrase = PASSPHRASE): Promise<{ access_token?: string; refresh_token?: string; clientId: string; consentStatus: number }> {
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const registration = await (
    await fetch(meta.registration_endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Claude', redirect_uris: [REDIRECT], token_endpoint_auth_method: 'none' }),
    })
  ).json();

  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const authorize = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: 'code',
    client_id: registration.client_id,
    redirect_uri: REDIRECT,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state: 'xyz',
    scope: 'mcp',
    resource: `${base}/mcp`,
  })) {
    authorize.searchParams.set(k, v);
  }
  const consent = await fetch(authorize);
  assert.equal(consent.status, 200);
  const html = await consent.text();
  assert.match(html, /Passphrase del server/);
  assert.match(html, /claude\.ai/, 'the consent page names where the user will be sent');
  const pending = html.match(/name="pending" value="([^"]+)"/)![1];

  const approved = await fetch(`${base}/oauth/consent`, form({ pending, passphrase }));
  if (approved.status !== 302) return { clientId: registration.client_id, consentStatus: approved.status };
  const back = new URL(approved.headers.get('location')!);
  assert.equal(back.origin + back.pathname, REDIRECT);
  assert.equal(back.searchParams.get('state'), 'xyz');

  const tokens = await (
    await fetch(meta.token_endpoint, form({
      grant_type: 'authorization_code',
      code: back.searchParams.get('code')!,
      code_verifier: verifier,
      client_id: registration.client_id,
      redirect_uri: REDIRECT,
    }))
  ).json();
  return { ...tokens, clientId: registration.client_id, consentStatus: 302 };
}

async function listTools(bearer: string): Promise<number> {
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${base}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${bearer}` } },
  });
  await client.connect(transport);
  try {
    return (await client.listTools()).tools.length;
  } finally {
    await client.close();
  }
}

test('httpConfigFromEnv refuses to start without a public URL or a strong passphrase', () => {
  assert.throws(() => httpConfigFromEnv({}), /PUBLIC_URL and MCP_OWNER_PASSPHRASE/);
  assert.throws(() => httpConfigFromEnv({ PUBLIC_URL: 'https://x', MCP_OWNER_PASSPHRASE: 'short' }), /at least 12/);
  assert.throws(
    () => httpConfigFromEnv({ PUBLIC_URL: 'https://x', MCP_OWNER_PASSPHRASE: PASSPHRASE, MCP_API_TOKEN: 'abc' }),
    /at least 32/
  );
  const ok = httpConfigFromEnv({ PUBLIC_URL: 'https://mcp.example.com', MCP_OWNER_PASSPHRASE: PASSPHRASE });
  assert.equal(ok.host, '127.0.0.1');
  assert.equal(ok.mcpPath, '/mcp');
});

test('an unauthenticated MCP call gets the 401 that starts Claude\'s sign-in', async () => {
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}',
  });
  assert.equal(res.status, 401);
  const header = res.headers.get('www-authenticate') ?? '';
  assert.match(header, /resource_metadata="http:\/\/localhost:\d+\/\.well-known\/oauth-protected-resource\/mcp"/);

  const resource = await (await fetch(`${base}/.well-known/oauth-protected-resource/mcp`)).json();
  assert.equal(resource.resource, `${base}/mcp`);
  assert.deepEqual(resource.authorization_servers, [`${base}/`]);
});

test('Claude\'s OAuth flow ends in a token that serves MCP', async () => {
  const tokens = await signIn();
  assert.ok(tokens.access_token);
  assert.ok(tokens.refresh_token);
  assert.ok((await listTools(tokens.access_token!)) >= 27);
});

test('a wrong passphrase issues no code', async () => {
  const result = await signIn('not the passphrase');
  assert.equal(result.consentStatus, 401);
  assert.equal(result.access_token, undefined);
});

test('refresh tokens rotate: the old one stops working', async () => {
  const tokens = await signIn();
  const meta = await (await fetch(`${base}/.well-known/oauth-authorization-server`)).json();
  const refresh = (rt: string) =>
    fetch(meta.token_endpoint, form({ grant_type: 'refresh_token', refresh_token: rt, client_id: tokens.clientId }));
  const first = await refresh(tokens.refresh_token!);
  assert.equal(first.status, 200);
  const again = await refresh(tokens.refresh_token!);
  assert.equal(again.status, 400);
  assert.equal((await again.json()).error, 'invalid_grant');
});

test('MCP_API_TOKEN works as a fixed bearer token, and nothing else does', async () => {
  assert.ok((await listTools(API_TOKEN)) >= 27);
  const res = await fetch(`${base}/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
    body: '{}',
  });
  assert.equal(res.status, 401);
});

test('the desk asks for the passphrase, then serves noVNC and proxies VNC', async () => {
  const gate = await fetch(`${base}/desk/vnc.html`, { redirect: 'manual' });
  assert.equal(gate.status, 302, 'noVNC files are not public');

  const refused = await fetch(`${base}/desk/login`, form({ passphrase: 'nope' }));
  assert.equal(refused.status, 401);

  const login = await fetch(`${base}/desk/login`, form({ passphrase: PASSPHRASE }));
  assert.equal(login.status, 302);
  const cookie = login.headers.get('set-cookie')!.split(';')[0];
  assert.match(login.headers.get('set-cookie')!, /HttpOnly/i);

  const viewer = await fetch(`${base}/desk/vnc.html`, { headers: { cookie } });
  assert.equal(await viewer.text(), '<html>noVNC</html>');

  // Without the cookie the WebSocket is refused; with it, bytes reach the VNC port and back.
  await assert.rejects(
    new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://localhost:${http.port}/desk/websockify`, ['binary']);
      ws.on('open', resolve);
      ws.on('error', reject);
    })
  );
  const echoed = await new Promise<string>((resolve, reject) => {
    const ws = new WebSocket(`ws://localhost:${http.port}/desk/websockify`, ['binary'], { headers: { cookie } });
    ws.on('open', () => ws.send(Buffer.from('RFB 003.008\n')));
    ws.on('message', (data) => {
      resolve(data.toString());
      ws.close();
    });
    ws.on('error', reject);
  });
  assert.equal(echoed, 'RFB 003.008\n');
});
