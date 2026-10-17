import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

interface DataDirectoryOptions {
  root: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
  exists?: (path: string) => boolean;
}

export function dataDirectory({
  root, env = process.env, platform = process.platform, home = homedir(), cwd = process.cwd(), exists = existsSync,
}: DataDirectoryOptions): string {
  const path = platform === 'win32' ? win32 : posix;
  if (env.CHATGPT_DATA_DIR) return path.resolve(cwd, env.CHATGPT_DATA_DIR);

  // Preserve existing source installations without placing new data in npx's cache.
  const legacy = path.join(root, '.local');
  if (['project-routes.json', 'browser-choice.json', 'browser'].some(name => exists(path.join(legacy, name)))) return legacy;

  if (platform === 'win32') {
    return path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'chatgpt-organizer');
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'chatgpt-organizer');
  const base = env.XDG_DATA_HOME && path.isAbsolute(env.XDG_DATA_HOME)
    ? env.XDG_DATA_HOME : path.join(home, '.local', 'share');
  return path.join(base, 'chatgpt-organizer');
}
