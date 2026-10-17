import { createHash, createPublicKey } from 'node:crypto';
import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { strToU8, zipSync } from 'fflate';

const runtimeFiles = [
  'manifest.json', 'background.js', 'connection.js', 'options.js',
  'page.js', 'recorder.js', 'types.js', 'options.html', 'options.css',
];
const run = promisify(execFile);

export function extensionIdFromKey(key: unknown): string {
  if (typeof key !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(key)) {
    throw new Error('extension/manifest.json 必须包含有效的公开 key。');
  }
  const bytes = Buffer.from(key, 'base64');
  createPublicKey({ key: bytes, format: 'der', type: 'spki' });
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
    .replace(/[0-9a-f]/g, digit => String.fromCharCode(97 + parseInt(digit, 16)));
}

function requireResource(files: Record<string, Uint8Array>, reference: unknown): void {
  if (typeof reference !== 'string') throw new Error('扩展资源引用无效。');
  const name = reference.replace(/^\.\//, '');
  if (!Object.hasOwn(files, name)) throw new Error(`扩展缺少发布资源：${reference}`);
}

function requireIcons(files: Record<string, Uint8Array>, icons: unknown): void {
  if (icons === undefined) return;
  if (typeof icons === 'string') requireResource(files, icons);
  else if (icons !== null && typeof icons === 'object') {
    for (const icon of Object.values(icons)) requireResource(files, icon);
  } else throw new Error('扩展图标配置无效。');
}

/** Package the browser runtime and license; never walk the project or its data directory. */
export async function createExtensionArchive(extensionDirectory: string, version: string) {
  const names = [...runtimeFiles];
  const iconsDirectory = resolve(extensionDirectory, 'icons');
  try {
    if (!(await lstat(iconsDirectory)).isDirectory()) throw new Error('icons 必须为普通目录。');
    for (const entry of await readdir(iconsDirectory, { withFileTypes: true })) {
      if (/^[\w-]+\.png$/.test(entry.name) && entry.isFile()) names.push(`icons/${entry.name}`);
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }

  const files: Record<string, Uint8Array> = {
    LICENSE: await readFile(new URL('../../LICENSE', import.meta.url)),
  };
  for (const name of names.sort()) {
    const filename = resolve(extensionDirectory, name);
    if (!(await lstat(filename)).isFile()) throw new Error(`扩展资源必须为普通文件：${name}`);
    const contents = await readFile(filename);
    files[name] = name.endsWith('.js')
      ? strToU8(contents.toString('utf8').replace(/^\s*\/\/[#@]\s*sourceMappingURL=.*$/gm, ''))
      : contents;
  }

  const manifest = JSON.parse(Buffer.from(files['manifest.json']!).toString('utf8'));
  if (manifest.manifest_version !== 3) throw new Error('扩展必须使用 Manifest V3。');
  if (manifest.version !== version) throw new Error('package.json 与 extension/manifest.json 的 version 必须一致。');
  const extensionId = extensionIdFromKey(manifest.key);
  requireResource(files, manifest.background?.service_worker);
  requireResource(files, manifest.options_page);
  requireIcons(files, manifest.icons);
  requireIcons(files, manifest.action?.default_icon);
  if (manifest.action?.default_popup) requireResource(files, manifest.action.default_popup);

  for (const [name, contents] of Object.entries(files)) {
    const source = Buffer.from(contents).toString('utf8');
    if (name.endsWith('.html')) {
      for (const match of source.matchAll(/<(?:script|link|img)\b[^>]*\b(?:src|href)=["']([^"']+)["']/g)) {
        requireResource(files, match[1]);
      }
    } else if (name.endsWith('.js')) {
      for (const match of source.matchAll(/\b(?:from\s*|import\s*\(?\s*)["']([^"']+)["']/g)) {
        requireResource(files, match[1]);
      }
    }
  }
  return {
    filename: `chatgpt-organizer-extension-${version}.zip`,
    bytes: zipSync(files, { level: 9 }),
    extensionId,
  };
}

async function packageRelease(): Promise<void> {
  const projectDirectory = fileURLToPath(new URL('../../', import.meta.url));
  const pkg = JSON.parse(await readFile(resolve(projectDirectory, 'package.json'), 'utf8'));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请使用 npm run package 构建发布包。');
  const archive = await createExtensionArchive(resolve(projectDirectory, 'extension'), pkg.version);
  const outputDirectory = resolve(projectDirectory, 'release');
  await mkdir(outputDirectory, { recursive: true });
  const { stdout } = await run(process.execPath, [
    npm, 'pack', '--ignore-scripts', '--pack-destination', outputDirectory, '--json',
  ], { cwd: projectDirectory, maxBuffer: 4 * 1024 * 1024 });
  const packages = JSON.parse(stdout);
  const filename = packages[0]?.filename;
  if (packages.length !== 1 || typeof filename !== 'string' || basename(filename) !== filename) {
    throw new Error('npm pack 返回了无效的发布文件名。');
  }
  await writeFile(resolve(outputDirectory, archive.filename), archive.bytes);
  console.log(`MCP 服务：release/${filename}`);
  console.log('默认使用独立浏览器，无需安装扩展或开启日常浏览器远程调试。');
  console.log(`可选扩展：release/${archive.filename}`);
  console.log(`可选扩展 ID：${archive.extensionId}`);
  console.log('仅扩展上架时：用商店开发者控制台的公钥更新 manifest.key，再重新打包。');
  console.log('发布包已生成，尚未上传或发布。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageRelease().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
