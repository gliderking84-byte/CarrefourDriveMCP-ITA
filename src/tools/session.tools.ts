import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sessionService, NO_SESSION_MESSAGE } from '../services/session.service.js';
import { forgetLoginState, isLoggedIn } from '../services/auth.service.js';
import { isPlaywrightAvailable, loginState, startBrowserLogin } from '../services/browser-login.js';
import { browserService } from '../services/browser.service.js';

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
}

/** How long carrefour_browser_login holds the call open before handing the login to the background. */
const LOGIN_WAIT_MS = parseInt(process.env.CARREFOUR_LOGIN_WAIT_MS || '45000', 10);
const PROGRESS_EVERY_MS = 5000;

const WINDOW_OPEN_MESSAGE =
  'A browser window is open on carrefour.it/login. Sign in there and leave it open: it closes by ' +
  'itself once the session is captured. Then run carrefour_session_status with verify=true to confirm.';

function loginStateLine(): string {
  const state = loginState();
  if (state.inProgress) {
    return `\nLogin window: open since ${state.startedAt!.toLocaleTimeString()}, waiting for you to sign in.`;
  }
  return state.lastResult ? `\nLast login: ${state.lastResult}` : '';
}

export function registerSessionTools(server: McpServer): void {
  server.tool(
    'carrefour_set_cookies',
    'Store your www.carrefour.it session cookies so the other tools can act on your account. ' +
      'Accepts a raw cookie header ("a=1; b=2"), a JSON map, or a JSON array export ' +
      '(Playwright / EditThisCookie / DevTools). Get them from DevTools (F12) > Application > Cookies > https://www.carrefour.it.',
    {
      cookies: z.string().describe('Cookies as a header string, a JSON object, or a JSON array of cookie objects.'),
    },
    async ({ cookies }) => {
      const stored = sessionService.importCookies(cookies);
      if (stored === 0) {
        return text('No usable cookie found in the provided value.', true);
      }
      // The running browser was seeded with the old jar.
      await browserService.close();
      forgetLoginState();
      const status = sessionService.status();
      return text(
        `Stored ${stored} cookie(s). Session file: ${status.sessionFile}\n` +
          `Cookies: ${status.cookies.join(', ')}\n` +
          'Run carrefour_session_status with verify=true to check that carrefour.it sees you as signed in.'
      );
    }
  );

  server.tool(
    'carrefour_session_status',
    'Report whether a Carrefour session is stored locally, and optionally verify it against the site.',
    {
      verify: z
        .boolean()
        .optional()
        .describe('If true, asks carrefour.it whether the session belongs to a signed-in customer.'),
    },
    async ({ verify }) => {
      const status = sessionService.status();
      if (!status.authenticated) {
        return loginState().inProgress ? text(loginStateLine().trim()) : text(NO_SESSION_MESSAGE, true);
      }

      const browser = browserService.describe();
      let line =
        `Session present: ${status.cookieCount} cookie(s) [${status.cookies.join(', ')}]\n` +
        `File: ${status.sessionFile}\nBrowser profile: ${browser.profile} (${browser.running ? 'running' : 'stopped'})` +
        loginStateLine();

      if (verify) {
        try {
          const logged = await isLoggedIn({ fresh: true });
          line +=
            logged === true
              ? '\nVerification: signed in.'
              : logged === false
                ? '\nVerification: FAILED — carrefour.it treats this session as a guest. Sign in again.'
                : '\nVerification: inconclusive — the login flag was missing from the response.';
        } catch (error) {
          line += `\nVerification: could not reach carrefour.it (${(error as Error).message})`;
        }
      }
      return text(line);
    }
  );

  server.tool('carrefour_clear_session', 'Delete the locally stored Carrefour cookies.', {}, async () => {
    await browserService.close();
    sessionService.clear();
    forgetLoginState();
    return text('Session cleared. Sign in again with carrefour_browser_login or carrefour_set_cookies.');
  });

  // Optional convenience: only exposed when playwright happens to be installed.
  if (isPlaywrightAvailable()) {
    server.tool(
      'carrefour_browser_login',
      'Opens a browser window on carrefour.it so you can sign in. Solve the captcha and sign in; ' +
        'leave the window open — it closes by itself once the session is captured. ' +
        'Returns after at most ~45 s even if you are still signing in: the login then completes in the ' +
        'background, and carrefour_session_status reports it. ' +
        'The login cannot be automated: Cloudflare Turnstile refuses to validate in a driven browser.',
      {},
      async (_args, extra) => {
        const login = startBrowserLogin({});
        const progressToken = extra._meta?.progressToken;

        // Progress notifications keep clients that reset their timeout on progress from giving up.
        let ticks = 0;
        const ticker = setInterval(() => {
          ticks += 1;
          if (progressToken === undefined) return;
          extra
            .sendNotification({
              method: 'notifications/progress',
              params: { progressToken, progress: ticks, message: 'Waiting for you to sign in on carrefour.it…' },
            })
            .catch(() => undefined);
        }, PROGRESS_EVERY_MS);

        let timer: NodeJS.Timeout | undefined;
        const timeout = new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), LOGIN_WAIT_MS);
        });
        const cancelled = new Promise<null>((resolve) => extra.signal.addEventListener('abort', () => resolve(null)));

        try {
          const result = await Promise.race([login.done, timeout, cancelled]);
          if (result !== null) return text(result, result.startsWith('Browser login failed'));
          return text(login.alreadyRunning ? `Still waiting. ${WINDOW_OPEN_MESSAGE}` : WINDOW_OPEN_MESSAGE);
        } finally {
          clearInterval(ticker);
          clearTimeout(timer);
        }
      }
    );
  }
}
