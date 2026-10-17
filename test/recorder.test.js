import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { pageRecorder } from '../extension/recorder.js';

function fixture(t, status = 200) {
  const original = async () => new Response('{}', { status });
  const window = { fetch: original };
  const context = vm.createContext({ window, location: { href: 'https://chatgpt.com/c/test' }, URL, Request, setTimeout, clearTimeout });
  const recorder = vm.runInContext(`(${pageRecorder.toString()})`, context);
  t.after(() => recorder('stop'));
  return { window, original, recorder };
}

test('page recorder captures PATCH JSON without headers and restores fetch', async t => {
  const { window, original, recorder } = fixture(t);
  await recorder('start');
  await window.fetch('/backend-api/conversation/chat-1', { method: 'PATCH', body: JSON.stringify({ gizmo_id: 'g-p-one' }), headers: { authorization: 'never capture this' } });
  const { captures } = await recorder('flush');
  assert.equal(captures.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(captures[0])), { method: 'PATCH', path: '/backend-api/conversation/chat-1', body: { gizmo_id: 'g-p-one' }, status: 200 });
  assert.equal((await recorder('flush')).captures.length, 0);
  await recorder('stop');
  assert.equal(window.fetch, original);
});

test('page recorder accepts Request bodies, rejects secrets and excludes init/generation', async t => {
  const { window, recorder } = fixture(t);
  await recorder('start');
  await window.fetch(new Request('https://chatgpt.com/backend-api/gizmos/g-p-one', { method: 'PATCH', body: JSON.stringify({ name: 'new' }) }));
  await window.fetch('/backend-api/gizmos/g-p-one', { method: 'PATCH', body: JSON.stringify({ instructions: 'private' }) });
  await window.fetch('/backend-api/conversation/init', { method: 'POST', body: '{"gizmo_id":"g-p-one"}' });
  await window.fetch('/backend-api/conversation', { method: 'POST', body: '{"messages":["private"]}' });
  const { captures } = await recorder('flush');
  assert.equal(captures.length, 2);
  assert.equal(captures.find(item => item.body)?.body.name, 'new');
  assert.equal(captures.find(item => item.diagnostic)?.diagnostic, 'sensitive_body_field');
  assert.equal(JSON.stringify(captures).includes('private'), false);
});

test('failed writes record only status metadata', async t => {
  const { window, recorder } = fixture(t, 403);
  await recorder('start');
  await window.fetch('/backend-api/conversation/chat-1', { method: 'PATCH', body: '{"title":"new"}' });
  const { captures } = await recorder('flush');
  assert.equal(captures[0].diagnostic, 'backend_http_403');
  assert.equal('body' in captures[0], false);
});
