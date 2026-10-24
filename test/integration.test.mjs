import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPlan, readPlan } from '../scripts/lib/plans.mjs';
import { createClient } from '../scripts/lib/api.mjs';
import { applyPlan } from '../scripts/lib/apply.mjs';

const APPROVE = fileURLToPath(new URL('../hooks/approve.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const ZID = '0123456789abcdef0123456789abcdef';
const BASE = 'https://api.test/client/v4';

function setup(t) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-int-')));
  const keyDir = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-intkey-')));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  return { cwd, keyDir };
}

function runHook(script, { cwd, keyDir }, input) {
  const res = spawnSync(process.execPath, [script], {
    input: JSON.stringify({ session_id: 'sess-int', cwd, ...input }),
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDEFLARE_KEY_DIR: keyDir },
  });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stderr, '');
  return JSON.parse(res.stdout);
}

// Stub Cloudflare API: GET returns the old value, PATCH echoes the new one.
function stubFetch() {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ method: init.method, url });
    const value = init.method === 'GET' ? 'flexible' : JSON.parse(init.body).value;
    return new Response(JSON.stringify({ success: true, result: { id: 'ssl', value } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return { calls, fetchImpl };
}

test('approve hook, guard ask and applyPlan run end to end', async (t) => {
  const ctx = setup(t);
  const plan = createPlan(ctx.cwd, {
    zone_id: ZID,
    zone_name: 'example.com',
    summary: 'Set SSL mode to Full (strict)',
    risk: 'Site returns 526 if the origin certificate is invalid.',
    ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
    slug: 'ssl-strict',
  });

  const approved = runHook(APPROVE, ctx, { hook_event_name: 'UserPromptSubmit', prompt: `/claudeflare:approve ${plan.id}` });
  assert.ok(approved.hookSpecificOutput.additionalContext.startsWith(`Approval recorded for ${plan.id}.`));

  const guarded = runHook(GUARD, ctx, {
    hook_event_name: 'PreToolUse',
    tool_name: 'Bash',
    tool_input: { command: `claudeflare apply ${plan.id}` },
  });
  assert.equal(guarded.hookSpecificOutput.permissionDecision, 'ask');
  assert.ok(guarded.hookSpecificOutput.permissionDecisionReason.includes(plan.summary));

  const { calls, fetchImpl } = stubFetch();
  const client = createClient({ token: 'tok-int', baseUrl: BASE, fetchImpl });
  const result = await applyPlan(ctx.cwd, client, plan.id);
  assert.equal(result.status, 'applied');
  assert.equal(readPlan(ctx.cwd, plan.id).status, 'applied');
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), [
    `GET ${BASE}/zones/${ZID}/settings/ssl`,
    `PATCH ${BASE}/zones/${ZID}/settings/ssl`,
  ]);
});
