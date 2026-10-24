import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../scripts/lib/paths.mjs';
import { createPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { inspectCode } from '../hooks/lib/inspect-code.mjs';

const APPROVE = fileURLToPath(new URL('../hooks/approve.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const FIXTURES = new URL('./fixtures/hooks/', import.meta.url);
const ZID = '0123456789abcdef0123456789abcdef';
const T0 = new Date('2026-10-24T14:30:00Z');
const PLAN_ID = 'examplecom-20261024-143000-ssl-strict';
const PROTOCOL = 'Writes are not allowed through MCP. Create a plan with "claudeflare plan new" and follow the change protocol (skills/cf-core).';
const STATE = 'claudeflare state files are managed by the claudeflare CLI and hooks only.';

function setup(t, { plan = true } = {}) {
  const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-hooks-')));
  const keyDir = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-hookkey-')));
  const saved = process.env.CLAUDEFLARE_KEY_DIR;
  process.env.CLAUDEFLARE_KEY_DIR = keyDir;
  t.after(() => {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(keyDir, { recursive: true, force: true });
    if (saved === undefined) delete process.env.CLAUDEFLARE_KEY_DIR;
    else process.env.CLAUDEFLARE_KEY_DIR = saved;
  });
  if (plan) {
    createPlan(
      cwd,
      {
        zone_id: ZID,
        zone_name: 'example.com',
        summary: 'Set SSL mode to Full (strict)',
        risk: 'high',
        ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
        slug: 'ssl-strict',
      },
      T0,
    );
  }
  return { cwd, keyDir };
}

function fixture(name) {
  return JSON.parse(readFileSync(new URL(`${name}.json`, FIXTURES), 'utf8'));
}

function runHook(script, ctx, input) {
  const stdin = typeof input === 'string' ? input : JSON.stringify({ session_id: 'sess-1', cwd: ctx.cwd, ...input });
  const res = spawnSync(process.execPath, [script], {
    input: stdin,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDEFLARE_KEY_DIR: ctx.keyDir },
  });
  assert.equal(res.status, 0, `hook exited ${res.status}: ${res.stderr}`);
  assert.equal(res.stderr, '');
  return res.stdout.trim() ? JSON.parse(res.stdout) : null;
}

function guard(ctx, input) {
  const out = runHook(GUARD, ctx, input);
  if (out === null) return null;
  assert.equal(out.hookSpecificOutput.hookEventName, 'PreToolUse');
  return out.hookSpecificOutput;
}

function assertDeny(decision, reason) {
  assert.ok(decision, 'expected a decision');
  assert.equal(decision.permissionDecision, 'deny');
  if (reason) assert.ok(decision.permissionDecisionReason.includes(reason), decision.permissionDecisionReason);
}

const approvalFile = (cwd, id = PLAN_ID) => join(paths(cwd).approvals, `${id}.json`);
const bash = (command) => ({ tool_name: 'Bash', tool_input: { command } });
const execute = (code) => ({ tool_name: 'mcp__cloudflare__execute', tool_input: { code } });

// approve.mjs

test('approve writes approval for exact /claudeflare:approve <id>', (t) => {
  const ctx = setup(t);
  const out = runHook(APPROVE, ctx, fixture('approve-exact'));
  const approval = JSON.parse(readFileSync(approvalFile(ctx.cwd), 'utf8'));
  assert.equal(approval.plan_id, PLAN_ID);
  assert.equal(approval.session_id, 'sess-1');
  const hso = out.hookSpecificOutput;
  assert.equal(hso.hookEventName, 'UserPromptSubmit');
  assert.ok(hso.additionalContext.startsWith(`Approval recorded for ${PLAN_ID}. Run claudeflare apply ${PLAN_ID}.`));
  for (const part of ['Set SSL mode to Full (strict)', 'high', '1 op', approval.ops_hash.slice(7, 19)]) {
    assert.ok(hso.additionalContext.includes(part), `missing ${part}: ${hso.additionalContext}`);
  }
  assert.equal(out.systemMessage, hso.additionalContext);
});

test('approve ignores "please /claudeflare:approve x" mid-sentence', (t) => {
  const ctx = setup(t);
  assert.equal(runHook(APPROVE, ctx, fixture('approve-mid-sentence')), null);
  assert.equal(existsSync(approvalFile(ctx.cwd)), false);
});

test('approve ignores unrelated prompts', (t) => {
  const ctx = setup(t);
  assert.equal(runHook(APPROVE, ctx, { prompt: 'audit example.com' }), null);
});

test('approve with unknown plan does not write approval', (t) => {
  const ctx = setup(t);
  const out = runHook(APPROVE, ctx, fixture('approve-unknown'));
  const id = 'examplecom-20261024-143000-nope';
  assert.equal(out.hookSpecificOutput.additionalContext, `No plan ${id}; approval not recorded.`);
  assert.equal(existsSync(approvalFile(ctx.cwd, id)), false);
});

test('approve refuses a plan that is not draft', (t) => {
  const ctx = setup(t);
  updatePlan(ctx.cwd, PLAN_ID, { status: 'applied' });
  const out = runHook(APPROVE, ctx, fixture('approve-exact'));
  assert.equal(
    out.hookSpecificOutput.additionalContext,
    `Plan ${PLAN_ID} is applied; only draft plans can be approved.`,
  );
  assert.equal(existsSync(approvalFile(ctx.cwd)), false);
});

test('approve exits silently on malformed stdin', (t) => {
  const ctx = setup(t);
  assert.equal(runHook(APPROVE, ctx, '{not json'), null);
});

// guard.mjs: MCP execute

test('guard allows execute with method "GET" literal', (t) => {
  assert.equal(guard(setup(t), fixture('execute-get')), null);
});

test('guard allows POST to /graphql', (t) => {
  assert.equal(guard(setup(t), fixture('execute-graphql')), null);
});

test('guard denies execute with method "DELETE"', (t) => {
  assertDeny(guard(setup(t), fixture('execute-delete')), PROTOCOL);
});

test('guard denies execute with method: m (non-literal)', (t) => {
  assertDeny(guard(setup(t), fixture('execute-method-variable')), PROTOCOL);
});

test('guard denies execute with omitted method', (t) => {
  assertDeny(guard(setup(t), fixture('execute-method-omitted')), PROTOCOL);
});

test('guard denies execute with template literal method `${x}`', (t) => {
  assertDeny(guard(setup(t), fixture('execute-method-template')), PROTOCOL);
});

test('guard denies execute when a later call writes or code is not a string', (t) => {
  const ctx = setup(t);
  const mixed = "await cloudflare.request({ method: 'GET', path: '/zones' });\nawait cloudflare.request({ method: 'PUT', path: '/zones/a' });";
  assertDeny(guard(ctx, execute(mixed)), PROTOCOL);
  assertDeny(guard(ctx, execute("cloudflare.request({ method: 'POST', path: '/zones/a/purge_cache' })")), PROTOCOL);
  assertDeny(guard(ctx, { tool_name: 'mcp__cloudflare__execute', tool_input: {} }), PROTOCOL);
});

// guard.mjs: claudeflare apply

test('guard asks for claudeflare apply with valid approval, reason contains summary', (t) => {
  const ctx = setup(t);
  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' });
  const decision = guard(ctx, fixture('bash-apply'));
  assert.equal(decision.permissionDecision, 'ask');
  assert.equal(
    decision.permissionDecisionReason,
    `Apply plan ${PLAN_ID}: Set SSL mode to Full (strict). Risk: high. Ops: PATCH /zones/${ZID}/settings/ssl`,
  );
});

test('guard ask reason lists at most 20 ops', (t) => {
  const ctx = setup(t);
  const ops = Array.from({ length: 23 }, (_, i) => ({ method: 'DELETE', path: `/zones/${ZID}/dns_records/${i}` }));
  updatePlan(ctx.cwd, PLAN_ID, { ops });
  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' });
  const reason = guard(ctx, bash(`node /x/scripts/cf.mjs apply ${PLAN_ID}`)).permissionDecisionReason;
  assert.ok(reason.includes(`DELETE /zones/${ZID}/dns_records/19 (+3 more)`), reason);
  assert.ok(!reason.includes('dns_records/20'));
});

test('guard denies claudeflare apply when approval expired / hash mismatch / missing', (t) => {
  const ctx = setup(t);
  const missing = guard(ctx, fixture('bash-apply'));
  assertDeny(missing, 'missing');
  assertDeny(missing, `Ask the user to run /claudeflare:approve ${PLAN_ID}`);

  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' }, new Date(Date.now() - 2 * 3600 * 1000));
  assertDeny(guard(ctx, fixture('bash-apply')), 'expired');

  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' });
  updatePlan(ctx.cwd, PLAN_ID, { ops: [{ method: 'DELETE', path: `/zones/${ZID}/dns_records/1` }] });
  const mismatch = guard(ctx, fixture('bash-apply'));
  assertDeny(mismatch, 'hash_mismatch');
  assertDeny(mismatch, `Ask the user to run /claudeflare:approve ${PLAN_ID}`);
});

test('guard denies claudeflare apply when the plan file is corrupt', (t) => {
  const ctx = setup(t);
  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' });
  const planPath = join(paths(ctx.cwd).plans, `${PLAN_ID}.json`);
  writeFileSync(planPath, '{broken');
  assertDeny(guard(ctx, fixture('bash-apply')), `Ask the user to run /claudeflare:approve ${PLAN_ID}`);
});

// guard.mjs: curl to the API

test('guard denies curl -X POST https://api.cloudflare.com/...', (t) => {
  assertDeny(guard(setup(t), fixture('bash-curl-post')), PROTOCOL);
});

test('guard denies curl --data to api.cloudflare.com', (t) => {
  assertDeny(guard(setup(t), fixture('bash-curl-data')), PROTOCOL);
});

test('guard denies other curl write forms and allows curl GET', (t) => {
  const ctx = setup(t);
  const url = 'https://api.cloudflare.com/client/v4/zones/abc';
  for (const cmd of [`curl -XDELETE ${url}`, `curl --request=PATCH ${url}`, `curl -sX PUT ${url}`, `curl -d '{}' ${url}`, `curl -F a=b ${url}`, `curl --json '{}' ${url}`, `curl --data-binary @f ${url}`]) {
    assertDeny(guard(ctx, bash(cmd)), PROTOCOL);
  }
  assert.equal(guard(ctx, bash(`curl -s -X GET ${url}`)), null);
  assert.equal(guard(ctx, bash(`curl -s ${url}`)), null);
});

test('guard silent for unrelated Bash (ls)', (t) => {
  assert.equal(guard(setup(t), fixture('bash-ls')), null);
});

test('guard silent for claudeflare get', (t) => {
  assert.equal(guard(setup(t), fixture('bash-get')), null);
});

// guard.mjs: approval state protection

test('guard denies file tools writing inside .claudeflare/ or the key dir', (t) => {
  const ctx = setup(t);
  const cases = [
    { tool_name: 'Write', tool_input: { file_path: join(ctx.cwd, '.claudeflare/approvals/x.json'), content: '{}' } },
    { tool_name: 'Edit', tool_input: { file_path: '.claudeflare/plans/x.json', old_string: 'a', new_string: 'b' } },
    { tool_name: 'MultiEdit', tool_input: { file_path: join(ctx.cwd, 'sub/../.claudeflare/snapshots/a.json'), edits: [] } },
    { tool_name: 'NotebookEdit', tool_input: { notebook_path: join(ctx.cwd, '.claudeflare/n.ipynb'), new_source: '' } },
    { tool_name: 'Write', tool_input: { file_path: join(ctx.keyDir, 'approval.key'), content: 'x' } },
    { tool_name: 'Write', tool_input: { file_path: join(ctx.cwd, '.claudeflare'), content: 'x' } },
  ];
  for (const input of cases) assertDeny(guard(ctx, input), STATE);
});

test('guard silent for file tools writing elsewhere', (t) => {
  const ctx = setup(t);
  assert.equal(guard(ctx, { tool_name: 'Write', tool_input: { file_path: join(ctx.cwd, 'notes.md'), content: '' } }), null);
  assert.equal(guard(ctx, { tool_name: 'Edit', tool_input: { file_path: join(ctx.cwd, '.claudeflare-notes.md') } }), null);
});

test('guard denies Bash touching approval state', (t) => {
  const ctx = setup(t);
  const cmds = [
    `cat .claudeflare/approvals/${PLAN_ID}.json`,
    `sed -i '' s/a/b/ .claudeflare/plans/${PLAN_ID}.json`,
    'rm -rf .claudeflare/snapshots',
    'cp x approval.key',
    'ls ~/.config/claudeflare',
    `ls ${ctx.keyDir}`,
    'node -e "import(\'./scripts/lib/approvals.mjs\')"',
    'cat scripts/lib/approval-key.mjs',
  ];
  for (const cmd of cmds) assertDeny(guard(ctx, bash(cmd)), STATE);
});

test('guard exits silently on malformed stdin', (t) => {
  assert.equal(runHook(GUARD, setup(t), 'nope'), null);
});

test('hooks.json wires approve to UserPromptSubmit and guard to PreToolUse', () => {
  const config = JSON.parse(readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf8')).hooks;
  assert.equal(config.UserPromptSubmit[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/approve.mjs"');
  assert.equal(config.PreToolUse[0].matcher, 'Bash|Read|Grep|Glob|Write|Edit|MultiEdit|NotebookEdit|mcp__.*cloudflare.*__execute');
  assert.equal(config.PreToolUse[0].hooks[0].command, 'node "${CLAUDE_PLUGIN_ROOT}/hooks/guard.mjs"');
});

// Fix round 1

test('guard deny wins over ask: valid apply chained with a curl DELETE is denied', (t) => {
  const ctx = setup(t);
  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' });
  const cmd = `claudeflare apply ${PLAN_ID} && curl -X DELETE https://api.cloudflare.com/client/v4/zones/abc`;
  assertDeny(guard(ctx, bash(cmd)), PROTOCOL);
});

test('guard denies execute using an alias, bracket access, .call or fetch', (t) => {
  const ctx = setup(t);
  for (const code of [
    "const r = cloudflare.request; return r({ method: 'DELETE', path: '/zones/a' });",
    "return cloudflare['request']({ method: 'DELETE', path: '/zones/a' });",
    "return cloudflare.request.call(null, { method: 'DELETE', path: '/zones/a' });",
    "return fetch('https://api.cloudflare.com/client/v4/zones/a', { method: 'DELETE' });",
    "return cloudflare.request({ method: 'GET', ['method']: 'DELETE', path: '/zones/a' });",
  ]) {
    assertDeny(guard(ctx, execute(code)), PROTOCOL);
  }
});

test('guard allows POST only to exact graphql paths', (t) => {
  const ctx = setup(t);
  const post = (path) => execute(`await cloudflare.request({ method: 'POST', path: '${path}' });`);
  assert.equal(guard(ctx, post('/client/v4/graphql')), null);
  for (const path of ['/graphql?x=1', '/graphql#x', '/zones/x/graphql']) {
    assertDeny(guard(ctx, post(path)), PROTOCOL);
  }
});

test('guard denies file tools on any .claudeflare segment regardless of cwd', (t) => {
  const ctx = setup(t);
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-othercwd-')));
  t.after(() => rmSync(other, { recursive: true, force: true }));
  const input = { tool_name: 'Write', tool_input: { file_path: join(ctx.cwd, '.claudeflare/approvals/x.json'), content: '{}' } };
  assertDeny(guard(ctx, { ...input, cwd: other }), STATE);
  const nested = { tool_name: 'Edit', tool_input: { file_path: join(other, 'a/.claudeflare/plans/p.json') } };
  assertDeny(guard(ctx, { ...nested, cwd: ctx.cwd }), STATE);
});

test('guard denies curl upload and mixed-case API host', (t) => {
  const ctx = setup(t);
  assertDeny(guard(ctx, bash('curl -T body.json https://api.cloudflare.com/client/v4/zones/a')), PROTOCOL);
  assertDeny(guard(ctx, bash('curl --upload-file body.json https://api.cloudflare.com/client/v4/zones/a')), PROTOCOL);
  assertDeny(guard(ctx, bash('curl -X PUT https://API.Cloudflare.com/client/v4/zones/a')), PROTOCOL);
});

test('guard denies Read of the key dir but allows reading plans', (t) => {
  const ctx = setup(t);
  assertDeny(guard(ctx, { tool_name: 'Read', tool_input: { file_path: join(ctx.keyDir, 'approval.key') } }), STATE);
  const planPath = join(paths(ctx.cwd).plans, `${PLAN_ID}.json`);
  assert.equal(guard(ctx, { tool_name: 'Read', tool_input: { file_path: planPath } }), null);
});

test('approve reports a clear message and writes nothing when writeApproval throws', (t) => {
  const ctx = setup(t);
  const blocker = join(ctx.keyDir, 'not-a-dir');
  writeFileSync(blocker, 'x');
  const out = runHook(APPROVE, { ...ctx, keyDir: join(blocker, 'sub') }, fixture('approve-exact'));
  const message = out.hookSpecificOutput.additionalContext;
  assert.ok(message.startsWith(`Approval for ${PLAN_ID} was not recorded: `), message);
  assert.equal(out.systemMessage, message);
  assert.equal(existsSync(approvalFile(ctx.cwd)), false);
});

// Fix round 2

test('guard denies execute bypasses: computed key, escaped identifier, fetch.call, fetch alias', (t) => {
  const ctx = setup(t);
  for (const code of [
    "const k = 'req' + 'uest'; return cloudflare[k]({ method: 'DELETE', path: '/zones/a' });",
    "return cloudflare.requ\\u0065st({ method: 'DELETE', path: '/zones/a' });",
    "return fetch.call(null, 'https://api.cloudflare.com/client/v4/zones/a', { method: 'DELETE' });",
    "const f = fetch; return f('https://api.cloudflare.com/client/v4/zones/a', { method: 'DELETE' });",
  ]) {
    assertDeny(guard(ctx, execute(code)), PROTOCOL);
  }
});

test('guard denies execute code with zero calls', (t) => {
  assertDeny(guard(setup(t), execute('return 1+1')), PROTOCOL);
});

test('guard allows a plain GET call with a comment', (t) => {
  const code = "// list zones for the account\nconst zones = await cloudflare.request({ method: 'GET', path: '/zones' });\nreturn zones;";
  assert.equal(guard(setup(t), execute(code)), null);
});

test('guard denies Grep and Glob on the key dir', (t) => {
  const ctx = setup(t);
  assertDeny(guard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x', path: ctx.keyDir } }), STATE);
  assertDeny(guard(ctx, { tool_name: 'Glob', tool_input: { pattern: '*', path: ctx.keyDir } }), STATE);
  assertDeny(guard(ctx, { tool_name: 'Glob', tool_input: { pattern: join(ctx.keyDir, '*.key') } }), STATE);
  assert.equal(guard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x', path: ctx.cwd } }), null);
  assert.equal(guard(ctx, { tool_name: 'Glob', tool_input: { pattern: '**/*.json' } }), null);
});

// Fix round 3: strict grammar

test('inspectCode accepts the grammar', () => {
  const ok = (code, calls) => assert.deepEqual(inspectCode(code), { calls, determinable: true }, code);
  ok("await cloudflare.request({ method: 'GET', path: '/zones' });", [{ method: 'GET', path: '/zones' }]);
  ok(
    "const a = await cloudflare.request({ method: 'GET', path: '/zones' })\nlet b = cloudflare.request({ \"method\": \"GET\", path: `/zones/x`, })\nreturn [a, b];",
    [{ method: 'GET', path: '/zones' }, { method: 'GET', path: '/zones/x' }],
  );
  ok(
    "/* list */ const r = await cloudflare.request({ method: 'GET', path: '/zones', query: { per_page: 50, match: 'all', ids: [1, 2], ok: true, x: null } }); // c\nreturn { r };",
    [{ method: 'GET', path: '/zones' }],
  );
  ok(
    "const g = await cloudflare.request({ method: 'POST', path: '/graphql', body: { query: '{ viewer { zones } }', variables: { tag: 'abc', limit: 10 } } });\nreturn g;",
    [{ method: 'POST', path: '/graphql' }],
  );
});

test('inspectCode rejects everything outside the grammar', () => {
  const get = "cloudflare.request({ method: 'GET', path: '/zones' })";
  for (const code of [
    `const x = /'/; await ${get}; cloudflare.request({ method: 'DELETE', path: '/z' /' })`,
    "const k = 'request'; await cloudflare?.[k]({ method: 'DELETE', path: '/zones/a' });",
    "Object.entries(cloudflare).forEach(([k, f]) => f({ method: 'DELETE', path: '/zones/a' }));",
    `for (const z of [1]) { await ${get}; }`,
    `const f = () => ${get}; await f();`,
    "await cloudflare.request({ method: 'GET', path: `/zones/${id}` });",
    "await cloudflare.request({ method: 'GET', path: '/zones\\x2f' });",
    "await cloudflare.request({ method: 'GET', path: '/zones', headers: { a: 'b' } });",
    "await cloudflare.request({ path: '/zones' });",
    "await cloudflare.request({ method: 'GET', method: 'DELETE' });",
    "await cloudflare.request({ method: 'GET', ...opts });",
    'return 1+1',
    `await ${get}; return nope;`,
    "const k = 'req' + 'uest'; return cloudflare[k]({ method: 'DELETE', path: '/zones/a' });",
    "await cloudflare.requ\\u0065st({ method: 'DELETE', path: '/zones/a' });",
    "await fetch.call(null, 'https://api.cloudflare.com/client/v4/zones/a', { method: 'DELETE' });",
    "const f = fetch; await f('https://api.cloudflare.com/client/v4/zones/a', { method: 'DELETE' });",
  ]) {
    assert.deepEqual(inspectCode(code), { calls: [], determinable: false }, code);
  }
});

test('guard denies Grep on a parent of the key dir and searches with no path from a parent cwd', (t) => {
  const ctx = setup(t);
  const parent = join(ctx.keyDir, '..');
  assertDeny(guard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x', path: parent } }), STATE);
  assertDeny(guard({ ...ctx, cwd: parent }, { tool_name: 'Grep', tool_input: { pattern: 'x' }, cwd: parent }), STATE);
  assertDeny(guard(ctx, { tool_name: 'Glob', tool_input: { pattern: join(parent, '**/*.key') } }), STATE);
});
