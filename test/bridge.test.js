import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { randomUUID } from 'node:crypto';
import { ExtensionBridge } from '../dist/browser/extension/bridge.js';
import { pageTask } from '../extension/page.js';
import vm from 'node:vm';

test('compiled page task runs without module scope when injected into a tab', async () => {
  const calls = [];
  const injected = vm.runInNewContext(`(${pageTask.toString()})`, {
    location: { origin: 'https://chatgpt.com' }, URL, AbortSignal,
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return String(url) === '/api/auth/session'
        ? Response.json({ accessToken: 'browser-only-token' }) : Response.json({ ok: true });
    },
  });
  const result = await injected(JSON.stringify({ type: 'request', request: {
    method: 'PATCH', path: '/backend-api/projects/example',
    body: { name: 'example', emoji: null, theme: null },
  } }));
  assert.equal(result.status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).init.body), { name: 'example', emoji: null, theme: null });
  assert.equal(JSON.stringify(result).includes('browser-only-token'), false);
});

async function bridgeFixture(t, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'organizer-bridge-'));
  const bridge = new ExtensionBridge(dir, { port: 0, pollTimeout: 50, commandTimeout: 150, ...options });
  await bridge.start();
  t.after(async () => { await bridge.close(); await rm(dir, { recursive: true, force: true }); });
  const config = JSON.parse(await readFile(bridge.configFile, 'utf8'));
  const headers = { authorization: `Bearer ${config.token}`, 'x-chatgpt-organizer-client': randomUUID() };
  return { bridge, config, headers };
}

function bridgeRequest(url, method, headers) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: JSON.parse(body) }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('the installed extension pairs automatically, then authenticates commands with the persisted token', async t => {
  const { bridge, config } = await bridgeFixture(t);
  assert.match(bridge.extensionOrigin, /^chrome-extension:\/\/[a-p]{32}$/);
  const pairingHeaders = { origin: bridge.extensionOrigin, 'x-chatgpt-organizer': '1', 'x-chatgpt-organizer-client': randomUUID() };
  const paired = await bridgeRequest(config.url + '/pair', 'POST', pairingHeaders);
  assert.equal(paired.status, 200);
  assert.deepEqual(paired.body, config);
  assert.equal(paired.headers['access-control-allow-origin'], undefined);
  assert.equal(paired.headers['cache-control'], 'no-store');
  assert.equal(bridge.connected, false);
  assert.equal((await fetch(config.url + '/poll', { headers: pairingHeaders })).status, 403);
  const authenticated = { ...pairingHeaders, authorization: `Bearer ${paired.body.token}` };
  assert.equal((await fetch(config.url + '/poll', { headers: authenticated })).status, 200);
  assert.equal(bridge.connected, true);
  const pairedAgain = await bridgeRequest(config.url + '/pair', 'POST', pairingHeaders);
  assert.deepEqual(pairedAgain.body, config);
  await bridge.close();
  await bridge.start();
  const afterRestart = await bridgeRequest(bridge.url + '/pair', 'POST', pairingHeaders);
  assert.equal(afterRestart.body.token, config.token);
});

test('automatic pairing rejects websites, untrusted extensions, missing headers, wrong hosts and preflights', async t => {
  const { bridge, config, headers } = await bridgeFixture(t);
  const trusted = { origin: bridge.extensionOrigin, 'x-chatgpt-organizer': '1', 'x-chatgpt-organizer-client': randomUUID() };
  const otherExtension = bridge.extensionOrigin === `chrome-extension://${'a'.repeat(32)}`
    ? `chrome-extension://${'b'.repeat(32)}` : `chrome-extension://${'a'.repeat(32)}`;
  const denied = [
    ['POST', { 'x-chatgpt-organizer': '1' }],
    ['POST', { ...trusted, origin: 'null' }],
    ['POST', { ...trusted, origin: 'https://chatgpt.com' }],
    ['POST', { ...trusted, origin: 'http://127.0.0.1' }],
    ['POST', { ...trusted, origin: otherExtension }],
    ['POST', { ...trusted, ...headers, origin: otherExtension }],
    ['POST', { ...trusted, origin: `${bridge.extensionOrigin}/` }],
    ['POST', { origin: bridge.extensionOrigin }],
    ['POST', { origin: bridge.extensionOrigin, 'x-chatgpt-organizer': '1' }],
    ['POST', { ...trusted, 'x-chatgpt-organizer-client': 'not-a-uuid' }],
    ['POST', { ...trusted, 'x-chatgpt-organizer': '0' }],
    ['POST', { ...trusted, host: `localhost:${bridge.port}` }],
    ['POST', { ...trusted, host: '127.0.0.1' }],
    ['POST', { ...trusted, host: `127.0.0.1:${bridge.port + 1}` }],
    ['GET', trusted],
    ['OPTIONS', { ...trusted, 'access-control-request-method': 'POST' }],
  ];
  for (const [method, candidateHeaders] of denied) {
    const response = await bridgeRequest(config.url + '/pair', method, candidateHeaders);
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'forbidden' });
    assert.equal(response.headers['access-control-allow-origin'], undefined);
    assert.equal(response.headers['access-control-allow-headers'], undefined);
  }
  assert.equal(bridge.connected, false);
});

