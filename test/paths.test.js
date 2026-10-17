import test from 'node:test';
import assert from 'node:assert/strict';
import { dataDirectory } from '../dist/storage/paths.js';

test('new installations keep data in the operating system user data directory', () => {
  const common = { root: '/npx/cache/package', home: '/users/example', env: {}, exists: () => false };
  assert.equal(dataDirectory({ ...common, platform: 'linux' }), '/users/example/.local/share/chatgpt-organizer');
  assert.equal(dataDirectory({ ...common, platform: 'linux', env: { XDG_DATA_HOME: '/data' } }), '/data/chatgpt-organizer');
  assert.equal(dataDirectory({ ...common, platform: 'linux', env: { XDG_DATA_HOME: 'relative' } }), '/users/example/.local/share/chatgpt-organizer');
  assert.equal(dataDirectory({ ...common, platform: 'darwin' }), '/users/example/Library/Application Support/chatgpt-organizer');
  const windows = { ...common, platform: 'win32', root: 'C:\\npx\\cache', home: 'C:\\Users\\Example' };
  assert.equal(dataDirectory(windows), 'C:\\Users\\Example\\AppData\\Local\\chatgpt-organizer');
  assert.equal(dataDirectory({ ...windows, env: { LOCALAPPDATA: 'D:\\UserData' } }), 'D:\\UserData\\chatgpt-organizer');
});

test('existing source data is retained and an explicit data directory always takes priority', () => {
  const options = { root: '/source', platform: 'linux', home: '/users/example', cwd: '/working', env: {} };
  for (const file of ['project-routes.json', 'browser-choice.json', 'browser']) {
    const exists = candidate => candidate === `/source/.local/${file}`;
    assert.equal(dataDirectory({ ...options, exists }), '/source/.local');
    assert.equal(dataDirectory({ ...options, exists, env: { CHATGPT_DATA_DIR: './custom' } }), '/working/custom');
    assert.equal(dataDirectory({ ...options, exists, env: { CHATGPT_DATA_DIR: '/custom' } }), '/custom');
  }
  assert.equal(dataDirectory({ ...options, exists: candidate => candidate === '/source/.local' }), '/users/example/.local/share/chatgpt-organizer');
});
