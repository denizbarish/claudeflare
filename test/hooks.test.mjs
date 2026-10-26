import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { paths } from '../scripts/lib/paths.mjs';
import { createPlan, updatePlan } from '../scripts/lib/plans.mjs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { inspectCode } from '../hooks/lib/inspect-code.mjs';
import { decideWrangler, WRANGLER_REASON } from '../hooks/lib/wrangler-rules.mjs';

const APPROVE = fileURLToPath(new URL('../hooks/approve.mjs', import.meta.url));
const GUARD = fileURLToPath(new URL('../hooks/guard.mjs', import.meta.url));
const FIXTURES = new URL('./fixtures/hooks/', import.meta.url);
const ZID = '0123456789abcdef0123456789abcdef';
const T0 = new Date('2026-10-24T14:30:00Z');
const PLAN_ID = 'examplecom-20261024-143000-ssl-strict';
const PROTOCOL = 'Writes are not allowed through MCP. Create a plan with "claudeflare plan new" and follow the change protocol (skills/cf-core).';
const CANONICAL = 'This execute code is not in the canonical read form. Use the async wrapper with literal method "GET" and literal path, as in skills/cf-core section 3.';
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

test('approve and guard messages do not double the period after summary and risk', (t) => {
  const ctx = setup(t, { plan: false });
  createPlan(
    ctx.cwd,
    {
      zone_id: ZID,
      zone_name: 'example.com',
      summary: 'Set SSL mode to Full (strict).',
      risk: 'None, reversible.',
      ops: [{ method: 'PATCH', path: '/zones/{zone_id}/settings/ssl', body: { value: 'strict' } }],
      slug: 'ssl-strict',
    },
    T0,
  );
  const approved = runHook(APPROVE, ctx, fixture('approve-exact')).systemMessage;
  assert.ok(!approved.includes('..'), approved);
  assert.ok(approved.includes('Approved: Set SSL mode to Full (strict). Risk: None, reversible. 1 op'), approved);
  const reason = guard(ctx, bash(`claudeflare apply ${PLAN_ID}`)).permissionDecisionReason;
  assert.ok(!reason.includes('..'), reason);
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
  assertDeny(guard(setup(t), fixture('execute-method-variable')), CANONICAL);
});

test('guard denies execute with omitted method', (t) => {
  assertDeny(guard(setup(t), fixture('execute-method-omitted')), CANONICAL);
});

test('guard denies execute with template literal method `${x}`', (t) => {
  assertDeny(guard(setup(t), fixture('execute-method-template')), PROTOCOL);
});