test('paired browser profiles cannot exchange commands even when the bearer token is the same', async t => {
  const { bridge, config, headers } = await bridgeFixture(t, { commandTimeout: 2000 });
  const first = { origin: bridge.extensionOrigin, 'x-chatgpt-organizer': '1', 'x-chatgpt-organizer-client': randomUUID() };
  const second = { ...first, 'x-chatgpt-organizer-client': randomUUID() };
  assert.equal((await bridgeRequest(config.url + '/pair', 'POST', first)).status, 200);
  const rejectedPair = await bridgeRequest(config.url + '/pair', 'POST', second);
  assert.equal(rejectedPair.status, 409);
  assert.deepEqual(rejectedPair.body, { error: 'bridge_in_use' });
  assert.equal((await bridgeRequest(config.url + '/pair', 'POST', first)).status, 200);

  const ownerHeaders = { ...headers, ...first };
  const otherHeaders = { ...headers, ...second };
  await fetch(config.url + '/poll', { headers: ownerHeaders });
  const pending = bridge.call({ type: 'status' });
  assert.equal((await fetch(config.url + '/poll', { headers: otherHeaders })).status, 403);
  assert.equal((await fetch(config.url + '/poll', { headers })).status, 403);
  const { command } = await (await fetch(config.url + '/poll', { headers: ownerHeaders })).json();
  assert.equal(command.type, 'status');
  const body = JSON.stringify({ id: command.id, result: { logged_in: true } });
  assert.equal((await fetch(config.url + '/result', { method: 'POST', headers: otherHeaders, body })).status, 403);
  assert.equal(bridge.pending.has(command.id), true);
  let captured = false;
  bridge.onCapture = async () => { captured = true; };
  assert.equal((await fetch(config.url + '/capture', { method: 'POST', headers: otherHeaders, body: '{}' })).status, 403);
  assert.equal(captured, false);
  assert.equal((await fetch(config.url + '/result', { method: 'POST', headers: ownerHeaders, body })).status, 200);
  assert.deepEqual(await pending, { logged_in: true });

  // A new server instance can select a new profile; ownership is not persisted.
  await bridge.close();
  const restarted = new ExtensionBridge(bridge.directory, { port: 0, pollTimeout: 10 });
  t.after(() => restarted.close());
  await restarted.start();
  assert.equal((await bridgeRequest(restarted.url + '/pair', 'POST', second)).status, 200);
  assert.equal((await bridgeRequest(restarted.url + '/pair', 'POST', first)).status, 409);
});

test('a cached token claims its browser profile before polling and rejects competing profiles', async t => {
  const { bridge, config, headers } = await bridgeFixture(t, { commandTimeout: 2000 });
  const secondClientId = randomUUID();
  const otherHeaders = { ...headers, 'x-chatgpt-organizer-client': secondClientId };
  // Neither an old extension without client ID nor an invalid token can claim it.
  assert.equal((await fetch(config.url + '/poll', { headers: { authorization: headers.authorization } })).status, 403);
  assert.equal((await fetch(config.url + '/poll', { headers: { ...otherHeaders, authorization: 'Bearer wrong' } })).status, 403);
  assert.equal((await fetch(config.url + '/poll', { headers })).status, 200);
  const pending = bridge.call({ type: 'status' });
  assert.equal((await fetch(config.url + '/poll', { headers: otherHeaders })).status, 403);
  const refusedPair = await bridgeRequest(config.url + '/pair', 'POST', {
    origin: bridge.extensionOrigin, 'x-chatgpt-organizer': '1', 'x-chatgpt-organizer-client': secondClientId,
  });
  assert.equal(refusedPair.status, 409);
  const { command } = await (await fetch(config.url + '/poll', { headers })).json();
  assert.equal(command.type, 'status');
  const body = JSON.stringify({ id: command.id, result: { browser_open: true } });
  assert.equal((await fetch(config.url + '/result', { method: 'POST', headers: otherHeaders, body })).status, 403);
  assert.equal((await fetch(config.url + '/result', { method: 'POST', headers, body })).status, 200);
  assert.deepEqual(await pending, { browser_open: true });
});

