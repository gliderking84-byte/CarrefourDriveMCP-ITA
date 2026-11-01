import { randomBytes } from 'crypto';
import { existsSync } from 'fs';
import { connect } from 'net';
import type { IncomingMessage, Server } from 'http';
import type { Duplex } from 'stream';
import express, { type Express, type Request, type Response, type NextFunction } from 'express';
import { WebSocketServer } from 'ws';
import { page, passphraseMatches } from './oauth.js';
import { logger } from '../utils/logger.js';

/**
 * The "desk": the server's own screen, in a browser tab, through noVNC.
 *
 * Signing in to carrefour.it (captcha) or to Google the first time needs a
 * human in front of a real browser window. In a container that window lives on
 * a virtual display (Xvfb), exported by x11vnc on localhost only; this module
 * serves noVNC behind the owner's passphrase and proxies its WebSocket to that
 * VNC port, so the display is reachable only through this authenticated route.
 */

const COOKIE = 'desk_session';
const SESSION_TTL_MS = 12 * 60 * 60_000;

/** Failed passphrase attempts per client address, shared by the consent page and the desk. */
export class AttemptLimiter {
  private failures = new Map<string, { count: number; since: number }>();
  constructor(
    private readonly max = 10,
    private readonly windowMs = 15 * 60_000
  ) {}

  blocked(key: string): boolean {
    const entry = this.failures.get(key);
    if (!entry) return false;
    if (Date.now() - entry.since > this.windowMs) {
      this.failures.delete(key);
      return false;
    }
    return entry.count >= this.max;
  }

  fail(key: string): void {
    const entry = this.failures.get(key);
    if (!entry || Date.now() - entry.since > this.windowMs) this.failures.set(key, { count: 1, since: Date.now() });
    else entry.count += 1;
  }

  reset(key: string): void {
    this.failures.delete(key);
  }
}

export interface DeskOptions {
  passphrase: string;
  limiter: AttemptLimiter;
  /** Directory holding noVNC's vnc.html (Debian: /usr/share/novnc). */
  novncDir: string;
  vncPort: number;
  secureCookies: boolean;
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return undefined;
}

export function deskAvailable(novncDir: string | undefined): novncDir is string {
  return !!novncDir && existsSync(`${novncDir}/vnc.html`);
}

/** Mount /desk on `app` and the noVNC WebSocket proxy on `server`. */
export function mountDesk(app: Express, server: Server, opts: DeskOptions): void {
  const sessions = new Map<string, number>(); // token -> expiry

  const valid = (req: IncomingMessage) => {
    const tokenValue = cookieValue(req, COOKIE);
    const expiry = tokenValue ? sessions.get(tokenValue) : undefined;
    if (!tokenValue || !expiry) return false;
    if (expiry < Date.now()) {
      sessions.delete(tokenValue);
      return false;
    }
    return true;
  };

  const loginPage = (error?: string) =>
    page(
      'Schermo del server',
      `<h1>Schermo del server</h1>
<p>Da qui vedi il browser del server, per accedere a carrefour.it o a Google la prima volta.</p>
${error ? `<p class="err">${error}</p>` : ''}
<form method="post" action="/desk/login">
<input type="password" name="passphrase" placeholder="Passphrase del server" autocomplete="current-password" required autofocus>
<button type="submit">Apri</button></form>`
    );

  const viewer = '/desk/vnc.html?path=desk/websockify&autoconnect=1&resize=remote&reconnect=1';

  app.get('/desk', (req, res) => {
    if (valid(req)) return res.redirect(302, viewer);
    res.status(200).type('html').send(loginPage());
  });

  app.post('/desk/login', express.urlencoded({ extended: false }), (req: Request, res: Response) => {
    const ip = req.ip ?? 'unknown';
    if (opts.limiter.blocked(ip)) {
      return res.status(429).type('html').send(loginPage('Troppi tentativi: riprova tra qualche minuto.'));
    }
    if (!passphraseMatches(String(req.body?.passphrase ?? ''), opts.passphrase)) {
      opts.limiter.fail(ip);
      return res.status(401).type('html').send(loginPage('Passphrase errata.'));
    }
    opts.limiter.reset(ip);
    const tokenValue = randomBytes(32).toString('base64url');
    sessions.set(tokenValue, Date.now() + SESSION_TTL_MS);
    res.cookie(COOKIE, tokenValue, {
      httpOnly: true,
      secure: opts.secureCookies,
      sameSite: 'strict',
      path: '/desk',
      maxAge: SESSION_TTL_MS,
    });
    res.redirect(302, viewer);
  });

  const requireDesk = (req: Request, res: Response, next: NextFunction) => {
    if (valid(req)) return next();
    res.redirect(302, '/desk');
  };
  app.use('/desk', requireDesk, express.static(opts.novncDir, { index: false }));

  // noVNC speaks raw VNC over a binary WebSocket: pipe it to x11vnc on localhost.
  const wss = new WebSocketServer({
    noServer: true,
    handleProtocols: (protocols) => (protocols.has('binary') ? 'binary' : false),
  });
  server.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (!req.url?.startsWith('/desk/websockify')) return;
    if (!valid(req)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      const vnc = connect(opts.vncPort, '127.0.0.1');
      vnc.on('data', (chunk) => ws.send(chunk));
      vnc.on('close', () => ws.close());
      vnc.on('error', (error) => {
        logger.error('Desk: VNC connection failed', { error: String(error) });
        ws.close();
      });
      ws.on('message', (data) => vnc.write(data as Buffer));
      ws.on('close', () => vnc.destroy());
    });
  });
}
