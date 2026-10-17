import test from 'node:test';
import assert from 'node:assert/strict';
import { BrowserConnection } from '../extension/connection.js';

const bridge = { version: 1, url: 'http://127.0.0.1:43127', token: 'a'.repeat(64) };
const tab = (id, extra = {}) => ({ id, url: 'https://chatgpt.com/', title: `Chat ${id}`, active: false, incognito: false, ...extra });

function mockChrome({ local = {}, session = {}, tabs = [], loggedIn = [] } = {}) {
  const calls = [];
  const listeners = {};
  const event = name => ({ addListener: listener => { listeners[name] = listener; } });
  let disconnected;
  const stopped = new Promise(resolve => { disconnected = resolve; });
  const storage = state => ({
    get: async keys => Object.fromEntries((Array.isArray(keys) ? keys : [keys]).map(key => [key, state[key]])),
    set: async data => { Object.assign(state, data); if (data.lastConnected === 0) disconnected(); },
    remove: async key => { delete state[key]; },
  });
  const chrome = {
    storage: { local: storage(local), session: storage(session) },
    tabs: {
      get: async id => { const item = tabs.find(item => item.id === id); if (!item) throw new Error('closed'); return item; },
      query: async () => [...tabs],
      create: async options => { const item = tab(100, options); tabs.push(item); calls.push({ create: options }); return item; },
      update: async (id, options) => { calls.push({ update: id, options }); return tab(id, options); },
    },
    scripting: { executeScript: async options => {
      calls.push(options);
      return [{ result: options.world === 'MAIN' ? { ok: true, captures: [] }
        : JSON.parse(options.args[0]).type === 'request' ? { status: 200, data: { ok: true } }
        : { browser_open: true, logged_in: loggedIn.includes(options.target.tabId) } }];
    } },
    webRequest: { onBeforeRequest: event('before'), onCompleted: event('completed'), onErrorOccurred: event('error') },
    action: { onClicked: event('clicked') },
    runtime: { onInstalled: event('installed'), onStartup: event('startup'), onMessage: event('message'), openOptionsPage: async () => {} },
    alarms: { create: async () => {}, onAlarm: event('alarm') },
  };
  return { chrome, local, session, tabs, calls, listeners, stopped };
}

async function withMocks(state, fetchMock, run) {
  const oldChrome = globalThis.chrome;
  const oldFetch = globalThis.fetch;
  const mock = mockChrome(state);
  globalThis.chrome = mock.chrome;
  globalThis.fetch = fetchMock;
  try { await run(mock); } finally { globalThis.chrome = oldChrome; globalThis.fetch = oldFetch; }
}

test('extension pairs automatically and keeps a stable profile identity across worker restarts', async () => {
  const requests = [];
  await withMocks({}, async (url, options) => {
    requests.push({ url, options });
    return Response.json(url.endsWith('/pair') ? bridge : { ok: true });
  }, async ({ local }) => {
    const first = new BrowserConnection();
    assert.deepEqual(await first.configuration(), bridge);
    assert.match(local.clientId, /^[0-9a-f-]{36}$/);
    const second = new BrowserConnection();
    assert.deepEqual(await second.configuration(), bridge);
    assert.equal(requests.length, 1, 'saved pairing avoids unnecessary pair requests');
    await second.request(bridge, '/result', { id: 'command', result: { ok: true } });
    assert.equal(requests[0].options.headers['x-chatgpt-organizer'], '1');
    assert.equal(requests[0].options.headers['x-chatgpt-organizer-client'], local.clientId);
    assert.equal(requests[1].options.headers['x-chatgpt-organizer-client'], local.clientId);
    assert.equal(requests[1].options.headers.authorization, `Bearer ${bridge.token}`);
    assert.equal(requests[0].options.redirect, 'error');
  });
});

test('port changes pair to the configured loopback service and reject mismatched responses', async () => {
  const custom = { ...bridge, url: 'http://127.0.0.1:45111' };
  let response = custom;
  await withMocks({ local: { bridge, bridgePort: 45111 } }, async url => {
    assert.equal(url, `${custom.url}/pair`); return Response.json(response);
  }, async () => {
    const connection = new BrowserConnection();
    assert.deepEqual(await connection.configuration(), custom);
    response = { ...bridge, url: 'https://example.com' };
    await assert.rejects(connection.configuration(true), /无效/);
  });
});

