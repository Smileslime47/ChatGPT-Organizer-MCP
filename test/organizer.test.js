import test from 'node:test';
import assert from 'node:assert/strict';
import { Organizer, scrub, projectList } from '../dist/core/organizer.js';
import { OrganizerError, errorResult } from '../dist/core/errors.js';

function fixture() {
  const records = new Map([
    ['one', { id: 'one', title: 'Python 学习', is_archived: false, update_time: 1 }],
    ['two', { id: 'two', title: '旅行计划', is_archived: false, update_time: 1 }],
  ]);
  const requests = [];
  const backend = { async request(req) {
    requests.push(req);
    if (req.path.startsWith('/backend-api/conversations?')) {
      const url = new URL(req.path, 'https://chatgpt.com');
      const rows = [...records.values()].filter(row => row.is_archived === (url.searchParams.get('is_archived') === 'true'));
      const offset = Number(url.searchParams.get('offset')); const limit = Number(url.searchParams.get('limit'));
      return { items: rows.slice(offset, offset + limit), total: rows.length };
    }
    const id = req.path.split('/').at(-1);
    const row = records.get(id);
    if (!row) throw new OrganizerError('NOT_FOUND', 'missing');
    if (req.method === 'PATCH') { Object.assign(row, req.body); row.update_time++; return { success: true }; }
    return { ...row, conversation_id: row.id };
  } };
  const routes = { get() { throw new OrganizerError('PROJECT_ROUTE_NOT_CALIBRATED', 'calibrate'); } };
  let time = 0;
  const organizer = new Organizer(backend, routes, { now: () => time });
  return { organizer, requests, records, backend, advance: value => { time += value; } };
}

test('search reports partial scope and handles pagination', async () => {
  const { organizer } = fixture();
  const partial = await organizer.search({ query: 'python', max_scan: 1 });
  assert.equal(partial.items.length, 1); assert.equal(partial.complete, false);
  const full = await organizer.search({ query: '计划', max_scan: 3 });
  assert.equal(full.items[0].id, 'two'); assert.equal(full.complete, true);
});

test('preview performs no writes; execution verifies state and duplicate execution does not replay', async () => {
  const { organizer, requests } = fixture();
  const plan = await organizer.preview([{ type: 'rename_conversation', conversation_id: 'one', title: 'Python' }, { type: 'archive_conversation', conversation_id: 'two', archived: true }]);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 0);
  const result = await organizer.execute(plan.plan_id);
  assert.equal(result.state, 'completed'); assert.ok(result.results.every(r => r.verified));
  assert.deepEqual(await organizer.execute(plan.plan_id), result);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 2);
});

test('stale plans stop before any write', async () => {
  const { organizer, records, requests } = fixture();
  const plan = await organizer.preview([{ type: 'archive_conversation', conversation_id: 'one', archived: true }]);
  records.get('one').title = 'changed elsewhere';
  const result = await organizer.execute(plan.plan_id);
  assert.equal(result.error.code, 'STALE_PLAN');
  assert.equal(requests.filter(r => r.method).length, 0);
});

test('expired plans and missing project routes fail before writes', async () => {
  const { organizer, advance } = fixture();
  const plan = await organizer.preview([{ type: 'rename_conversation', conversation_id: 'one', title: 'new' }]);
  advance(600001);
  await assert.rejects(organizer.execute(plan.plan_id), { code: 'PLAN_EXPIRED' });
  await assert.rejects(organizer.preview([{ type: 'move_conversation', conversation_id: 'one', project_id: 'g-p-test' }]), { code: 'PROJECT_ROUTE_NOT_CALIBRATED' });
});

test('failed writes stop the batch, retain prior results, and are not retried', async () => {
  const { organizer, backend, requests } = fixture();
  const original = backend.request.bind(backend);
  backend.request = async req => {
    if (req.method === 'PATCH' && req.path.endsWith('/two')) { requests.push(req); throw new OrganizerError('REQUEST_UNCERTAIN', 'network lost'); }
    return original(req);
  };
  const plan = await organizer.preview([
    { type: 'rename_conversation', conversation_id: 'one', title: 'new' },
    { type: 'rename_conversation', conversation_id: 'two', title: 'new' },
    { type: 'archive_conversation', conversation_id: 'one', archived: true },
  ]);
  const result = await organizer.execute(plan.plan_id);
  assert.equal(result.state, 'stopped'); assert.equal(result.skipped, 1);
  assert.equal(result.results[0].status, 'applied'); assert.equal(result.results[1].status, 'failed_or_uncertain');
  await organizer.execute(plan.plan_id);
  assert.equal(requests.filter(r => r.method === 'PATCH').length, 2);
});

