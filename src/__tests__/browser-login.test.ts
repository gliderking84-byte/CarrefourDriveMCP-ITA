import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findLoginBrowser, loginBrowserCandidates } from '../services/browser-login.js';

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
