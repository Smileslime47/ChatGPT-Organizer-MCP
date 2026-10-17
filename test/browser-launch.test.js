import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBrowser, openLoginBrowser } from '../dist/browser/chromium/launch.js';
import { errorResult } from '../dist/core/errors.js';

async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), 'organizer-launch-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}
function options(paths, overrides = {}) {
  return { platform: 'linux', env: {}, exists: candidate => paths.includes(candidate), chromiumPath: () => '/bundled/chromium', ...overrides };
}

test('browser discovery covers Chrome, Edge and Chromium across supported platforms', async t => {
  const cases = [
    ['win32', 'C:\\Apps\\Google\\Chrome\\Application\\chrome.exe', { PROGRAMFILES: 'C:\\Apps' }],
    ['win32', 'C:\\Apps\\Microsoft\\Edge\\Application\\msedge.exe', { 'PROGRAMFILES(X86)': 'C:\\Apps' }],
    ['win32', 'C:\\Apps\\Chromium\\Application\\chrome.exe', { LOCALAPPDATA: 'C:\\Apps' }],
    ['darwin', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', {}],
    ['darwin', '/users/example/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', {}],
    ['darwin', '/Applications/Chromium.app/Contents/MacOS/Chromium', {}],
    ['linux', '/usr/bin/google-chrome-stable', {}],
    ['linux', '/usr/bin/microsoft-edge', {}],
    ['linux', '/custom/bin/chromium', { PATH: '/custom/bin' }],
    ['win32', 'D:\\Tools\\msedge.exe', { Path: '"D:\\Tools";C:\\Other' }],
  ];
  for (const [platform, executablePath, env] of cases) {
    const directory = await temporaryDirectory(t);
    assert.deepEqual(await resolveBrowser(directory, options([executablePath], { platform, env, home: '/users/example' })), { executablePath });
    assert.deepEqual(JSON.parse(await readFile(join(directory, 'browser-choice.json'), 'utf8')), { executablePath });
    assert.deepEqual(await readdir(directory), ['browser-choice.json']);
  }
});

test('bundled Chromium is the last installed fallback and missing browsers produce safe guidance', async t => {
  const directory = await temporaryDirectory(t);
  assert.deepEqual(await resolveBrowser(directory, options(['/bundled/chromium'])), { executablePath: '/bundled/chromium' });
  await assert.rejects(resolveBrowser(await temporaryDirectory(t), options([])), error => {
    assert.equal(error.code, 'BROWSER_NOT_FOUND');
    assert.match(error.message, /playwright@1\.64\.1 install chromium/);
    return true;
  });
});

test('explicit executable and channels take priority, without silent fallback', async t => {
  const installed = ['/usr/bin/google-chrome', '/usr/bin/microsoft-edge', '/usr/bin/chromium', '/custom/browser'];
  for (const [env, expected] of [
    [{ CHATGPT_BROWSER_EXECUTABLE: './browser' }, '/custom/browser'],
    [{ CHATGPT_BROWSER_CHANNEL: 'msedge' }, '/usr/bin/microsoft-edge'],
    [{ CHATGPT_BROWSER_CHANNEL: 'chromium' }, '/usr/bin/chromium'],
    [{ CHATGPT_BROWSER_CHANNEL: 'chrome' }, '/usr/bin/google-chrome'],
  ]) {
    assert.equal((await resolveBrowser(await temporaryDirectory(t), options(installed, { env, cwd: '/custom' }))).executablePath, expected);
  }
  const directory = await temporaryDirectory(t);
  await assert.rejects(resolveBrowser(directory, options(installed, { env: { CHATGPT_BROWSER_EXECUTABLE: '/missing/browser' } })), { code: 'BROWSER_NOT_FOUND' });
  await assert.rejects(resolveBrowser(directory, options(installed, { env: { CHATGPT_BROWSER_CHANNEL: 'firefox' } })), { code: 'INVALID_BROWSER_CHANNEL' });
  await assert.rejects(resolveBrowser(directory, options(installed, { env: { CHATGPT_BROWSER_EXECUTABLE: '/custom/browser', CHATGPT_BROWSER_CHANNEL: 'chrome' } })), { code: 'INVALID_BROWSER_CONFIGURATION' });
});

test('saved browser stays pinned when another browser is installed and conflicting overrides fail', async t => {
  const directory = await temporaryDirectory(t);
  const edge = '/usr/bin/microsoft-edge';
  const chrome = '/usr/bin/google-chrome';
  await resolveBrowser(directory, options([edge]));
  assert.equal((await resolveBrowser(directory, options([edge, chrome]))).executablePath, edge);
  assert.equal((await resolveBrowser(directory, options([edge, chrome], { env: { CHATGPT_BROWSER_CHANNEL: 'msedge' } }))).executablePath, edge);
  for (const env of [{ CHATGPT_BROWSER_CHANNEL: 'chrome' }, { CHATGPT_BROWSER_EXECUTABLE: chrome }]) {
    await assert.rejects(resolveBrowser(directory, options([edge, chrome], { env })), { code: 'BROWSER_CHOICE_CONFLICT' });
  }
  await assert.rejects(resolveBrowser(directory, options([chrome])), { code: 'BROWSER_NOT_FOUND' });
  assert.equal(JSON.parse(await readFile(join(directory, 'browser-choice.json'), 'utf8')).executablePath, edge);
});

test('Windows saved paths compare case-insensitively and malformed selections are rejected', async t => {
  const directory = await temporaryDirectory(t);
  await writeFile(join(directory, 'browser-choice.json'), JSON.stringify({ executablePath: 'C:\\Browser\\chrome.exe' }));
  assert.equal((await resolveBrowser(directory, options([], { platform: 'win32', exists: () => true,
    env: { CHATGPT_BROWSER_EXECUTABLE: 'c:\\browser\\CHROME.exe' } }))).executablePath, 'c:\\browser\\CHROME.exe');
  await writeFile(join(directory, 'browser-choice.json'), '{"executablePath":"relative"}');
  await assert.rejects(resolveBrowser(directory, options([])), { code: 'BROWSER_CHOICE_INVALID' });
});

test('concurrent discovery never replaces another selected browser', async t => {
  const directory = await temporaryDirectory(t);
  const results = await Promise.allSettled([
    resolveBrowser(directory, options(['/usr/bin/google-chrome'])),
    resolveBrowser(directory, options(['/usr/bin/microsoft-edge'])),
  ]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.find(result => result.status === 'rejected').reason.code, 'BROWSER_CHOICE_CONFLICT');
  const saved = JSON.parse(await readFile(join(directory, 'browser-choice.json'), 'utf8'));
  assert.deepEqual(saved, results.find(result => result.status === 'fulfilled').value);
});

test('ordinary login passes only profile, window and ChatGPT URL, and waits for spawn', async t => {
  const directory = await temporaryDirectory(t);
  const child = new EventEmitter();
  let call;
  let ready = false;
  const opening = openLoginBrowser(directory, options(['/usr/bin/google-chrome'], { spawn: (...args) => {
    call = args;
    setImmediate(() => { ready = true; child.emit('spawn'); });
    return child;
  } }));
  assert.equal(await opening, child);
  assert.equal(ready, true);
  assert.deepEqual(call, ['/usr/bin/google-chrome', [`--user-data-dir=${join(directory, 'browser')}`, '--new-window', 'https://chatgpt.com'],
    { shell: false, stdio: 'ignore', windowsHide: false }]);
});

test('ordinary login sanitizes both asynchronous and synchronous startup errors', async t => {
  for (const synchronous of [false, true]) {
    const directory = await temporaryDirectory(t);
    const child = new EventEmitter();
    await assert.rejects(openLoginBrowser(directory, options(['/usr/bin/google-chrome'], { spawn: () => {
      if (synchronous) throw new Error('private-session');
      setImmediate(() => child.emit('error', new Error('private-session')));
      return child;
    } })), error => {
      assert.equal(error.code, 'BROWSER_LAUNCH_FAILED');
      assert.equal(JSON.stringify(errorResult(error)).includes('private-session'), false);
      return true;
    });
  }
});