test('another browser profile cannot silently take over the service', async () => {
  await withMocks({}, async () => Response.json({ error: 'bridge_in_use' }, { status: 409 }), async () => {
    const connection = new BrowserConnection();
    await assert.rejects(connection.configuration(), /另一个浏览器/);
    assert.match((await connection.status()).message, /另一个浏览器/);
  });
});

test('automatic selection prefers a valid remembered logged-in tab and falls back after closure or logout', async () => {
  await withMocks({ session: { tabId: 1 }, local: { tabId: 2 }, tabs: [tab(1), tab(2), tab(3, { active: true }), tab(4, { active: true, incognito: true })], loggedIn: [1, 2, 3, 4] }, undefined, async mock => {
    const connection = new BrowserConnection();
    assert.equal((await connection.selectTab()).tab.id, 1);
    mock.tabs.splice(0, 1);
    assert.equal((await connection.selectTab()).tab.id, 2);
    mock.tabs.splice(0, 1);
    assert.equal((await connection.selectTab()).tab.id, 3);
    assert.equal(mock.session.tabId, 3);
    assert.equal(mock.calls.some(call => call.target?.tabId === 4), false);
  });
  await withMocks({ session: { tabId: 1 }, tabs: [tab(1, { active: true }), tab(2)], loggedIn: [2] }, undefined, async () => {
    assert.equal((await new BrowserConnection().selectTab()).tab.id, 2);
  });
});

test('background status never opens tabs; explicit connection can open a login page', async () => {
  await withMocks({}, undefined, async mock => {
    const connection = new BrowserConnection();
    assert.equal((await connection.status()).logged_in, false);
    assert.equal(await connection.selectTab(), undefined);
    assert.equal(mock.tabs.length, 0);
    assert.equal((await connection.selectTab(true)).loggedIn, false);
    assert.equal(mock.tabs.length, 1);
    await connection.selectTab(true);
    assert.equal(mock.tabs.length, 1, 'an existing logged-out tab is reused');
  });
});

test('recording stays on its starting tab and service until stopped, including when the tab closes', async () => {
  await withMocks({ local: { bridge }, tabs: [tab(1), tab(2, { active: true })], loggedIn: [1, 2] }, undefined, async mock => {
    const connection = new BrowserConnection();
    await connection.configuration();
    connection.beginRecording(1);
    mock.local.bridgePort = 45111;
    assert.equal((await connection.configuration()).url, bridge.url);
    assert.equal((await connection.selectTab()).tab.id, 1);
    mock.session.tabId = 2;
    assert.equal((await connection.selectTab()).tab.id, 1);
    mock.tabs.splice(0, 1);
    assert.equal(await connection.selectTab(true), undefined, 'closed recording tab does not silently fall back or open a new tab');
    connection.endRecording();
    assert.equal((await connection.selectTab()).tab.id, 2);
  });
});

test('background refreshes stale pairing but never repeats an executed command after a failed acknowledgement', async () => {
  const fresh = { ...bridge, token: 'b'.repeat(64) };
  let polls = 0, pairs = 0, results = 0;
  await withMocks({ local: { bridge }, tabs: [tab(1)], loggedIn: [1] }, async (url, options) => {
    if (url.endsWith('/pair')) { pairs++; return Response.json(fresh); }
    if (url.endsWith('/poll')) {
      polls++;
      if (polls === 1) return new Response(null, { status: 403 });
      assert.equal(options.headers.authorization, `Bearer ${fresh.token}`);
      return Response.json({ command: { id: 'write-once', type: 'request', request: { path: '/backend-api/conversation/example', method: 'PATCH', body: { title: 'New title' } } } });
    }
    if (url.endsWith('/result')) { results++; throw new Error('connection lost'); }
    throw new Error('unexpected request');
  }, async mock => {
    await import(`../extension/background.js?connection-test=${Date.now()}`);
    await mock.stopped;
    assert.equal(pairs, 1);
    assert.equal(polls, 2);
    assert.equal(results, 1);
    assert.equal(mock.calls.filter(call => call.args && JSON.parse(call.args[0]).type === 'request').length, 1);
  });
});