test('guard denies execute when a later call writes or code is not a string', (t) => {
  const ctx = setup(t);
  const mixed = "await cloudflare.request({ method: 'GET', path: '/zones' });\nawait cloudflare.request({ method: 'PUT', path: '/zones/a' });";
  assertDeny(guard(ctx, execute(mixed)), PROTOCOL);
  assertDeny(guard(ctx, execute("cloudflare.request({ method: 'POST', path: '/zones/a/purge_cache' })")), PROTOCOL);
  assertDeny(guard(ctx, { tool_name: 'mcp__cloudflare__execute', tool_input: {} }), CANONICAL);
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
  assertDeny(guard(setup(t), execute('return 1+1')), CANONICAL);
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

test('inspectCode rejects line-break tricks, odd whitespace and non-ASCII outside strings', () => {
  const get = "await cloudflare.request({ method: 'GET', path: '/zones' });";
  const hidden = "await fetch('https://api.cloudflare.com/client/v4/zones/a', { method: 'DELETE' });";
  for (const code of [
    `${get} // note\r${hidden}`,
    `${get} // note ${hidden}`,
    `${get} // note ${hidden}`,
    "const zoneé = await cloudflare.request({ method: 'GET', path: '/zones' }); return zoneé;",
    `${get} // café`,
    "await\vcloudflare.request({ method: 'GET', path: '/zones' });",
  ]) {
    assert.deepEqual(inspectCode(code), { calls: [], determinable: false }, JSON.stringify(code));
  }
  assert.deepEqual(inspectCode("await cloudflare.request({ method: 'GET', path: '/zones/café' });"), {
    calls: [{ method: 'GET', path: '/zones/café' }],
    determinable: true,
  });
});

// Follow-up: official server code shape (async arrow wrapper, result chains)

test('guard allows the official README GET example', (t) => {
  const code = 'async () => {\n  const response = await cloudflare.request({\n    method: "GET",\n    path: "/zones/abc/settings"\n  });\n  return response.result;\n}';
  assert.equal(guard(setup(t), execute(code)), null);
});

test('guard allows the official README GraphQL example shape', (t) => {
  const code = 'async () => {\n  const response = await cloudflare.request({\n    method: "POST",\n    path: "/client/v4/graphql",\n    body: { query: `query { viewer { zones(filter: { zoneTag: "abc" }) { zoneTag } } }`, variables: {} }\n  });\n  return response.result;\n}';
  assert.equal(guard(setup(t), execute(code)), null);
});

test('guard allows a wrapper with two calls returning result chains', (t) => {
  const code = "async () => {\n  const a = await cloudflare.request({ method: 'GET', path: '/zones' });\n  const b = await cloudflare.request({ method: 'GET', path: '/zones/abc/settings' });\n  return { zones: a.result, settings: b.result };\n};";
  assert.equal(guard(setup(t), execute(code)), null);
});

test('guard denies wrapper and return shapes outside the grammar', (t) => {
  const ctx = setup(t);
  const get = "const a = await cloudflare.request({ method: 'GET', path: '/zones' });";
  for (const code of [
    `async (x) => { ${get} return a.result; }`,
    `() => { ${get} return a.result; }`,
    `async () => { ${get} return a.result.map(f); }`,
    `async () => { ${get} return a["result"]; }`,
    `async () => { ${get} return nope.result; }`,
    `async () => { ${get} return { zones: nope.result }; }`,
    `async () => { ${get} return a.result; } fetch('https://x');`,
    `async () => { ${get} return a.result; }; ${get}`,
    `async () = > { ${get} return a.result; }`,
    "async () => { await cloudflare.request({ method: 'get', path: '/zones' }); }",
    "await cloudflare.request({ method: 'get', path: '/zones' });",
  ]) {
    assertDeny(guard(ctx, execute(code)), CANONICAL);
  }
  const post = "async () => { await cloudflare.request({ method: 'poſt', path: '/client/v4/graphql' }); }";
  assertDeny(guard(ctx, execute(post)), PROTOCOL);
});

test('guard execute deny reason: protocol for a write, canonical for unreadable code', (t) => {
  const ctx = setup(t);
  for (const code of [
    "async () => { const r = await cloudflare.request({ method: 'PATCH', path: '/zones/a/settings/ssl' }); return r.result; }",
    "async () => { await cloudflare.request({ method: 'POST', path: '/zones/a/purge_cache' }); }",
    "return fetch('https://api.cloudflare.com/client/v4/zones/a', { method: 'delete' });",
  ]) {
    assertDeny(guard(ctx, execute(code)), PROTOCOL);
  }
  for (const code of [
    "async () => { const p = '/zones'; return await cloudflare.request({ method: 'GET', path: p }); }",
    "for (const z of ['a']) { await cloudflare.request({ method: 'GET', path: '/zones' }); }",
    'return 1+1',
  ]) {
    assertDeny(guard(ctx, execute(code)), CANONICAL);
  }
});

test('inspectCode reads the wrapper and rejects code after it', () => {
  const get = "const a = await cloudflare.request({ method: 'GET', path: '/zones' });";
  assert.deepEqual(inspectCode(`/* c */ async () => { ${get} return [a.result, a.result_info,]; } // end`), {
    calls: [{ method: 'GET', path: '/zones' }],
    determinable: true,
  });
  for (const code of [`async () => { ${get} } x`, `async () => { ${get} }}`, `${get} return a.result.map;x`]) {
    assert.deepEqual(inspectCode(code), { calls: [], determinable: false }, code);
  }
});

test('guard limits Grep/Glob key-dir denial to paths inside the key dir', (t) => {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-home-')));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const config = join(home, '.config');
  const keyDir = join(config, 'claudeflare');
  mkdirSync(keyDir, { recursive: true });
  const ctx = { cwd: home, keyDir };
  assert.equal(guard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x', path: config } }), null);
  assert.equal(guard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x' } }), null);
  assert.equal(guard(ctx, { tool_name: 'Glob', tool_input: { pattern: '**/*.key' } }), null);
  assertDeny(guard(ctx, { tool_name: 'Grep', tool_input: { pattern: 'x', path: join(keyDir, 'sub') } }), STATE);
  assertDeny(guard(ctx, { tool_name: 'Glob', tool_input: { pattern: `${keyDir}/*` } }), STATE);
});

// guard.mjs: direct wrangler

const WRANGLER_PREFIXES = ['wrangler', 'npx wrangler', 'npx --yes wrangler@4', 'pnpm wrangler', 'pnpm exec wrangler', 'yarn wrangler', 'bunx wrangler', 'npm exec --', './node_modules/.bin/wrangler', 'node node_modules/wrangler/bin/wrangler.js'];
const WRANGLER_WRITES = [
  'deploy', 'deploy --name api', 'versions deploy v1@100% --yes', 'versions upload', 'rollback --name api', 'delete --name api', 'publish',
  'secret put KEY --name api', 'secret delete KEY', 'secret bulk secrets.json', 'd1 execute db --remote --command x',
  'd1 migrations apply db --remote', 'd1 time-travel restore db --bookmark b', 'd1 create db', 'd1 delete db',
  'r2 bucket create b', 'r2 bucket delete b', 'r2 object put b/k --file f', 'r2 object delete b/k', 'kv namespace create n',
  'kv namespace delete --namespace-id x', 'kv key put k v --namespace-id x', 'kv key delete k', 'kv bulk put f.json', 'kv bulk delete f.json',
  'queues create q', 'queues delete q', 'pages deploy dist', 'pages project delete p', 'login', 'init app', '--env prod deploy', 'something-new',
];
const WRANGLER_READS = [
  '', '--version', 'deploy --help', 'whoami', 'deployments list --name api', 'deployments status', 'versions list', 'versions view v1', 'tail api --format json',
  'd1 list', 'd1 info db', 'd1 migrations list db --remote', 'd1 time-travel info db', 'd1 execute db --command x', 'd1 migrations apply db --local',
  'r2 bucket list', 'r2 bucket info b', 'kv namespace list', 'queues list', 'pages project list', 'pages deployment list', 'secret list --name api', 'dev', 'types',
];

test('decideWrangler denies every write subcommand behind every runner prefix', () => {
  for (const prefix of WRANGLER_PREFIXES) {
    const runner = prefix === 'npm exec --' ? 'npm exec -- wrangler' : prefix;
    for (const sub of WRANGLER_WRITES) {
      assert.equal(decideWrangler(`${runner} ${sub}`), WRANGLER_REASON, `${runner} ${sub}`);
    }
  }
});

test('decideWrangler allows read and local subcommands and ignores non-wrangler commands', () => {
  for (const sub of WRANGLER_READS) assert.equal(decideWrangler(`npx wrangler ${sub}`.trim()), null, sub);
  for (const cmd of ['grep wrangler package.json', 'cat wrangler.toml', 'npm run build', 'ls node_modules/.bin/wrangler', 'echo use wrangler deploy later']) {
    assert.equal(decideWrangler(cmd), null, cmd);
  }
});

test('decideWrangler finds wrangler inside chains, subshells, quotes and env prefixes', () => {
  for (const cmd of [
    'ls && npx wrangler deploy',
    'cd app; wrangler deploy',
    'echo $SECRET | npx wrangler secret put KEY',
    'printf x | wrangler secret bulk',
    'sh -c "wrangler deploy"',
    'echo $(npx wrangler delete --name api)',
    'CI=1 NODE_ENV=production npx wrangler deploy',
    'env -i wrangler deploy',
  ]) {
    assert.equal(decideWrangler(cmd), WRANGLER_REASON, cmd);
  }
});

test('guard denies direct wrangler writes, stays silent on reads and keeps claudeflare apply asking', (t) => {
  const ctx = setup(t);
  assertDeny(guard(ctx, bash('ls && npx wrangler deploy')), WRANGLER_REASON);
  assert.equal(guard(ctx, bash('npx wrangler deployments list --name api')), null);
  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 'sess-1' });
  assert.equal(guard(ctx, bash(`claudeflare apply ${PLAN_ID}`)).permissionDecision, 'ask');
  assertDeny(guard(ctx, bash(`claudeflare apply ${PLAN_ID} && wrangler deploy`)), WRANGLER_REASON);
});
