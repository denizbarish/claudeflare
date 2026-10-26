// Which project owns a secret file. Shared by the CLI (where the index is
// written) and the guard (where it is read), so both always agree. Node
// built-ins only: the hooks import this file.
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const STATE_DIR = '.claudeflare';

// Nearest directory at or above start that holds name, or null. Walks
// ancestors only, never down into other folders.
export function findUp(start, name) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return dir;
    if (dirname(dir) === dir) return null;
  }
}

// Nearest directory at or above start holding .claudeflare, or null.
export const claudeflareRoot = (start) => findUp(start, STATE_DIR);

// The project for a secret file: the nearest ancestor of the file, then of
// cwd, that holds .claudeflare; else the git root of the file; else cwd.
export function secretProjectRoot(file, cwd) {
  const dir = dirname(resolve(cwd, file));
  return claudeflareRoot(dir) ?? claudeflareRoot(cwd) ?? findUp(dir, '.git') ?? resolve(cwd);
}
