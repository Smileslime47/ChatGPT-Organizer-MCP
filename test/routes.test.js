import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { learnRoute, renderRoute, safeBackendPath } from '../dist/core/routes.js';
import { RouteStore } from '../dist/storage/routes.js';

test('rename learning changes only the name and safely renders a new name', () => {
  const route = learnRoute('rename_project', {
    method: 'PATCH', path: '/backend-api/gizmos/g-p-example', body: { name: '学习', color: 'blue' },
  }, { project_id: 'g-p-example', name: '学习' });
  assert.ok(route);
  const next = renderRoute(route, { project_id: 'g-p-next', name: '语言 " & 科学' });
  assert.equal(next.path, '/backend-api/gizmos/g-p-next');
  assert.deepEqual(next.body, { name: '语言 " & 科学' });
});

test('move learning requires both IDs and changes only exact values', () => {
  const route = learnRoute('move_conversation', { method: 'PATCH', path: '/backend-api/conversation/chat-1', body: { gizmo_id: 'g-p-1', label: 'g-p-1-extra' } }, { project_id: 'g-p-1', conversation_id: 'chat-1' });
  assert.deepEqual(renderRoute(route, { project_id: 'g-p-2', conversation_id: 'chat-2' }).body, { gizmo_id: 'g-p-2', label: 'g-p-1-extra' });
  assert.equal(learnRoute('move_conversation', { method: 'PATCH', path: '/backend-api/conversation/chat-1', body: {} }, { project_id: 'g-p-1', conversation_id: 'chat-1' }), null);
});

test('page initialization carrying both IDs is never learned as a move', () => {
  for (const path of ['/backend-api/conversation/init', '/backend-api/conversation/prepare']) {
    assert.equal(learnRoute('move_conversation', { method: 'POST', path, body: { conversation_id: 'chat-1', gizmo_id: 'g-p-1' } }, { conversation_id: 'chat-1', project_id: 'g-p-1' }), null);
  }
});

test('recording rejects auth, message generation, secret fields and destructive routes', () => {
  const examples = { name: 'demo' };
  for (const path of ['/api/auth/session', 'https://evil.invalid/backend-api/projects', '/backend-api/conversation', '/backend-api/gizmos/delete']) {
    assert.equal(learnRoute('create_project', { method: 'POST', path, body: { name: 'demo' } }, examples), null);
  }
  for (const body of [{ name: 'demo', accessToken: 'secret' }, { name: 'demo', nested: { cookie: 'secret' } }]) {
    assert.equal(learnRoute('create_project', { method: 'POST', path: '/backend-api/gizmos', body }, examples), null);
  }
  assert.equal(learnRoute('create_project', { method: 'DELETE', path: '/backend-api/projects', body: { name: 'demo' } }, examples), null);
});

test('empty project instruction defaults can be recorded without retaining real instructions', () => {
  const request = { method: 'POST', path: '/backend-api/gizmos/snorlax', body: { name: 'demo', instructions: '', prompt_starters: [] } };
  const route = learnRoute('create_project', request, { name: 'demo' });
  assert.ok(route);
  assert.deepEqual(renderRoute(route, { name: 'next' }).body, { name: 'next', instructions: '', prompt_starters: [] });
  request.body.instructions = 'private instructions';
  assert.equal(learnRoute('create_project', request, { name: 'demo' }), null);
});

test('paths cannot escape the ChatGPT backend or carry secrets', () => {
  for (const path of ['//evil.invalid/a', '/backend-api/../../api/auth/session', '/backend-api/%2e%2e/foo', '/backend-api/x?access_token=bad', '/backend-api/\\evil']) assert.throws(() => safeBackendPath(path));
});

test('route store persists only validated templates and reports missing calibration', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'organizer-routes-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new RouteStore(dir);
  await store.load();
  assert.throws(() => store.get('list_projects'), { code: 'PROJECT_ROUTE_NOT_CALIBRATED' });
  const route = learnRoute('list_projects', { method: 'GET', path: '/backend-api/gizmos/sidebar?limit=10' }, {});
  await store.save('list_projects', route);
  const reloaded = new RouteStore(dir);
  await reloaded.load();
  assert.equal(reloaded.get('list_projects').path, '/backend-api/gizmos/sidebar?limit=10');
  const saved = await readFile(join(dir, 'project-routes.json'), 'utf8');
  assert.equal(saved.includes('authorization'), false);
  await writeFile(join(dir, 'project-routes.json'), '{"version":2}');
  await assert.rejects(reloaded.load(), { code: 'INVALID_ROUTE_FILE' });
});
