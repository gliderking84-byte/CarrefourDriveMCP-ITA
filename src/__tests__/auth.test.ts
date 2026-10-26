import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SessionService } from '../services/session.service.js';
import { parseUserLogged } from '../services/auth.service.js';
import { redactUrl } from '../services/http.service.js';

const dir = mkdtempSync(join(tmpdir(), 'carrefour-auth-test-'));

beforeEach(() => {
  process.env.CARREFOUR_SESSION_FILE = join(dir, 'cookies.json');
  delete process.env.CARREFOUR_COOKIES;
  delete process.env.CARREFOUR_COOKIE_FILE;
});

after(() => rmSync(dir, { recursive: true, force: true }));

test('parseUserLogged reads the flag from the JSON-escaped Store-SelectionBar markup', () => {
  const body = JSON.stringify({ storeSelectionBar: '<div data-option-timeslot-enabled="true" data-option-user-logged="true">' });
  assert.equal(parseUserLogged(body), true);
  assert.equal(parseUserLogged('<div data-option-user-logged="false">'), false);
  assert.equal(parseUserLogged('{"storeSelectionBar":""}'), null);
});

test('redactUrl keeps CSRF tokens out of logged URLs', () => {
  assert.equal(
    redactUrl('https://www.carrefour.it/cart/updatequantity?pid=1&csrf_token=SECRET%3D&decrease=false'),
    'https://www.carrefour.it/cart/updatequantity?pid=1&csrf_token=<redacted>&decrease=false'
  );
  assert.equal(redactUrl('https://www.carrefour.it/cart'), 'https://www.carrefour.it/cart');
});

test('the jar exports cookies in the shape Playwright expects', () => {
  process.env.CARREFOUR_SESSION_FILE = join(dir, 'export.json');
  const session = new SessionService();
  session.importCookies('[{"name":"dwsid","value":"a","domain":"www.carrefour.it","path":"/"}]');
  session.importCookies('plain=b');

  const exported = session.toPlaywrightCookies();
  const byName = Object.fromEntries(exported.map((c) => [c.name, c]));
  assert.equal(byName.dwsid.domain, 'www.carrefour.it');
  assert.equal(byName.plain.domain, 'www.carrefour.it', 'cookies without a domain default to the storefront');
  for (const cookie of exported) {
    assert.equal(typeof cookie.path, 'string');
    assert.equal(typeof cookie.secure, 'boolean');
    assert.equal(typeof cookie.expires, 'number');
  }
});
