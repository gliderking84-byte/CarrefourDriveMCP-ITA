import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { sessionService, NO_SESSION_MESSAGE } from '../services/session.service.js';
import { forgetLoginState, isLoggedIn } from '../services/auth.service.js';
import { browserLogin, isPlaywrightAvailable } from '../services/browser-login.js';
import { browserService } from '../services/browser.service.js';

function text(body: string, isError = false) {
  return { content: [{ type: 'text' as const, text: body }], isError };
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
      if (!status.authenticated) return text(NO_SESSION_MESSAGE, true);

      const browser = browserService.describe();
      let line =
        `Session present: ${status.cookieCount} cookie(s) [${status.cookies.join(', ')}]\n` +
        `File: ${status.sessionFile}\nBrowser profile: ${browser.profile} (${browser.running ? 'running' : 'stopped'})`;

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
        'The login cannot be automated: Cloudflare Turnstile refuses to validate in a driven browser.',
      {},
      async () => {
        try {
          return text(await browserLogin({}));
        } catch (error) {
          return text(`Browser login failed: ${(error as Error).message}`, true);
        }
      }
    );
  }
}
