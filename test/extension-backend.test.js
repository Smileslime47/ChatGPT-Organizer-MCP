import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExtensionBackend } from '../dist/browser/extension/backend.js';
import { Organizer } from '../dist/core/organizer.js';

test('extension transport integrates status, backend reads and route recording over authenticated HTTP', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'organizer-extension-'));
  const saved = [];
  const backend = new ExtensionBackend(directory, { save: async (...args) => saved.push(args) }, { port: 0, pollTimeout: 100, commandTimeout: 2000 });
  const controller = new AbortController();
  let polling;
  t.after(async () => { controller.abort(); await polling; await backend.close(); await rm(directory, { recursive: true, force: true }); });
  const offline = await backend.status();
  assert.equal(offline.extension_connected, false);
  assert.equal(Object.hasOwn(offline, 'pairing_file'), false);
  assert.match(offline.action, /自动连接/);
  const clientId = randomUUID();
  const paired = await fetch(backend.bridge.url + '/pair', {
    method: 'POST', headers: { origin: backend.bridge.extensionOrigin, 'x-chatgpt-organizer': '1', 'x-chatgpt-organizer-client': clientId },
  });
  assert.equal(paired.status, 200);
  const config = await paired.json();
  const headers = { authorization: `Bearer ${config.token}`, origin: backend.bridge.extensionOrigin, 'x-chatgpt-organizer-client': clientId };
  // Establish the extension heartbeat before invoking an MCP-side request.
  await fetch(config.url + '/poll', { headers });
  const received = [];
  polling = (async () => {
    try {
      while (!controller.signal.aborted) {
        const response = await fetch(config.url + '/poll', { headers, signal: controller.signal });
        const { command } = await response.json();
        if (!command) continue;
        received.push(command.type);
        const result = command.type === 'status' ? { browser_open: true, logged_in: true }
          : command.type === 'request' ? { status: 200, data: { items: [{ id: 'chat-1', title: 'demo' }], total: 1 } }
          : command.type === 'record_start' ? { ok: true, tab_title: 'Demo ChatGPT' }
          : command.type === 'record_flush' ? { captures: [{ method: 'PATCH', path: '/backend-api/gizmos/g-p-one', body: { name: 'new' }, status: 200 }] } : { ok: true };
        await fetch(config.url + '/result', { method: 'POST', headers, body: JSON.stringify({ id: command.id, result }), signal: controller.signal });
      }
    } catch (error) { if (!controller.signal.aborted) throw error; }
  })();
  const status = await backend.status();
  assert.equal(status.logged_in, true); assert.equal(status.extension_connected, true);
  const data = await new Organizer(backend, {}).list({ limit: 1 });
  assert.equal(data.items[0].id, 'chat-1');
  const recording = await backend.startRecording('rename_project', { project_id: 'g-p-one', name: 'new' });
  assert.equal(recording.tab_title, 'Demo ChatGPT');
  assert.match(recording.instruction, /Demo ChatGPT/);
  // webRequest can omit PATCH bodies; the explicit page recorder flush supplies it.
  const capture = await fetch(config.url + '/capture', { method: 'POST', headers, body: JSON.stringify({ method: 'PATCH', path: '/backend-api/gizmos/g-p-one', status: 200 }) });
  assert.equal(capture.status, 200);
  assert.equal((await backend.finishRecording()).saved, true);
  assert.equal(saved[0][1].body.name, '{{name}}');
  assert.deepEqual(received, ['status', 'request', 'open', 'record_start', 'record_flush', 'record_stop']);
});
