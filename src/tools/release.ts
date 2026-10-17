import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

async function packageRelease(): Promise<void> {
  const projectDirectory = fileURLToPath(new URL('../../', import.meta.url));
  const npm = process.env.npm_execpath;
  if (!npm) throw new Error('请使用 npm run package 构建发布包。');
  const outputDirectory = resolve(projectDirectory, 'release');
  await mkdir(outputDirectory, { recursive: true });
  const { stdout } = await promisify(execFile)(process.execPath, [
    npm, 'pack', '--ignore-scripts', '--pack-destination', outputDirectory, '--json',
  ], { cwd: projectDirectory, maxBuffer: 4 * 1024 * 1024 });
  const packages = JSON.parse(stdout);
  const filename = packages[0]?.filename;
  if (packages.length !== 1 || typeof filename !== 'string' || basename(filename) !== filename) {
    throw new Error('npm pack 返回了无效的发布文件名。');
  }
  console.log('MCP 服务：release/' + filename);
  console.log('发布包已生成，尚未上传或发布。');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  packageRelease().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
