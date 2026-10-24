import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const FORBIDDEN = /[\u2014\u2013]/;

function repoFiles() {
  const list = (args) =>
    execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' })
      .split('\0')
      .filter(Boolean);
  const files = new Set([...list([]), ...list(['--others', '--exclude-standard'])]);
  return [...files].filter(
    (f) => !f.split('/').some((part) => part === '.git' || part === 'node_modules'),
  );
}

function isText(buf) {
  return !buf.includes(0);
}

test('no em dash or en dash characters in repo files', () => {
  const hits = [];
  for (const file of repoFiles()) {
    let buf;
    try {
      buf = readFileSync(`${root}${file}`);
    } catch {
      continue; // listed but deleted from the working tree
    }
    if (!isText(buf)) continue;
    buf
      .toString('utf8')
      .split('\n')
      .forEach((line, i) => {
        if (FORBIDDEN.test(line)) hits.push(`${file}:${i + 1}`);
      });
  }
  assert.deepEqual(hits, [], `Dash characters found:\n${hits.join('\n')}`);
});