test('concurrent plan execution is rejected', async () => {
  const { organizer, backend } = fixture();
  const a = await organizer.preview([{ type: 'rename_conversation', conversation_id: 'one', title: 'a' }]);
  const b = await organizer.preview([{ type: 'rename_conversation', conversation_id: 'two', title: 'b' }]);
  const original = backend.request.bind(backend);
  let resume;
  backend.request = async req => { await new Promise(resolve => { resume = resolve; }); return original(req); };
  const running = organizer.execute(a.plan_id);
  await assert.rejects(organizer.execute(b.plan_id), { code: 'PLAN_RUNNING' });
  backend.request = original; resume();
  assert.equal((await running).state, 'completed');
});

test('get returns current branch only and tolerates graph cycles', async () => {
  const backend = { request: async () => ({ conversation_id: 'a', title: 'test', current_node: 'two', mapping: {
    two: { parent: 'one', message: { author: { role: 'assistant' }, content: { parts: ['answer'] } } },
    one: { parent: 'two', message: { author: { role: 'user' }, content: { parts: ['question'] } } },
    other: { message: { author: { role: 'user' }, content: { parts: ['wrong branch'] } } },
  } }) };
  const result = await new Organizer(backend, {}).get('a', 10);
  assert.deepEqual(result.messages.map(m => m.text), ['question', 'answer']);
  assert.equal('messages' in await new Organizer(backend, {}).get('a'), false);
});

test('secret fields and raw exception contents are not exposed', () => {
  assert.deepEqual(scrub({ items: [{ name: 'project', accessToken: 'secret', email: 'private' }] }), { items: [{ name: 'project' }] });
  assert.equal(JSON.stringify(errorResult(new Error('Bearer secret'))).includes('Bearer secret'), false);
});

test('move must read back the intended project before reporting success', async () => {
  const { organizer, records } = fixture();
  organizer.project = async () => ({ success: true });
  await assert.rejects(organizer.applyAction({ type: 'move_conversation', conversation_id: 'one', project_id: 'g-p-target' }), { code: 'VERIFY_FAILED' });
  records.get('one').gizmo_id = 'g-p-target';
  assert.equal((await organizer.applyAction({ type: 'move_conversation', conversation_id: 'one', project_id: 'g-p-target' })).verified, true);
});

test('project rename preserves the target current instructions, emoji and theme', async () => {
  const current = { id: 'g-p-existing', instructions: 'preserve these private instructions', display: { name: 'before', emoji: '📚', theme: 'blue' } };
  const writes = [];
  const backend = { request: async req => {
    if (req.method === 'PATCH') { writes.push(req); current.display.name = req.body.name; return { success: true }; }
    assert.equal(req.path, '/backend-api/gizmos/snorlax/sidebar?limit=20');
    return { items: [{ gizmo: { gizmo: current } }] };
  } };
  const routes = { get: operation => operation === 'list_projects'
    ? { method: 'GET', path: '/backend-api/gizmos/snorlax/sidebar?limit=20' }
    : { method: 'PATCH', path: '/backend-api/projects/g-p-existing', body: { name: 'after' } } };
  const result = await new Organizer(backend, routes).applyAction({ type: 'rename_project', project_id: 'g-p-existing', name: 'after' });
  assert.equal(result.verified, true);
  assert.deepEqual(writes[0].body, { name: 'after', instructions: current.instructions, emoji: '📚', theme: 'blue' });
  assert.equal(JSON.stringify(result).includes('private instructions'), false);
});

test('project list returns identifiers, sharing and cursors without unrelated configuration', () => {
  const data = projectList({ cursor: 'next-project', items: [{
    gizmo: { gizmo: { id: 'g-p-one', display: { name: 'Study' }, share_recipient: 'private', instructions: 'private instructions', current_user_permission: { can_write: true } }, product_features: { irrelevant: true } },
    conversations: { cursor: 'next-chat', items: [{ id: 'one', title: 'Notes' }] },
  }] });
  assert.equal(data.cursor, 'next-project');
  assert.equal(data.items[0].conversations.cursor, 'next-chat');
  assert.equal(data.items[0].sharing, 'private');
  assert.equal(JSON.stringify(data).includes('instructions'), false);
  assert.equal(JSON.stringify(data).includes('product_features'), false);
});
