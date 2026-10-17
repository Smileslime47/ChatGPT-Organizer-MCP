import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Organizer } from '../dist/core/organizer.js';
import { createServer } from '../dist/app/server.js';
import { createBrowserSession } from '../dist/app/session-factory.js';

test('MCP and Organizer work with only the browser session interface', async t => {
  const calls = [];
  const browser = {
    initialize: async () => {},
    login: async () => ({ instruction: 'login', closed: Promise.resolve() }),
    open: async () => { calls.push('open'); },
    status: async () => ({ browser_open: true, logged_in: true }),
    request: async request => { calls.push(request); return { items: [{ id: 'chat-1', title: 'example' }], total: 1 }; },
    startRecording: async (operation, examples) => ({ recording: operation, examples }),
    finishRecording: async (_candidate, cancel) => ({ cancelled: cancel }),
    close: async () => {},
  };
  // No Page, BrowserContext or concrete class is required.
  const routes = { status: () => ({}) };
  const server = createServer({ browser, routes, organizer: new Organizer(browser, routes) });
  const client = new Client({ name: 'session-contract', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  t.after(async () => { await client.close(); await server.close(); });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true);
    return JSON.parse(result.content[0].text);
  };
  assert.equal((await call('chatgpt_open_browser')).logged_in, true);
  assert.equal((await call('chatgpt_list_conversations', { limit: 1 })).items[0].id, 'chat-1');
  assert.equal(calls[0], 'open');
  assert.match(calls[1].path, /^\/backend-api\/conversations\?/);
  assert.equal((await call('chatgpt_record_start', { operation: 'list_projects' })).recording, 'list_projects');
  assert.equal((await call('chatgpt_record_finish', { cancel: true })).cancelled, true);
});

test('all configured providers expose the interface without launching a browser', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'organizer-session-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const kind of [undefined, 'playwright', 'chrome']) {
    const session = await createBrowserSession(directory, {}, { CHATGPT_TRANSPORT: kind });
    try {
      for (const method of ['initialize', 'open', 'login', 'status', 'request', 'startRecording', 'finishRecording', 'close']) {
        assert.equal(typeof session[method], 'function', `${kind ?? 'default'}.${method}`);
      }
      await session.initialize();
      assert.equal((await session.status()).browser_open, false);
    } finally { await session.close(); }
  }
  await assert.rejects(createBrowserSession(directory, {}, { CHATGPT_TRANSPORT: 'unknown' }), { code: 'INVALID_TRANSPORT' });
  await assert.rejects(createBrowserSession(directory, {}, { CHATGPT_TRANSPORT: '__proto__' }), { code: 'INVALID_TRANSPORT' });
  await assert.rejects(createBrowserSession(directory, {}, { CHATGPT_TRANSPORT: 'extension' }), { code: 'INVALID_TRANSPORT' });
});
