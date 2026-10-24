import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectCode } from '../hooks/lib/inspect-code.mjs';
import { isAllowedCall } from '../hooks/lib/allowed-call.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

function markdownFiles(dir, recursive) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return recursive ? markdownFiles(path, true) : [];
    return entry.name.endsWith('.md') ? [path] : [];
  });
}

function jsBlocks(file) {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(/^```js\n([\s\S]*?)^```/gm)].map((m) => m[1]);
}

const files = [
  ...markdownFiles(join(ROOT, 'skills'), true),
  ...markdownFiles(join(ROOT, 'agents'), false),
  ...markdownFiles(join(ROOT, 'commands'), false),
];
const examples = files.flatMap((file) =>
  jsBlocks(file)
    .filter((code) => code.includes('cloudflare.request'))
    .map((code, index) => ({ name: `${relative(ROOT, file)} block ${index + 1}`, code })),
);

test('skill, agent and command docs contain execute examples', () => {
  assert.ok(examples.length > 0);
});

for (const { name, code } of examples) {
  test(`execute example passes the guard: ${name}`, () => {
    const { calls, determinable } = inspectCode(code);
    assert.equal(determinable, true, 'not in the canonical form');
    assert.ok(calls.length > 0, 'no cloudflare.request call');
    for (const call of calls) assert.ok(isAllowedCall(call), `${call.method} ${call.path} is not allowed`);
  });
}
