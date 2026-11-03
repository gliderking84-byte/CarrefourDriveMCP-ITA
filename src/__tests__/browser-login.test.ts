import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLoginBrowser, loginBrowserCandidates, releaseProfileLock } from '../services/browser-login.js';

const windowsEnv = {
  PROGRAMFILES: 'C:\\Program Files',
  'PROGRAMFILES(X86)': 'C:\\Program Files (x86)',
  LOCALAPPDATA: 'C:\\Users\\me\\AppData\\Local',
};

test('Windows: an installed Chrome is preferred over Edge', () => {
  const installed = new Set([
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
  ]);
  assert.deepEqual(findLoginBrowser('win32', windowsEnv, (p) => installed.has(p)), {
    path: 'C:\\Users\\me\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe',
    label: 'Google Chrome',
  });
});

test('Windows: Edge is used when Chrome is not installed', () => {
  const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  assert.equal(findLoginBrowser('win32', windowsEnv, (p) => p === edge)?.label, 'Microsoft Edge');
});

test('no installed browser means falling back to Playwright', () => {
  assert.equal(findLoginBrowser('linux', {}, () => false), null);
  assert.ok(loginBrowserCandidates('darwin').every((b) => b.path.startsWith('/Applications/')));
});

test('CARREFOUR_LOGIN_BROWSER wins over detection', () => {
  assert.deepEqual(findLoginBrowser('linux', { CARREFOUR_LOGIN_BROWSER: '/opt/my/chrome' }, () => true), {
    path: '/opt/my/chrome',
    label: 'CARREFOUR_LOGIN_BROWSER',
  });
});

test('the login is over only once the window is back on the storefront', async () => {
  const { loggedIn, GOOGLE_LOGIN_URL } = await import('../services/browser-login.js');
  const tab = (url: string) => [{ type: 'page', url }];
  assert.equal(loggedIn(tab('https://www.carrefour.it/login?type=b2c')), false);
  assert.equal(loggedIn(tab(GOOGLE_LOGIN_URL)), false, 'the Google button URL is itself on carrefour.it');
  assert.equal(
    loggedIn(tab('https://www.carrefour.it/on/demandware.store/Sites-carrefour-IT-Site/it_IT/Login-OAuthReentry?code=x')),
    false,
    'nor is the OAuth callback'
  );
  assert.equal(loggedIn(tab('https://accounts.google.com/o/oauth2/v2/auth?client_id=x')), false);
  assert.equal(loggedIn(tab('https://www.carrefour.it/account?registration=false')), true);
  assert.equal(loggedIn(tab('https://www.carrefour.it/')), true);
  assert.equal(loggedIn([{ type: 'service_worker', url: 'https://www.carrefour.it/sw.js' }]), false);
});

test('a stuck window is reported without its query string', async () => {
  const { stopPoint } = await import('../services/browser-login.js');
  assert.equal(stopPoint('https://accounts.google.com/v3/signin/identifier?client_id=x&state=secret'), 'accounts.google.com/v3/signin/identifier');
  assert.equal(stopPoint('about:blank'), 'about:blank');
  assert.equal(stopPoint('not a url'), 'an unknown page');
});

/** A fake profile: the lock target, which pids are alive, and what got killed or removed. */
function lockScene(target: string | null, alivePids: number[] = []) {
  const killed: number[] = [];
  const removed: string[] = [];
  const deps = {
    host: 'carrefour-mcp',
    readLink: () => {
      if (target === null) throw new Error('ENOENT');
      return target;
    },
    alive: (pid: number) => alivePids.includes(pid),
    kill: (pid: number) => {
      killed.push(pid);
    },
    remove: (path: string) => {
      removed.push(path.split(/[\\/]/).pop()!);
    },
  };
  return { deps, killed, removed };
}

test('releaseProfileLock leaves an unlocked profile alone', () => {
  const { deps, killed, removed } = lockScene(null);
  assert.equal(releaseProfileLock('/data/login-profile', deps), 'none');
  assert.deepEqual([killed, removed], [[], []]);
});

test('releaseProfileLock removes a lock left by a previous container', () => {
  const { deps, killed, removed } = lockScene('4f2a9c1d7e3b-123', [123]);
  assert.equal(releaseProfileLock('/data/login-profile', deps), 'stale');
  assert.deepEqual(killed, [], 'a pid from another host means nothing here');
  assert.deepEqual(removed, ['SingletonLock', 'SingletonSocket', 'SingletonCookie']);
});

test('releaseProfileLock removes the lock of a browser that is gone', () => {
  const { deps, killed, removed } = lockScene('carrefour-mcp-456', []);
  assert.equal(releaseProfileLock('/data/login-profile', deps), 'stale');
  assert.deepEqual(killed, []);
  assert.equal(removed.length, 3);
});

test('releaseProfileLock stops a login window left open, unless told to keep it', () => {
  const stop = lockScene('carrefour-mcp-789', [789]);
  assert.equal(releaseProfileLock('/data/login-profile', stop.deps), 'stopped');
  assert.deepEqual(stop.killed, [789]);
  assert.equal(stop.removed.length, 3);

  const keep = lockScene('carrefour-mcp-789', [789]);
  assert.equal(releaseProfileLock('/data/login-profile', { ...keep.deps, stopLive: false }), 'live');
  assert.deepEqual([keep.killed, keep.removed], [[], []]);
});
