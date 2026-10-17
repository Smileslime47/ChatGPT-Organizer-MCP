import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { StandaloneBackend } from '../dist/browser/chromium/standalone.js';

function fixture({ hasProfile = false, loggedIn = false } = {}) {
  const state = { loggedIn, checkFailed: false, controlled: 0, ordinary: 0, contextCloses: 0, unrefs: 0, refs: 0 };
  const children = [];
  const context = new EventEmitter();
  const page = { isClosed: () => false, url: () => 'https://chatgpt.com/', goto: async () => {},
    evaluate: async () => { if (state.checkFailed) throw new Error('network timeout'); return state.loggedIn; } };
  context.pages = () => [page];
  context.close = async () => { state.contextCloses++; context.emit('close'); };
  const backend = new StandaloneBackend('unused', {}, {
    hasProfile: () => hasProfile,
    launchBrowser: async () => { state.controlled++; return context; },
    loginLauncher: async () => {
      state.ordinary++;
      const child = new EventEmitter();
      child.exitCode = null;
      child.signalCode = null;
      child.unref = () => { state.unrefs++; };
      child.ref = () => { state.refs++; };
      child.kill = () => { throw new Error('Must not kill the login window'); };
      children.push(child);
      return child;
    },
  });
  return { backend, state, children };
}

test('first open returns a pending ordinary login without controlling authentication', async () => {
  const { backend, state } = fixture();
  assert.equal((await backend.status()).browser_open, false);
  assert.equal(state.ordinary, 0);
  await Promise.all([backend.open(), backend.open()]);
  assert.equal(state.ordinary, 1);
  assert.equal(state.controlled, 0);
  assert.equal((await backend.status()).login_pending, true);
  await backend.open();
  assert.equal(state.ordinary, 1);
  await assert.rejects(backend.request({ path: '/backend-api/conversations' }), { code: 'LOGIN_REQUIRED' });
  await assert.rejects(backend.startRecording('list_projects', {}), { code: 'LOGIN_REQUIRED' });
  assert.equal(backend.recording, null);
  await backend.close();
  assert.equal(state.contextCloses, 0);
  assert.equal(state.unrefs, 1);
});

test('closing the login window does not prove authentication; the next open verifies it', async () => {
  const { backend, state, children } = fixture();
  await backend.open();
  children[0].exitCode = 0;
  const pending = await backend.status();
  assert.equal(pending.browser_open, false);
  assert.equal(pending.logged_in, false);
  assert.equal(state.controlled, 0);
  state.loggedIn = true;
  await backend.open();
  assert.equal(state.controlled, 1);
  assert.equal((await backend.status()).logged_in, true);
  assert.equal(state.ordinary, 1);
  await backend.close();
  assert.equal(state.contextCloses, 1);
});

test('an unsuccessful login returns to an ordinary window without claiming success', async () => {
  const { backend, state, children } = fixture();
  await backend.open();
  children[0].exitCode = 0;
  await backend.open();
  assert.equal(state.controlled, 1);
  assert.equal(state.contextCloses, 1);
  assert.equal(state.ordinary, 2);
  assert.equal((await backend.status()).logged_in, false);
  assert.equal((await backend.status()).login_pending, true);
});

test('an existing valid session skips ordinary login; expiration closes control before login', async () => {
  const { backend, state } = fixture({ hasProfile: true, loggedIn: true });
  await backend.open();
  assert.equal(state.controlled, 1);
  assert.equal(state.ordinary, 0);
  assert.equal((await backend.status()).logged_in, true);
  state.loggedIn = false;
  await backend.open();
  assert.equal(state.contextCloses, 1);
  assert.equal(state.ordinary, 1);
  assert.equal(backend.context, null);
});

test('a failed login check preserves the working window and can recover without reauthentication', async () => {
  const { backend, state } = fixture({ hasProfile: true, loggedIn: true });
  state.checkFailed = true;
  await assert.rejects(backend.open(), { code: 'LOGIN_CHECK_FAILED' });
  assert.equal(state.contextCloses, 0);
  assert.equal(state.ordinary, 0);
  assert.equal((await backend.status()).login_check_failed, true);
  state.checkFailed = false;
  await backend.open();
  assert.equal((await backend.status()).logged_in, true);
  assert.equal(state.controlled, 1);
  await backend.close();
});

test('the login interface owns its ordinary process and settles when closed or detached', async () => {
  for (const userCloses of [true, false]) {
    const { backend, state, children } = fixture();
    const login = await backend.login();
    assert.equal(await backend.login(), login);
    assert.match(login.instruction, /普通独立窗口/);
    assert.equal(state.controlled, 0);
    assert.equal(state.ordinary, 1);
    assert.equal(state.refs, 1);
    if (userCloses) {
      children[0].exitCode = 0;
      children[0].emit('exit', 0);
    } else await backend.close();
    await login.closed;
    assert.equal(state.unrefs, 2);
    assert.equal(children[0].listenerCount('exit'), 0);
    assert.equal((await backend.status()).logged_in, false);
    await backend.close();
  }
});
