import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChromeBackend } from '../dist/browser/chromium/chrome.js';
import { errorResult } from '../dist/core/errors.js';

class Page extends EventEmitter {
  constructor(url, loggedIn = false) {
    super();
    this.address = url;
    this.loggedIn = loggedIn;
    this.closed = false;
    this.evaluations = [];
    this.fronts = 0;
    this.closes = 0;
    this.frame = {};
  }
  isClosed() { return this.closed; }
  url() { return this.address; }
  mainFrame() { return this.frame; }
  async evaluate(_fn, args) {
    this.evaluations.push(args);
    return args ? { status: 200, data: { page: this.address } } : this.loggedIn;
  }
  async bringToFront() { this.fronts++; }
  async goto(url) { this.navigate(url); }
  navigate(url) { this.address = url; this.emit('framenavigated', this.frame); }
  closeByUser() { this.closed = true; this.emit('close'); }
  async close() { this.closes++; this.closeByUser(); }
}

function fixture(pages = []) {
  const context = new EventEmitter();
  context.closes = 0;
  context.created = 0;
  context.pages = () => [...pages];
  context.newPage = async () => { context.created++; const page = new Page('about:blank'); pages.push(page); return page; };
  context.close = async () => { context.closes++; };
  const browser = new EventEmitter();
  browser.connected = true;
  browser.closes = 0;
  browser.isConnected = () => browser.connected;
  browser.contexts = () => [context];
  browser.close = async () => { browser.closes++; browser.connected = false; browser.emit('disconnected'); };
  let connections = 0;
  const saved = [];
  const backend = new ChromeBackend('unused', { save: async (...args) => saved.push(args) }, async () => { connections++; return browser; });
  return { backend, browser, context, saved, connections: () => connections };
}

test('Chrome status and requests do not connect or create tabs implicitly', async () => {
  const { backend, context, connections } = fixture();
  const status = await backend.status();
  assert.equal(status.transport, 'chrome');
  assert.equal(status.browser_open, false);
  assert.equal(status.logged_in, false);
  assert.match(status.action, /chatgpt_open_browser/);
  await assert.rejects(backend.request({ path: '/backend-api/conversations' }), { code: 'LOGIN_REQUIRED' });
  assert.equal(connections(), 0);
  assert.equal(context.created, 0);
});

test('Chrome selects a logged-in ChatGPT page and leaves other sites unobserved', async () => {
  const other = new Page('https://example.com', true);
  const loggedOut = new Page('https://chatgpt.com/', false);
  const loggedIn = new Page('https://chatgpt.com/c/one', true);
  const { backend, context, connections } = fixture([other, loggedOut, loggedIn]);
  await Promise.all([backend.open(), backend.open(), backend.open()]);
  assert.equal(connections(), 1);
  assert.equal(backend.page, loggedIn);
  assert.equal(loggedIn.fronts, 1);
  assert.equal(other.evaluations.length, 0);
  assert.equal(other.eventNames().length, 0);
  assert.equal(loggedOut.eventNames().length, 0);
  assert.equal(context.eventNames().length, 0);
  assert.equal(context.created, 0);
  assert.equal((await backend.status()).logged_in, true);
  assert.deepEqual(await backend.request({ path: '/backend-api/conversations' }), { page: loggedIn.address });
  loggedIn.closeByUser();
  loggedOut.loggedIn = true;
  await backend.request({ path: '/backend-api/conversations' });
  assert.equal(backend.page, loggedOut);
  assert.equal(loggedIn.eventNames().length, 0);
  await backend.close();
});

test('Chrome creates a ChatGPT tab only during explicit open and reports login state', async () => {
  const other = new Page('https://example.com');
  const { backend, context } = fixture([other]);
  await backend.open();
  assert.equal(context.created, 1);
  assert.equal(backend.page.url(), 'https://chatgpt.com');
  const status = await backend.status();
  assert.equal(status.browser_open, true);
  assert.equal(status.logged_in, false);
  assert.match(status.action, /日常 Chrome/);
  assert.equal(other.evaluations.length, 0);
  await backend.close();
});

test('Chrome finds a logged-in ninth ChatGPT tab instead of ignoring later candidates', async () => {
  const pages = Array.from({ length: 8 }, (_, index) => new Page(`https://chatgpt.com/c/logged-out-${index}`));
  const loggedIn = new Page('https://chatgpt.com/c/logged-in', true);
  const { backend, context } = fixture([...pages, loggedIn]);
  try {
    await backend.open();
    assert.equal(backend.page, loggedIn);
    assert.equal((await backend.status()).logged_in, true);
    assert.equal(context.created, 0);
    assert.equal(loggedIn.fronts, 1);
  } finally { await backend.close(); }
});