test('bridge denies unauthenticated requests and website origins even with a valid token', async t => {
  const { bridge, config, headers } = await bridgeFixture(t);
  assert.equal(bridge.server.address().address, '127.0.0.1');
  assert.equal((await fetch(config.url + '/poll')).status, 403);
  assert.equal((await fetch(config.url + '/poll', { headers: { ...headers, Origin: 'https://evil.invalid' } })).status, 403);
  assert.equal((await fetch(config.url + '/poll', { headers: { authorization: 'Bearer wrong' } })).status, 403);
  await assert.rejects(bridge.call({ type: 'status' }), { code: 'EXTENSION_NOT_CONNECTED' });
});

test('bridge dispatches a command once and accepts only its matching result', async t => {
  const { bridge, config, headers } = await bridgeFixture(t);
  await fetch(config.url + '/poll', { headers });
  const pending = bridge.call({ type: 'status' });
  const response = await fetch(config.url + '/poll', { headers });
  const { command } = await response.json();
  assert.equal(command.type, 'status');
  const duplicate = await fetch(config.url + '/poll', { headers });
  assert.equal((await duplicate.json()).command, null);
  const result = await fetch(config.url + '/result', { method: 'POST', headers, body: JSON.stringify({ id: command.id, result: { logged_in: true } }) });
  assert.equal(result.status, 200);
  assert.deepEqual(await pending, { logged_in: true });
  const replay = await fetch(config.url + '/result', { method: 'POST', headers, body: JSON.stringify({ id: command.id, result: {} }) });
  assert.equal(replay.status, 409);
});

test('uncertain command expires without being replayed', async t => {
  const { bridge, config, headers } = await bridgeFixture(t, { commandTimeout: 40, pollTimeout: 5 });
  await fetch(config.url + '/poll', { headers });
  const pending = bridge.call({ type: 'request' });
  const rejected = assert.rejects(pending, { code: 'REQUEST_UNCERTAIN' });
  await fetch(config.url + '/poll', { headers });
  await rejected;
  assert.equal(bridge.pending.size, 0);
  assert.equal((await (await fetch(config.url + '/poll', { headers })).json()).command, null);
});

test('extension page keeps login token local and rejects cross-origin backend targets', async () => {
  const previousFetch = globalThis.fetch; const previousLocation = globalThis.location;
  globalThis.location = { origin: 'https://chatgpt.com' };
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url: String(url), init });
    return String(url) === '/api/auth/session' ? Response.json({ accessToken: 'private-token' }) : Response.json({ items: [] });
  };
  try {
    assert.deepEqual(await pageTask({ type: 'status' }), { browser_open: true, logged_in: true });
    const result = await pageTask({ type: 'request', request: { path: '/backend-api/conversations', method: 'GET' } });
    assert.equal(result.status, 200); assert.equal(JSON.stringify(result).includes('private-token'), false);
    await pageTask(JSON.stringify({ type: 'request', request: { path: '/backend-api/projects/example', method: 'PATCH', body: { name: 'new', instructions: '', emoji: null, theme: null } } }));
    assert.deepEqual(JSON.parse(calls.at(-1).init.body), { name: 'new', instructions: '', emoji: null, theme: null });
    assert.equal((await pageTask({ type: 'request', request: { path: 'https://evil.invalid/backend-api/conversations' } })).status, 403);
    assert.equal(calls.some(call => call.url.includes('evil.invalid')), false);
  } finally { globalThis.fetch = previousFetch; globalThis.location = previousLocation; }
});

test('validation diagnostics expose field locations without error messages or input values', async () => {
  const previousFetch = globalThis.fetch; const previousLocation = globalThis.location;
  globalThis.location = { origin: 'https://chatgpt.com' };
  globalThis.fetch = async url => String(url) === '/api/auth/session' ? Response.json({ accessToken: 'private-token' })
    : Response.json({ detail: [{ loc: ['header', 'example'], type: 'missing', msg: 'private-message', input: 'private-input' }] }, { status: 422 });
  try {
    const result = await pageTask({ type: 'request', request: { path: '/backend-api/projects/example', method: 'PATCH', body: { name: 'new' } } });
    assert.deepEqual(result.validation, [{ location: ['header', 'example'], type: 'missing' }]);
    assert.equal(JSON.stringify(result).includes('private'), false);
  } finally { globalThis.fetch = previousFetch; globalThis.location = previousLocation; }
});
