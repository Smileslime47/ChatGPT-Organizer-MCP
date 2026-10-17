import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { BrowserBackend } from '../dist/browser/chromium/browser.js';
import { errorResult } from '../dist/core/errors.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'organizer-browser-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function mockContext(page) {
  const context = new EventEmitter();
  context.closeCount = 0;
  context.pages = () => page ? [page] : [];
  context.close = async () => { context.closeCount++; context.emit('close'); };
  return context;
}

test('browser launch failure reports a safe startup error and requests the Chromium sandbox', async t => {
  const directory = await temporaryDirectory(t);
  let launches = 0;
  let launchArguments;
  const backend = new BrowserBackend(directory, {}, async (profile, options) => {
    launches++;
    launchArguments = { profile, options };
    throw new Error('launch failed: Bearer private-session');
  });
  await assert.rejects(backend.open(), error => {
    assert.equal(error.code, 'BROWSER_LAUNCH_FAILED');
    assert.equal(JSON.stringify(errorResult(error)).includes('private-session'), false);
    return true;
  });
  assert.equal(launches, 1);
  assert.equal(launchArguments.profile, join(directory, 'browser'));
  assert.equal(launchArguments.options.chromiumSandbox, true);
  assert.equal(launchArguments.options.headless, false);
  assert.equal(backend.context, null);
  assert.equal(backend.page, null);
  assert.equal(backend.opening, null);
});

test('browser page initialization failure closes the unusable context', async t => {
  const context = mockContext();
  context.newPage = async () => { throw new Error('page creation failed: private-session'); };
  const backend = new BrowserBackend(await temporaryDirectory(t), {}, async () => context);
  await assert.rejects(backend.open(), error => {
    assert.equal(error.code, 'BROWSER_LAUNCH_FAILED');
    assert.equal(JSON.stringify(errorResult(error)).includes('private-session'), false);
    return true;
  });
  assert.equal(context.closeCount, 1);
  assert.equal(backend.context, null);
  assert.equal(backend.page, null);
});

test('ChatGPT navigation failure preserves the browser for inspection and manual recovery', async t => {
  let navigations = 0;
  const page = {
    isClosed: () => false,
    url: () => 'about:blank',
    goto: async () => { navigations++; throw new Error('net::ERR_FAILED?token=private-session'); },
  };
  const context = mockContext(page);
  let launches = 0;
  const backend = new BrowserBackend(await temporaryDirectory(t), {}, async () => { launches++; return context; });
  await assert.rejects(backend.open(), error => {
    assert.equal(error.code, 'BROWSER_NAVIGATION_FAILED');
    assert.equal(JSON.stringify(errorResult(error)).includes('private-session'), false);
    return true;
  });
  assert.equal(backend.context, context);
  assert.equal(backend.page, page);
  assert.equal(context.closeCount, 0);
  assert.equal((await backend.status()).browser_open, true);
  await backend.open();
  assert.equal(launches, 1);
  assert.equal(navigations, 1);
  await backend.close();
  assert.equal(context.closeCount, 1);
  assert.equal(backend.context, null);
  assert.equal(backend.page, null);
});

test('browser transport keeps the session token inside evaluated code and does not follow redirects', async () => {
  const backend = new BrowserBackend('unused', {});
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://chatgpt.com' };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init });
    if (url === '/api/auth/session') return Response.json({ accessToken: 'never-return-this' });
    return Response.json({ items: [], total: 0 });
  };
  backend.page = { isClosed: () => false, url: () => 'https://chatgpt.com/', evaluate: (fn, args) => fn(args) };
  try {
    const result = await backend.request({ path: '/backend-api/conversations?limit=1' });
    assert.equal(JSON.stringify(result).includes('never-return-this'), false);
    assert.equal(calls[1].init.headers.authorization, 'Bearer never-return-this');
    assert.equal(calls.every(call => call.init.redirect === 'error'), true);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test('login status distinguishes signed out sessions from verification and server errors', async () => {
  const backend = new BrowserBackend('unused', {});
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  globalThis.location = { origin: 'https://chatgpt.com' };
  backend.context = {};
  backend.page = { isClosed: () => false, url: () => 'https://chatgpt.com/', evaluate: fn => fn() };
  try {
    for (const status of [200, 401, 403, 429, 500]) {
      globalThis.fetch = async () => Response.json({}, { status });
      const result = await backend.status();
      assert.equal(result.logged_in, false);
      assert.equal(result.login_check_failed === true, ![200, 401].includes(status));
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test('navigation away from ChatGPT cannot send a backend request to another origin', async () => {
  const backend = new BrowserBackend('unused', {});
  const originalFetch = globalThis.fetch;
  const originalLocation = globalThis.location;
  let calls = 0;
  globalThis.location = { origin: 'https://example.com' };
  globalThis.fetch = async () => { calls++; throw new Error('Must not fetch'); };
  backend.page = { isClosed: () => false, url: () => 'https://chatgpt.com/', evaluate: (fn, args) => fn(args) };
  try {
    await assert.rejects(backend.request({ method: 'PATCH', path: '/backend-api/conversation/one', body: { title: 'private title' } }), { code: 'LOGIN_REQUIRED' });
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalLocation === undefined) delete globalThis.location;
    else globalThis.location = originalLocation;
  }
});

test('403 and 429 produce safe explicit errors without automatic retries or response-body leakage', async () => {
  for (const status of [403, 429]) {
    const backend = new BrowserBackend('unused', {});
    let calls = 0;
    backend.page = { isClosed: () => false, url: () => 'https://chatgpt.com/', evaluate: async () => { calls++; return { status, retry_after: '15', body: 'secret' }; } };
    await assert.rejects(backend.request({ method: 'PATCH', path: '/backend-api/conversation/one', body: { title: 'new' } }), error => {
      assert.equal(error.details.status, status);
      assert.equal(JSON.stringify(errorResult(error)).includes('secret'), false);
      return true;
    });
    assert.equal(calls, 1);
  }
});

test('failed page evaluation reports uncertain outcome and later requests still work', async () => {
  const backend = new BrowserBackend('unused', {});
  backend.page = { isClosed: () => false, url: () => 'https://chatgpt.com/', evaluate: async () => { throw new Error('Bearer secret'); } };
  await assert.rejects(backend.request({ method: 'PATCH', path: '/backend-api/conversation/one' }), { code: 'REQUEST_UNCERTAIN' });
  backend.page.evaluate = async () => ({ status: 200, data: { ok: true } });
  assert.deepEqual(await backend.request({ path: '/backend-api/conversations' }), { ok: true });
});

test('recording ignores failed responses and stores a successful template without headers', async () => {
  const saved = [];
  const backend = new BrowserBackend('unused', { save: async (...args) => saved.push(args) });
  backend.recording = { operation: 'rename_project', examples: { name: 'new', project_id: 'g-p-one' }, candidates: [], started: Date.now() };
  const response = { ok: () => false, request: () => ({ url: () => 'https://chatgpt.com/backend-api/gizmos/g-p-one', postData: () => '{"name":"new"}', method: () => 'PATCH' }) };
  await backend.capture(response);
  assert.equal(backend.recording.candidates.length, 0);
  response.ok = () => true;
  await backend.capture(response);
  await backend.capture(response);
  assert.equal(backend.recording.candidates.length, 1);
  const result = await backend.finishRecording();
  assert.equal(result.saved, true); assert.equal(saved.length, 1);
  assert.equal(saved[0][1].body.name, '{{name}}'); assert.equal(backend.recording, null);
});