test('Chrome login checks guard against navigation between selecting and evaluating a page', async () => {
  const page = new Page('https://chatgpt.com/', true);
  page.evaluate = fn => fn();
  const { backend } = fixture([page]);
  const originalLocation = globalThis.location;
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.location = { origin: 'https://example.com' };
  globalThis.fetch = async () => { requests++; throw new Error('Must not fetch on another site'); };
  try {
    await backend.open();
    assert.equal((await backend.status()).logged_in, false);
    assert.equal(requests, 0);
  } finally {
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
    globalThis.fetch = originalFetch;
    await backend.close();
  }
});

test('Chrome recording captures only the selected page and stays pinned when it leaves ChatGPT', async () => {
  const selected = new Page('https://chatgpt.com/c/one', true);
  const other = new Page('https://chatgpt.com/c/two', true);
  const { backend, saved } = fixture([selected, other]);
  await backend.startRecording('rename_project', { project_id: 'g-p-one', name: 'new' });
  const response = {
    ok: () => true,
    request: () => ({ url: () => 'https://chatgpt.com/backend-api/gizmos/g-p-one', postData: () => '{"name":"new"}', method: () => 'PATCH' }),
  };
  other.emit('response', response);
  assert.equal(backend.recording.candidates.length, 0);
  selected.emit('response', response);
  assert.equal(backend.recording.candidates.length, 1);
  selected.navigate('https://example.com');
  selected.navigate('https://chatgpt.com/c/one');
  await assert.rejects(backend.request({ path: '/backend-api/conversations' }), { code: 'RECORDING_PAGE_CHANGED' });
  await assert.rejects(backend.open(), { code: 'RECORDING_PAGE_CHANGED' });
  await assert.rejects(backend.finishRecording(), { code: 'RECORDING_PAGE_CHANGED' });
  assert.equal(other.evaluations.length, 0);
  assert.equal(saved.length, 0);
  assert.deepEqual(await backend.finishRecording(undefined, true), { cancelled: true });
  selected.closeByUser();
  await backend.request({ path: '/backend-api/conversations' });
  assert.equal(backend.page, other);
  await backend.close();
});

test('Chrome disconnection clears account and recording state without reconnecting requests', async () => {
  const page = new Page('https://chatgpt.com/', true);
  const { backend, browser, connections } = fixture([page]);
  await backend.startRecording('list_projects', {});
  page.emit('request', { url: () => 'https://chatgpt.com/backend-api/gizmos', headers: () => ({ 'chatgpt-account-id': 'workspace-one' }) });
  assert.equal(backend.accountHeader, 'workspace-one');
  browser.connected = false;
  browser.emit('disconnected');
  assert.equal(backend.accountHeader, undefined);
  assert.equal(backend.recording, null);
  assert.equal(backend.page, null);
  assert.equal(page.eventNames().length, 0);
  assert.equal((await backend.status()).browser_open, false);
  await assert.rejects(backend.request({ path: '/backend-api/conversations' }), { code: 'LOGIN_REQUIRED' });
  assert.equal(connections(), 1);
});

test('Chrome close only disconnects the CDP browser and preserves user pages and context', async () => {
  const page = new Page('https://chatgpt.com/', true);
  const { backend, browser, context } = fixture([page]);
  await backend.open();
  await backend.close();
  await backend.close();
  assert.equal(browser.closes, 1);
  assert.equal(context.closes, 0);
  assert.equal(page.closes, 0);
  assert.equal(page.isClosed(), false);
  assert.equal(page.eventNames().length, 0);
  assert.equal(browser.eventNames().length, 0);
});

test('Chrome login exposes a generic close handle and keeps user pages after disconnect', async () => {
  const page = new Page('https://chatgpt.com/', true);
  const { backend, browser, context } = fixture([page]);
  const login = await backend.login();
  assert.equal(typeof login.instruction, 'string');
  await backend.close();
  await login.closed;
  assert.equal(browser.closes, 1);
  assert.equal(context.closes, 0);
  assert.equal(page.closes, 0);
});

test('Chrome connection errors give setup guidance without exposing endpoints or raw errors', async () => {
  const backend = new ChromeBackend('unused', {}, async () => { throw new Error('ws://private-endpoint/secret'); });
  await assert.rejects(backend.open(), error => {
    const result = errorResult(error);
    assert.equal(result.code, 'BROWSER_UNAVAILABLE');
    assert.match(result.message, /chrome:\/\/inspect\/#remote-debugging/);
    assert.equal(JSON.stringify(result).includes('private-endpoint'), false);
    return true;
  });
  assert.equal((await backend.status()).browser_open, false);
});
