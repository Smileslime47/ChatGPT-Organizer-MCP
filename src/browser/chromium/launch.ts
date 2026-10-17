import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join, posix, win32 } from 'node:path';
import { chromium } from 'playwright';
import { OrganizerError } from '../../core/errors.js';

interface BrowserChoice { executablePath: string }
interface BrowserLaunchOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  cwd?: string;
  home?: string;
  exists?: (path: string) => boolean;
  chromiumPath?: () => string;
  spawn?: typeof spawn;
}

function available(path: string): boolean {
  try { return statSync(path).isFile(); } catch { return false; }
}

function choiceError(): OrganizerError {
  return new OrganizerError('BROWSER_CHOICE_CONFLICT', '此数据目录已绑定另一个浏览器。请沿用原浏览器，或设置新的 CHATGPT_DATA_DIR 后重新登录；不同浏览器不能共用登录目录。');
}

export async function resolveBrowser(directory: string, options: BrowserLaunchOptions = {}): Promise<BrowserChoice> {
  const { env = process.env, platform = process.platform, cwd = process.cwd(), home = homedir(),
    exists = available, chromiumPath = () => chromium.executablePath() } = options;
  const path = platform === 'win32' ? win32 : posix;
  const equal = (a: string, b: string) => platform === 'win32'
    ? path.normalize(a).toLowerCase() === path.normalize(b).toLowerCase() : path.normalize(a) === path.normalize(b);
  const channel = env.CHATGPT_BROWSER_CHANNEL;
  if (channel && !['chrome', 'msedge', 'chromium'].includes(channel)) {
    throw new OrganizerError('INVALID_BROWSER_CHANNEL', 'CHATGPT_BROWSER_CHANNEL 仅支持 chrome、msedge 或 chromium。');
  }
  if (channel && env.CHATGPT_BROWSER_EXECUTABLE) {
    throw new OrganizerError('INVALID_BROWSER_CONFIGURATION', '请只设置 CHATGPT_BROWSER_EXECUTABLE 或 CHATGPT_BROWSER_CHANNEL 中的一项。');
  }
  const filename = join(directory, 'browser-choice.json');
  async function readChoice(): Promise<BrowserChoice | undefined> {
    try {
      const saved: unknown = JSON.parse(await readFile(filename, 'utf8'));
      if (!saved || typeof saved !== 'object' || !('executablePath' in saved)
        || typeof saved.executablePath !== 'string' || !path.isAbsolute(saved.executablePath)) throw new Error();
      return { executablePath: saved.executablePath };
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return undefined;
      throw new OrganizerError('BROWSER_CHOICE_INVALID', '无法读取浏览器选择配置。请检查 browser-choice.json，或设置新的 CHATGPT_DATA_DIR。');
    }
  }
  const saved = await readChoice();
  if (saved && !channel && !env.CHATGPT_BROWSER_EXECUTABLE) {
    if (!exists(saved.executablePath)) throw new OrganizerError('BROWSER_NOT_FOUND', '已选择的浏览器不再可用。请恢复该浏览器，或设置新的 CHATGPT_DATA_DIR 后重新登录。');
    return saved;
  }

  const paths: Record<string, string[]> = { chrome: [], msedge: [], chromium: [] };
  if (platform === 'win32') {
    const roots = [env.PROGRAMFILES, env['PROGRAMFILES(X86)'], env.LOCALAPPDATA,
      `${env.SYSTEMDRIVE ?? 'C:'}\\Program Files`, `${env.SYSTEMDRIVE ?? 'C:'}\\Program Files (x86)`]
      .filter((root): root is string => Boolean(root));
    for (const root of roots) {
      paths.chrome.push(path.join(root, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      paths.msedge.push(path.join(root, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
      paths.chromium.push(path.join(root, 'Chromium', 'Application', 'chrome.exe'));
    }
  } else if (platform === 'darwin') {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      paths.chrome.push(path.join(root, 'Google Chrome.app', 'Contents', 'MacOS', 'Google Chrome'));
      paths.msedge.push(path.join(root, 'Microsoft Edge.app', 'Contents', 'MacOS', 'Microsoft Edge'));
      paths.chromium.push(path.join(root, 'Chromium.app', 'Contents', 'MacOS', 'Chromium'));
    }
  } else {
    paths.chrome.push('/opt/google/chrome/chrome');
    paths.msedge.push('/opt/microsoft/msedge/msedge');
  }
  const names = platform === 'win32'
    ? { chrome: ['chrome.exe'], msedge: ['msedge.exe'], chromium: ['chromium.exe'] }
    : { chrome: ['google-chrome', 'google-chrome-stable'], msedge: ['microsoft-edge', 'microsoft-edge-stable'], chromium: ['chromium', 'chromium-browser'] };
  const searchPath = (env.PATH ?? env.Path ?? '').split(path.delimiter).map(item => item.replace(/^"(.*)"$/, '$1'));
  if (platform !== 'win32') searchPath.push('/usr/local/bin', '/usr/bin', '/snap/bin');
  for (const root of searchPath.filter(item => path.isAbsolute(item))) {
    for (const [name, commands] of Object.entries(names)) paths[name].push(...commands.map(command => path.join(root, command)));
  }
  paths.chromium.push(chromiumPath());
  const candidates = channel ? paths[channel] : [...paths.chrome, ...paths.msedge, ...paths.chromium];
  const explicit = env.CHATGPT_BROWSER_EXECUTABLE ? path.resolve(cwd, env.CHATGPT_BROWSER_EXECUTABLE) : undefined;
  const executablePath = explicit ?? (saved && candidates.some(candidate => equal(candidate, saved.executablePath))
    ? saved.executablePath : candidates.find(exists));
  if (saved && (!executablePath || !equal(saved.executablePath, executablePath))) throw choiceError();
  if (!executablePath || !exists(executablePath)) {
    throw new OrganizerError('BROWSER_NOT_FOUND', '未找到可用的 Chrome、Edge 或 Chromium。请检查浏览器路径或通道，或运行 npx playwright@1.64.1 install chromium。');
  }
  const selected = { executablePath };
  if (saved) return selected;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(temporary, `${JSON.stringify(selected)}\n`, { flag: 'wx', mode: 0o600 });
    // Publish a complete file without replacing another process's choice.
    await link(temporary, filename);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'EEXIST') {
      throw new OrganizerError('BROWSER_CHOICE_SAVE_FAILED', '无法保存浏览器选择，请检查数据目录的写入权限。');
    }
    const concurrent = await readChoice();
    if (!concurrent || !equal(concurrent.executablePath, executablePath)) throw choiceError();
  } finally { await unlink(temporary).catch(() => {}); }
  return selected;
}

export async function openLoginBrowser(directory: string, options: BrowserLaunchOptions = {}): Promise<ChildProcess> {
  const { executablePath } = await resolveBrowser(directory, options);
  const profile = join(directory, 'browser');
  const launchError = () => new OrganizerError('BROWSER_LAUNCH_FAILED', '无法启动登录窗口。请检查浏览器安装、数据目录权限以及是否已有专用窗口正在使用该目录。');
  try { await mkdir(profile, { recursive: true, mode: 0o700 }); } catch { throw launchError(); }
  return new Promise<ChildProcess>((resolve, reject) => {
    const failed = () => reject(launchError());
    try {
      const child = (options.spawn ?? spawn)(executablePath, [`--user-data-dir=${profile}`, '--new-window', 'https://chatgpt.com'], {
        shell: false, stdio: 'ignore', windowsHide: false,
      });
      child.once('error', failed);
      child.once('spawn', () => resolve(child));
    } catch { failed(); }
  });
}
