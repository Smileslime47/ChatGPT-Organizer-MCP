import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { strFromU8, unzipSync } from 'fflate';
import { createExtensionArchive, extensionIdFromKey } from '../dist/tools/release.js';

const publicKey = generateKeyPairSync('rsa', { modulusLength: 1024 }).publicKey
  .export({ type: 'spki', format: 'der' }).toString('base64');

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'chatgpt-extension-release-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const manifest = {
    manifest_version: 3,
    version: '1.2.3',
    background: { service_worker: 'background.js', type: 'module' },
    options_page: 'options.html',
    icons: { 128: 'icons/icon128.png' },
    key: publicKey,
  };
  await mkdir(join(directory, 'icons'));
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'options.html'), '<link href="options.css"><script src="options.js"></script>');
  await writeFile(join(directory, 'options.css'), 'body {}');
  await writeFile(join(directory, 'icons/icon128.png'), new Uint8Array([137, 80, 78, 71]));
  for (const name of ['background', 'connection', 'options', 'page', 'recorder', 'types']) {
    await writeFile(join(directory, `${name}.js`), `export {};\n//# sourceMappingURL=${name}.js.map\n`);
    await writeFile(join(directory, `${name}.js.map`), 'private source map');
  }
  return { directory, manifest };
}

test('release ZIP contains runtime resources and license, with manifest at its root and no source maps', async t => {
  const { directory } = await fixture(t);
  await mkdir(join(directory, 'src'));
  await mkdir(join(directory, '.local'));
  await writeFile(join(directory, 'src/background.ts'), 'source code');
  await writeFile(join(directory, '.local/bridge-config.json'), 'pairing secret');
  await writeFile(join(directory, '.env'), 'secret');
  await writeFile(join(directory, 'cookies.json'), 'private cookies');
  await writeFile(join(directory, 'unrelated.js'), 'unrelated code');
  await writeFile(join(directory, 'icons/private.txt'), 'private');
  const archive = await createExtensionArchive(directory, '1.2.3');
  const files = unzipSync(archive.bytes);
  assert.equal(archive.filename, 'chatgpt-organizer-extension-1.2.3.zip');
  assert.match(archive.extensionId, /^[a-p]{32}$/);
  assert.equal(archive.extensionId, extensionIdFromKey(publicKey));
  assert.deepEqual(Object.keys(files).sort(), [
    'LICENSE', 'background.js', 'connection.js', 'icons/icon128.png', 'manifest.json',
    'options.css', 'options.html', 'options.js', 'page.js', 'recorder.js', 'types.js',
  ]);
  assert.equal(JSON.parse(strFromU8(files['manifest.json'])).version, '1.2.3');
  assert.match(strFromU8(files.LICENSE), /^MIT License\r?\n/);
  for (const name of Object.keys(files).filter(name => name.endsWith('.js'))) {
    assert.doesNotMatch(strFromU8(files[name]), /sourceMappingURL/);
  }
});

test('release rejects mismatched versions and missing referenced resources', async t => {
  const { directory, manifest } = await fixture(t);
  await assert.rejects(createExtensionArchive(directory, '2.0.0'), /version/);
  manifest.icons[128] = 'icons/missing.png';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await assert.rejects(createExtensionArchive(directory, '1.2.3'), /icons\/missing\.png/);
  manifest.icons[128] = 'icons/icon128.png';
  await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest));
  await writeFile(join(directory, 'background.js'), 'import { helper } from "./missing.js";');
  await assert.rejects(createExtensionArchive(directory, '1.2.3'), /missing\.js/);
});

test('extension identity requires a valid public key', () => {
  assert.throws(() => extensionIdFromKey(undefined), /key/);
  assert.throws(() => extensionIdFromKey('invalid'));
});
