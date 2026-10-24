import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const KEY_FILE = 'approval.key';
const KEY_BYTES = 32;

function keyDir() {
  return process.env.CLAUDEFLARE_KEY_DIR || join(homedir(), '.config', 'claudeflare');
}

function readKey(file) {
  try {
    return readFileSync(file);
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

export function getApprovalKey({ create = false } = {}) {
  const dir = keyDir();
  const file = join(dir, KEY_FILE);
  if (!create) return readKey(file);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = randomBytes(KEY_BYTES);
  try {
    writeFileSync(file, key, { flag: 'wx', mode: 0o600 });
    return key;
  } catch (err) {
    if (err.code === 'EEXIST') return readFileSync(file);
    throw err;
  }
}
