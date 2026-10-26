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
import { isAllowedCall } from '../hooks/lib/allowed-call.mjs';
import { CLOUDFLARED_REASON, SECRET_REASON, TUNNEL_TOKEN_REASON } from '../hooks/lib/secret-rules.mjs';
import { recordSecretFile, writeSecretFile } from '../scripts/lib/secret-files.mjs';
import { runTunnelToken } from '../scripts/lib/tunnel-token.mjs';

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
    env: { PATH: ctx.path ?? process.env.PATH, HOME: process.env.HOME, CLAUDEFLARE_KEY_DIR: ctx.keyDir },
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
  'queues create q', 'queues delete q', 'pages deploy dist', 'pages project delete p', 'init app', '--env prod deploy', 'something-new',
];
const WRANGLER_READS = [
  '', '--version', 'deploy --help', 'whoami', 'deployments list --name api', 'deployments status', 'versions list', 'versions view v1', 'tail api --format json',
  'd1 list', 'd1 info db', 'd1 migrations list db --remote', 'd1 time-travel info db', 'd1 execute db --command x', 'd1 migrations apply db --local',
  'r2 bucket list', 'r2 bucket info b', 'kv namespace list', 'queues list', 'pages project list', 'pages deployment list', 'secret list --name api', 'dev', 'types',
  'pages deployment tail', 'versions secret list --name api', 'login', '--log-level debug whoami',
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
  for (const cmd of ['grep wrangler package.json', 'cat wrangler.toml', 'npm run build', 'ls node_modules/.bin/wrangler', 'echo use wrangler deploy later', 'grep -rn "wrangler deploy" docs', 'npx wrangler d1 execute db --command "SELECT 1"', 'git log --grep wrangler', 'git commit -m "docs: wrangler deploy goes through the plan"', 'rg "wrangler deploy" docs', 'gh pr create --body "run wrangler deploy"']) {
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
    'npx wrangler d1 execute db --command "SELECT 1" --remote',
    "wrangler 'deploy'",
    'wrangler "deploy" --name api',
    'timeout 30 npx wrangler deploy',
    'xargs -n1 wrangler deploy',
    'wrangler --config x',
    'bash -c \'echo hi && npx wrangler versions deploy v@100%\'',
    'echo "$(wrangler delete --name api)"',
    'w\\\nrangler deploy',
    'node_modules/wrangler/bin/wrangler.js deploy',
    [1, 2, 3, 4, 5].reduce((cmd) => `sh -c ${JSON.stringify(cmd)}`, 'npx wrangler deploy'),
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

test('decideWrangler checks package.json scripts that npm, pnpm, yarn and bun would run, following cd', (t) => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-pkg-')));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, 'app'));
  const pkg = { scripts: { deploy: 'wrangler deploy', 'deploy:prod': 'npm run deploy -- --env production', build: 'tsc', predev: 'echo hi', dev: 'wrangler dev', postbuild: 'wrangler versions upload', start: 'wrangler deploy' } };
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg));
  writeFileSync(join(dir, 'app', 'package.json'), JSON.stringify(pkg));
  for (const cmd of ['npm run deploy', 'pnpm run deploy', 'pnpm deploy', 'yarn deploy', 'bun run deploy', 'npm run deploy:prod', 'npm start', 'npm run build', 'npm --prefix app run deploy']) {
    assert.equal(decideWrangler(cmd, { cwd: dir }), WRANGLER_REASON, cmd);
  }
  assert.equal(decideWrangler('cd app && npm run deploy', { cwd: join(tmpdir()) }), null);
  assert.equal(decideWrangler(`cd ${join(dir, 'app')} && npm run deploy`, { cwd: tmpdir() }), WRANGLER_REASON);
  for (const cmd of ['npm run dev', 'npm install', 'npm run missing', 'yarn', 'pnpm test']) {
    assert.equal(decideWrangler(cmd, { cwd: dir }), null, cmd);
  }
});

test('guard asks for claudeflare apply called by path or quoted, not only bare', (t) => {
  const ctx = setup(t);
  writeApproval(ctx.cwd, { plan_id: PLAN_ID, session_id: 's' });
  for (const cmd of [
    `node /plugin/bin/claudeflare apply ${PLAN_ID}`,
    `./bin/claudeflare apply ${PLAN_ID}`,
    `"/plugin dir/bin/claudeflare" apply '${PLAN_ID}'`,
    `node scripts/cf.mjs apply ${PLAN_ID}`,
    `/opt/tools/claudeflare apply ${PLAN_ID}`,
    `cd /x && git -C /x status; claudeflare apply ${PLAN_ID}`,
    `make -C /tools/claudeflare apply ${PLAN_ID}`,
    `npx -C claudeflare apply ${PLAN_ID}`,
    `git -C\nclaudeflare apply ${PLAN_ID}`,
    `git\n-C claudeflare apply ${PLAN_ID}`,
  ]) {
    assert.equal(guard(ctx, bash(cmd)).permissionDecision, 'ask', cmd);
  }
  assert.equal(guard(ctx, bash('git -C /home/u/claudeflare apply fix.patch')), null);
});

// guard.mjs: secret files and tunnel tokens

const AID = 'abcdef0123456789abcdef0123456789';
const TID = 'c1744f8b-faa1-48a4-9e5c-02ac921467fa';
const read = (file_path) => ({ tool_name: 'Read', tool_input: { file_path } });
const grep = (input) => ({ tool_name: 'Grep', tool_input: { pattern: 'x', ...input } });
const glob = (input) => ({ tool_name: 'Glob', tool_input: input });

function secretSetup(t) {
  const ctx = setup(t, { plan: false });
  const envFile = join(ctx.cwd, 'deploy', '.env');
  mkdirSync(join(ctx.cwd, 'deploy'));
  writeFileSync(envFile, 'TUNNEL_TOKEN=x\n');
  writeFileSync(join(ctx.cwd, '.env'), 'OTHER=1\n');
  recordSecretFile(ctx.cwd, envFile);
  const secret = writeSecretFile(ctx.cwd, 'x.json', { client_secret: 's' });
  return { ...ctx, envFile, secret };
}

test('Read of .claudeflare/secrets/x.json is denied', (t) => {
  const ctx = secretSetup(t);
  assertDeny(guard(ctx, read(ctx.secret)), SECRET_REASON);
  assertDeny(guard(ctx, read('.claudeflare/secrets/x.json')), SECRET_REASON);
  assertDeny(guard(ctx, read('/elsewhere/project/.claudeflare/secrets/other.json')), SECRET_REASON);
  assert.equal(guard(ctx, read(join(ctx.cwd, '.claudeflare', 'secret-files.json'))), null);
});

test('Read of an env file listed in secret-files.json is denied, other .env files allowed', (t) => {
  const ctx = secretSetup(t);
  assertDeny(guard(ctx, read(ctx.envFile)), SECRET_REASON);
  assertDeny(guard(ctx, read('deploy/./.env')), SECRET_REASON);
  assert.equal(guard(ctx, read(join(ctx.cwd, '.env'))), null);
  assert.equal(guard(ctx, read(join(ctx.cwd, 'deploy', '.env.example'))), null);
  // From a subdirectory of the project the index is still found.
  assertDeny(guard({ ...ctx, cwd: join(ctx.cwd, 'deploy') }, read('.env')), SECRET_REASON);
});

test('guard tolerates a missing or invalid secret-files.json', (t) => {
  const ctx = setup(t, { plan: false });
  assert.equal(guard(ctx, read(join(ctx.cwd, '.env'))), null);
  mkdirSync(join(ctx.cwd, '.claudeflare'), { recursive: true });
  writeFileSync(join(ctx.cwd, '.claudeflare', 'secret-files.json'), '{nope');
  assert.equal(guard(ctx, read(join(ctx.cwd, '.env'))), null);
  assert.equal(guard(ctx, bash('cat .env')), null);
});

test('Bash cat of a listed env file is denied', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    `cat ${ctx.envFile}`,
    'cat deploy/.env',
    'head -n1 ./deploy/.env',
    'cd deploy && cat .env',
    'source deploy/.env && env',
    '. deploy/.env',
    'base64 < deploy/.env',
    'cp deploy/.env /tmp/x',
    "sh -c 'tail deploy/.env'",
    'cat .claudeflare/secrets/x.json',
    'echo .claudeflare/secrets',
    // Case-insensitive filesystems: case variants name the same folder.
    ...(process.platform === 'darwin' ? ['cat .ClaudeFlare/Secrets/x.json'] : []),
    'while read -r line; do echo "$line"; done < deploy/.env',
    'x=$(<deploy/.env)',
    'python3 app.py 0<deploy/.env',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  // The basename with a read verb is enough: the guard cannot follow every cd.
  assertDeny(guard(ctx, bash('cat .env')), SECRET_REASON);
  // Only the exact consumer shapes of ruling 14 are allowed (see the round 3 tests).
  for (const cmd of [
    'cat other.env', 'cat deploy/.env.example', 'ls deploy', 'npm test', 'echo .env', 'git add .env.example',
    'git add deploy/.env', 'git rm --cached -- deploy/.env', 'systemctl restart cloudflared',
    'docker compose --env-file deploy/.env up -d', `docker run -d --env-file=${ctx.envFile} img`,
    'chmod 600 deploy/.env', 'chown me deploy/.env', 'ls -l deploy/.env', 'stat deploy/.env', 'test -f deploy/.env', '[ -f deploy/.env ]',
    'rm deploy/.env', 'ls .claudeflare/secrets', 'rm -rf .claudeflare/secrets',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('Grep with path .claudeflare/secrets is denied', (t) => {
  const ctx = secretSetup(t);
  assertDeny(guard(ctx, grep({ path: '.claudeflare/secrets' })), SECRET_REASON);
  assertDeny(guard(ctx, grep({ path: join(ctx.cwd, '.claudeflare', 'secrets', 'x.json') })), SECRET_REASON);
  assertDeny(guard(ctx, grep({ path: ctx.envFile })), SECRET_REASON);
  assertDeny(guard(ctx, glob({ pattern: '*', path: '.claudeflare/secrets' })), SECRET_REASON);
  assertDeny(guard(ctx, glob({ pattern: `${ctx.cwd}/.claudeflare/secrets/*` })), SECRET_REASON);
});

test('Grep over a root holding a listed env file is denied unless its glob excludes the file', (t) => {
  const ctx = secretSetup(t);
  assertDeny(guard(ctx, grep({})), SECRET_REASON);
  assertDeny(guard(ctx, grep({ path: 'deploy' })), SECRET_REASON);
  assertDeny(guard(ctx, grep({ glob: '.env*' })), SECRET_REASON);
  assertDeny(guard(ctx, grep({ glob: '**/.env' })), SECRET_REASON);
  assertDeny(guard(ctx, grep({ glob: '*' })), SECRET_REASON);
  assert.equal(guard(ctx, grep({ glob: '*.js' })), null);
  assert.equal(guard(ctx, grep({ glob: 'src/**/*.ts' })), null);
  // Globs the guard does not fully model count as able to match.
  for (const g of ['**/*.{ts,tsx}', '!*.md', '[.]env', '*.js}', 'src/**', '\\.env']) {
    assertDeny(guard(ctx, grep({ glob: g })), SECRET_REASON);
  }
  assert.equal(guard(ctx, grep({ path: 'src' })), null);
  // Glob lists names only: a project-wide Glob stays allowed.
  assert.equal(guard(ctx, glob({ pattern: '**/*.env' })), null);
});

test('isAllowedCall denies the tunnel token read and keeps write-only token endpoints off the allowlist', () => {
  assert.equal(isAllowedCall({ method: 'GET', path: `/accounts/${AID}/cfd_tunnel/${TID}/token` }), false);
  assert.equal(isAllowedCall({ method: 'GET', path: `/client/v4/accounts/${AID}/cfd_tunnel/${TID}/token/` }), false);
  assert.equal(isAllowedCall({ method: 'GET', path: `/accounts/${AID}/cfd_tunnel/${TID}/token?x=1` }), false);
  assert.equal(isAllowedCall({ method: 'GET', path: `/accounts/${AID}/cfd_tunnel/${TID}` }), true);
  assert.equal(isAllowedCall({ method: 'GET', path: `/accounts/${AID}/cfd_tunnel/${TID}/connections` }), true);
  for (const path of [
    `/accounts/${AID}/access/service_tokens/${TID}/rotate`,
    `/accounts/${AID}/access/service_tokens/${TID}/refresh`,
    `/accounts/${AID}/access/apps/${TID}/revoke_tokens`,
  ]) {
    assert.equal(isAllowedCall({ method: 'POST', path }), false, path);
  }
});

test('MCP execute reading cfd_tunnel/<id>/token is denied with tunnel-token in the reason', (t) => {
  const ctx = setup(t, { plan: false });
  const code = `async () => { const r = await cloudflare.request({ method: 'GET', path: '/accounts/${AID}/cfd_tunnel/${TID}/token' }); return r.result; }`;
  const decision = guard(ctx, execute(code));
  assertDeny(decision, TUNNEL_TOKEN_REASON);
  assert.ok(decision.permissionDecisionReason.includes('claudeflare tunnel-token'));
  for (const path of [
    `/accounts/${AID}/access/service_tokens/${TID}/rotate`,
    `/accounts/${AID}/access/service_tokens/${TID}/refresh`,
    `/accounts/${AID}/access/apps/${TID}/revoke_tokens`,
  ]) {
    assertDeny(guard(ctx, execute(`async () => { const r = await cloudflare.request({ method: 'POST', path: '${path}' }); return r.result; }`)), PROTOCOL);
  }
});

test('Bash reads of the tunnel token endpoint are denied', (t) => {
  const ctx = setup(t, { plan: false });
  for (const cmd of [
    `curl -s -H "Authorization: Bearer $T" https://api.cloudflare.com/client/v4/accounts/${AID}/cfd_tunnel/${TID}/token`,
    `claudeflare get /accounts/${AID}/cfd_tunnel/${TID}/token`,
  ]) {
    assertDeny(guard(ctx, bash(cmd)), TUNNEL_TOKEN_REASON);
  }
  assert.equal(guard(ctx, bash(`claudeflare get /accounts/${AID}/cfd_tunnel/${TID}`)), null);
  assert.equal(guard(ctx, bash(`claudeflare tunnel-token --account ${AID} --tunnel ${TID} --env-path .env`)), null);
});

// Final review H1: every token endpoint shape the security review found.

const TOKEN_ENDPOINT_PATHS = [
  `/accounts/${AID}/cfd_tunnel/${TID}/token`,
  `/accounts/${AID}/warp_connector/${TID}/token`,
  `/client/v4/accounts/${AID}/warp_connector/${TID}/token/`,
  `/accounts/${AID}/tunnels/${TID}/token`,
  `//accounts/${AID}/cfd_tunnel/${TID}/token`,
  `/accounts/${AID}/cfd_tunnel//${TID}/token`,
  `/accounts/${AID}/cfd_tunnel/${TID}/x/../token`,
  `/accounts/${AID}/cfd_tunnel/${TID}/./token`,
  `/accounts/${AID}/cfd_tunnel/${TID}/%74oken`,
  `/accounts/${AID}/cfd_tunnel/${TID}/%2574oken`,
  `/accounts/${AID}/cfd%5ftunnel/${TID}/token`,
  `/accounts/${AID}/CFD_TUNNEL/${TID}/TOKEN`,
  `/accounts/${AID}/cfd_tunnel/${TID}%2ftoken`,
  `/accounts/${AID}\\cfd_tunnel\\${TID}\\token`,
  `/accounts/${AID}/cfd_tunnel/${TID}/token?x=1`,
  `/accounts/${AID}/cfd_tunnel/${TID}/token#x`,
];

test('isAllowedCall normalizes the path before refusing token endpoints', () => {
  for (const path of TOKEN_ENDPOINT_PATHS) {
    assert.equal(isAllowedCall({ method: 'GET', path }), false, path);
  }
  for (const path of [
    `/accounts/${AID}/cfd_tunnel/${TID}`,
    `/accounts/${AID}/cfd_tunnel/${TID}/connections`,
    `/accounts/${AID}/warp_connector/${TID}`,
    `/accounts/${AID}/cfd_tunnel/${TID}/configurations`,
    `/accounts/${AID}/cfd_tunnel/${TID}/tokens`,
    '/user/tokens/verify',
  ]) {
    assert.equal(isAllowedCall({ method: 'GET', path }), true, path);
  }
});

test('MCP execute reading any token endpoint shape is denied with the tunnel-token reason', (t) => {
  const ctx = setup(t, { plan: false });
  for (const path of TOKEN_ENDPOINT_PATHS) {
    const code = `async () => { const r = await cloudflare.request({ method: 'GET', path: ${JSON.stringify(path)} }); return r.result; }`;
    // A string with escapes is not a literal the inspector reads: denied as non-canonical.
    if (path.includes('\\')) assert.equal(guard(ctx, execute(code)).permissionDecision, 'deny', path);
    else assertDeny(guard(ctx, execute(code)), TUNNEL_TOKEN_REASON);
  }
});

test('Bash token endpoint reads are denied whatever the quoting or variable use', (t) => {
  const ctx = setup(t, { plan: false });
  const api = 'https://api.cloudflare.com/client/v4';
  for (const cmd of [
    `claudeflare get /accounts/$A/cfd_tunnel/"$T"/token`,
    `claudeflare get "/accounts/$A/cfd_tunnel/$T"/token`,
    `claudeflare get '/accounts/${AID}/cfd_tunnel/${TID}/token'`,
    `claudeflare get /accounts/${AID}/cfd_tunnel/${TID}/\\token`,
    'P=/accounts/$A/cfd_tunnel/$T; claudeflare get $P/token',
    'P=/accounts/$A/cfd_tunnel/$T\nclaudeflare get "$P/token"',
    'claudeflare get $P/token',
    'claudeflare get "${TUNNEL_PATH}"/token',
    `claudeflare get /accounts/${AID}/warp_connector/${TID}/token`,
    `claudeflare get /accounts/$A/warp_connector/"$T"/token`,
    `claudeflare get /accounts/${AID}/tunnels/${TID}/token`,
    `claudeflare get /accounts/${AID}/cfd_tunnel/${TID}/%74oken`,
    `claudeflare get /accounts/${AID}/cfd_tunnel/${TID}/x/../token`,
    `curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" ${api}/accounts/$A/cfd_tunnel/"$T"/token`,
    `curl -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" "${api}/accounts/$A/cfd_tunnel/$T"/token`,
    `curl -s "${api}$P/token" -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN"`,
    `curl -s ${api}/accounts/${AID}/warp_connector/${TID}/token`,
    `node scripts/cf.mjs get /accounts/$A/cfd_tunnel/"$T"/token`,
  ]) {
    assertDeny(guard(ctx, bash(cmd)), TUNNEL_TOKEN_REASON);
  }
  for (const cmd of [
    `claudeflare get /accounts/${AID}/cfd_tunnel/${TID}`,
    `claudeflare get "/accounts/$A/cfd_tunnel/$T"`,
    `claudeflare get /accounts/$A/warp_connector`,
    `claudeflare tunnel-token --account ${AID} --tunnel ${TID} --env-path .env`,
    'cloudflared tunnel run --token-file /etc/cloudflared/token',
    'cat $HOME/.npm/_cacache/token',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('Bash "cloudflared tunnel token <name>" is denied unless it writes to --cred-file', (t) => {
  const ctx = setup(t, { plan: false });
  for (const cmd of [
    'cloudflared tunnel token my-tunnel',
    `cloudflared tunnel token ${TID}`,
    'sudo cloudflared tunnel --loglevel debug token my-tunnel',
    "sh -c 'cloudflared tunnel token my-tunnel'",
    'docker run --rm cloudflare/cloudflared:latest tunnel token my-tunnel',
    'echo $(cloudflared tunnel token my-tunnel)',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), TUNNEL_TOKEN_REASON);
  }
  for (const cmd of [
    'cloudflared tunnel token --cred-file /etc/cloudflared/creds.json my-tunnel',
    'cloudflared tunnel token --cred-file=/etc/cloudflared/creds.json my-tunnel',
    'cloudflared tunnel list',
    'cloudflared tunnel run --token-file /etc/cloudflared/token my-tunnel',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('Bash "cloudflared tunnel run --token eyJ..." is denied', (t) => {
  const ctx = setup(t, { plan: false });
  for (const cmd of [
    'cloudflared tunnel run --token eyJhIjoiYWJjIn0',
    'cloudflared tunnel --no-autoupdate run --token=eyJhIjoiYWJjIn0',
    'sudo cloudflared tunnel run -token "eyJhIjoiYWJjIn0"',
    "docker run cloudflare/cloudflared:latest tunnel run --token 'eyJhIjoiYWJjIn0'",
    'echo ok && /usr/local/bin/cloudflared tunnel run --token eyJx',
    'TUNNEL_TOKEN=eyJhIjoiYWJjIn0 cloudflared tunnel run',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), CLOUDFLARED_REASON);
  }
});

test('Bash "cloudflared service install eyJ..." is denied', (t) => {
  const ctx = setup(t, { plan: false });
  assertDeny(guard(ctx, bash('cloudflared service install eyJhIjoiYWJjIn0')), CLOUDFLARED_REASON);
  assertDeny(guard(ctx, bash('sudo cloudflared service install "eyJhIjoiYWJjIn0"')), CLOUDFLARED_REASON);
  assert.equal(guard(ctx, bash('sudo cloudflared service install "$TUNNEL_TOKEN"')), null);
  assert.equal(guard(ctx, bash('cloudflared service install')), null);
});

test('Bash "cloudflared tunnel --no-autoupdate run" (token from env) is allowed', (t) => {
  const ctx = setup(t, { plan: false });
  for (const cmd of [
    'cloudflared tunnel --no-autoupdate run',
    'cloudflared tunnel run --token "$TUNNEL_TOKEN"',
    'cloudflared tunnel run --token=${TUNNEL_TOKEN}',
    'cloudflared tunnel run --token-file /etc/cloudflared/token',
    'cloudflared --version',
    'cloudflared tunnel list',
    'cloudflared tunnel info my-tunnel',
    'cloudflared access curl https://app.example.com',
    'set -a; . ./tunnel.env; set +a; cloudflared tunnel run',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('Bash recursive searches whose root holds a secret file are denied unless an include excludes it', (t) => {
  const ctx = secretSetup(t);
  mkdirSync(join(ctx.cwd, 'src'));
  for (const cmd of [
    'grep -r TUNNEL .',
    'grep -rn TUNNEL',
    'grep -R --include=* TUNNEL deploy',
    'grep -d recurse x .',
    'cd deploy && grep -r x',
    'rg TUNNEL',
    'rg -n TUNNEL deploy',
    "rg -g '!*.md' TUNNEL",
    "rg -g '*.{js,env}' TUNNEL",
    'ag TUNNEL',
    'ack TUNNEL',
    'git grep TUNNEL',
    "find . -name '*' -exec cat {} \\;",
    "find deploy -type f -exec sh -c 'head {}' \\;",
    "find . ! -name '*.js' -exec grep x {} +",
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  for (const cmd of [
    'grep -r TUNNEL src',
    "grep -r --include='*.js' TUNNEL .",
    'grep TUNNEL README.md',
    "rg -g '*.js' TUNNEL",
    'rg TUNNEL src',
    "git grep TUNNEL -- '*.js'",
    "find . -name '*.js' -exec cat {} \\;",
    'find . -name .env',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('guard finds the index of the project owning a target, from any cwd in or outside the project', async (t) => {
  const ctx = setup(t, { plan: false });
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-proj-')));
  t.after(() => rmSync(project, { recursive: true, force: true }));
  for (const d of ['.git', 'a', 'b']) mkdirSync(join(project, d));
  const fake = () => ({ request: async () => 'eyJwcm9qZWN0LXJvb3QifQ' });
  await runTunnelToken(join(project, 'b'), { account: AID, tunnel: TID, envFile: '../a/.env' }, fake);
  const envFile = join(project, 'a', '.env');
  assertDeny(guard({ ...ctx, cwd: project }, read(envFile)), SECRET_REASON);
  assertDeny(guard({ ...ctx, cwd: project }, read('a/.env')), SECRET_REASON);
  assertDeny(guard({ ...ctx, cwd: join(project, 'b') }, read('../a/.env')), SECRET_REASON);
  assertDeny(guard({ ...ctx, cwd: join(project, 'b') }, bash('cat ../a/.env')), SECRET_REASON);
  // From an unrelated cwd the target's own project index is still read.
  assertDeny(guard(ctx, read(envFile)), SECRET_REASON);
  assertDeny(guard(ctx, grep({ path: join(project, 'a') })), SECRET_REASON);
});

test('Bash naming a secret path is denied by default outside the consumer allowlist', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'vim deploy/.env',
    'diff deploy/.env deploy/.env.example',
    'git diff deploy/.env',
    'git show HEAD:deploy/.env deploy/.env',
    'docker cp deploy/.env box:/tmp/x',
    'docker run -e X=1 img cat deploy/.env',
    `node -e "require('fs').readFileSync('${ctx.envFile}')"`,
    `python3 -c "print(open('${ctx.envFile}').read())"`,
    'echo $(nl deploy/.env)',
    'echo `nl deploy/.env`',
    'nl < deploy/.env',
    "sh -c 'nl deploy/.env'",
    'claudeflare plan new --file deploy/.env',
    'npx dotenv -e deploy/.env -- node -p process.env',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
});

// Final review M3: globs, git object reads and container dumps.

test('Bash glob words that can match an indexed secret file are denied', (t) => {
  const ctx = secretSetup(t);
  const tunnelEnv = join(ctx.cwd, 'deploy', 'tunnel.env');
  writeFileSync(tunnelEnv, 'TUNNEL_TOKEN=x\n');
  recordSecretFile(ctx.cwd, tunnelEnv);
  mkdirSync(join(ctx.cwd, 'src'));
  for (const cmd of [
    'cat deploy/.*',
    'cat deploy/.e*',
    'cat deploy/.en?',
    'cat deploy/.[e]nv',
    'cat deploy/.{env,x}',
    'head -n 50 deploy/*',
    'grep TUNNEL deploy/*',
    'cat deploy/*.env',
    'cat */*.env',
    'cat ./deploy/../deploy/*',
    'cd deploy && cat *',
    'cat .claudeflare/secrets/*',
    `cat ${join(ctx.cwd, 'deploy')}/*`,
    'cp deploy/* /tmp/out',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  for (const cmd of [
    'cat src/*.js',
    'ls deploy/*',
    'rm deploy/*.bak',
    'cat deploy/*.example',
    "grep -n 'a.*b' README.md",
    'echo *.md',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('Bash git show <rev>:<path> and git cat-file of an indexed file are denied', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'git show HEAD:deploy/.env',
    'git show :deploy/.env',
    'git show HEAD~1:./deploy/.env',
    'git cat-file -p HEAD:deploy/.env',
    'git cat-file blob main:deploy/.env',
    'git --no-pager show HEAD:deploy/.env',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  for (const cmd of ['git show HEAD:src/app.js', 'git show HEAD --stat', 'git cat-file -t HEAD']) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('Bash docker or podman compose config and inspect are denied while the project indexes secret files', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'docker compose config',
    'docker compose -f deploy/compose.yml config',
    'docker compose config --environment',
    'podman compose config',
    'docker-compose config',
    'docker inspect cloudflared',
    'docker container inspect cloudflared',
    'podman inspect cloudflared',
    'cd deploy && docker compose config',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  assert.equal(guard(ctx, bash('docker compose ps')), null);
  // A project without indexed secret files keeps these commands.
  const plain = setup(t, { plan: false });
  for (const cmd of ['docker compose config', 'docker inspect cloudflared']) {
    assert.equal(guard(plain, bash(cmd)), null, cmd);
  }
});

test('Bash cd is followed only when unconditional and top level', (t) => {
  const ctx = secretSetup(t);
  mkdirSync(join(ctx.cwd, 'src'));
  for (const cmd of ['cd src && grep -r x .', 'cd src; rg x', 'cd src\nrg x', 'cd src || exit 1; rg x']) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
  for (const cmd of [
    '(cd src); grep -r x .',
    'test -d src || cd src && grep -r x .',
    'cd src & grep -r x .',
    'cd src | grep -r x .',
    'cd "$D" && rg x',
    '{ cd src; } ; rg x',
    'cd deploy && nl .env',
    '(cd deploy && nl .env)',
    'cd src && (cd ../deploy && nl .env)',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
});

test('find expressions with operators the guard does not model can match every file', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    "find . -name '*.js' -o -name x -exec cat {} \\;",
    "find . -name '*.js' -or -type f -exec cat {} +",
    "find . -path './src/*' -exec cat {} \\;",
    "find . -regex '.*js' -exec cat {} \\;",
    "find . -not -name '*.js' -exec cat {} \\;",
    "find . \\( -name '*.js' \\) -exec cat {} \\;",
    "find . -name '*.js' , -name x -exec cat {} \\;",
    "find . -wholename '*.js' -exec cat {} \\;",
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  assert.equal(guard(ctx, bash("find . -type f -name '*.js' -exec cat {} \\;")), null);
});

test('Grep globs with whitespace or commas count as unmodeled', (t) => {
  const ctx = secretSetup(t);
  for (const g of ['*.md .env', '*.md,.env', '*.md\t.env']) {
    assertDeny(guard(ctx, grep({ glob: g })), SECRET_REASON);
  }
});

test('the per-user index covers an env file outside any project index', async (t) => {
  const ctx = setup(t, { plan: false });
  const runner = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-runner-')));
  const loose = realpathSync(mkdtempSync(join(tmpdir(), 'claudeflare-loose-')));
  t.after(() => {
    rmSync(runner, { recursive: true, force: true });
    rmSync(loose, { recursive: true, force: true });
  });
  const fake = () => ({ request: async () => 'eyJwZXItdXNlciJ9' });
  await runTunnelToken(runner, { account: AID, tunnel: TID, envFile: join(loose, '.env') }, fake);
  assert.equal(existsSync(join(loose, '.claudeflare')), false);
  assert.ok(existsSync(join(ctx.keyDir, 'secret-files.json')));
  assertDeny(guard(ctx, read(join(loose, '.env'))), SECRET_REASON);
  assertDeny(guard(ctx, bash(`nl ${join(loose, '.env')}`)), SECRET_REASON);
});

// Fix round 3 (ruling 14): exact consumer shapes, exemption per argument.

const REPO = fileURLToPath(new URL('..', import.meta.url));
const OWN_BIN = join(REPO, 'bin', 'claudeflare');
const OWN_CF = join(REPO, 'scripts', 'cf.mjs');

test('round 3: container commands that can print the env file are denied', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'docker compose --env-file deploy/.env config',
    'docker run --env-file deploy/.env alpine env',
    'cd deploy && docker compose --env-file .env run app printenv',
    'docker compose --env-file deploy/.env exec app env',
    'docker compose --env-file deploy/.env up',
    'docker compose --env-file deploy/.env up -d --build x',
    'docker compose -f deploy/.env --env-file deploy/.env up -d',
    'docker run --env-file deploy/.env alpine',
    'docker run -d --env-file deploy/.env alpine printenv',
    'docker run -d --privileged --env-file deploy/.env alpine',
    'podman compose --env-file deploy/.env logs',
    'docker-compose --env-file deploy/.env up -d',
    'docker inspect --env-file deploy/.env x',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
});

test('round 3: a prefix head never makes a reader a consumer (B1)', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'env -u ls cat deploy/.env',
    'env -C ls cat deploy/.env',
    "env -S 'cat deploy/.env'",
    'sudo -u ls cat deploy/.env',
    'sudo -g rm cat deploy/.env',
    'xargs -I rm cat deploy/.env',
    'xargs -n 1 cat deploy/.env',
    'xargs -L stat cat deploy/.env',
    'time -o ls cat deploy/.env',
    'nice -n 5 ls deploy/.env',
    'timeout 5 ls deploy/.env',
    'command ls deploy/.env',
    'X=1 ls deploy/.env',
    'sudo rm deploy/.env',
    'cd deploy && env -u X cat .env',
    'cd deploy && timeout -s KILL 5 cat .env',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
});

test('round 3: cd options, pushd and builtin cd are followed; unresolved targets fail closed (B2)', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'cd -P deploy && wc .env',
    'cd -L deploy && wc .env',
    'cd -- deploy && wc .env',
    'cd -e -@ deploy && wc .env',
    'pushd deploy && wc .env',
    'builtin cd deploy && wc .env',
    'cd "$D" && wc .env',
    'cd - && wc .env',
    'popd && wc .env',
    'cd ~other && wc .env',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  assert.equal(guard(ctx, bash('cd "$D" && wc README.md')), null);
});

test('round 3: git exempts only add/rm pathspecs without global options or pagers (B4)', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    'git -c alias.x=!cat add deploy/.env',
    'git -p add deploy/.env',
    'git --paginate rm deploy/.env',
    'git --exec-path=/tmp add deploy/.env',
    'git --config-env=core.pager=P add deploy/.env',
    'GIT_PAGER=cat git add deploy/.env',
    'PAGER=cat git add deploy/.env',
    'git -C . add deploy/.env',
    'git add -p deploy/.env',
    'git add --interactive deploy/.env',
    'git status deploy/.env',
    'git ls-files deploy/.env',
    'git check-ignore -v deploy/.env',
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
});

test('round 3: claudeflare is recognised by realpath, and only --env-path is exempt (B5)', (t) => {
  const ctx = secretSetup(t);
  const fake = join(ctx.cwd, 'evil');
  mkdirSync(fake);
  writeFileSync(join(fake, 'claudeflare'), '#!/bin/sh\ncat "$@"\n', { mode: 0o755 });
  writeFileSync(join(fake, 'cf.mjs'), '');
  for (const cmd of [
    `${join(fake, 'claudeflare')} tunnel-token --env-path deploy/.env`,
    `node ${join(fake, 'cf.mjs')} tunnel-token --env-path deploy/.env`,
    'node evil/cf.mjs tunnel-token --env-path deploy/.env',
    'claudeflare tunnel-token --env-path deploy/.env',
    `${OWN_BIN} tunnel-token --env-path other.env --tunnel deploy/.env`,
    `${OWN_BIN} get --env-path deploy/.env`,
  ]) {
    assertDeny(guard(ctx, bash(cmd)), SECRET_REASON);
  }
  // A bare claudeflare that resolves on PATH to another program.
  assertDeny(guard({ ...ctx, path: `${fake}:${process.env.PATH}` }, bash('claudeflare tunnel-token --env-path deploy/.env')), SECRET_REASON);
  assert.equal(guard({ ...ctx, path: `${join(REPO, 'bin')}:${process.env.PATH}` }, bash(`claudeflare tunnel-token --account ${AID} --tunnel ${TID} --env-path deploy/.env`)), null);
});

test('round 3: each ruling 14 shape is allowed', (t) => {
  const ctx = secretSetup(t);
  for (const cmd of [
    `${OWN_BIN} tunnel-token --account ${AID} --tunnel ${TID} --env-path deploy/.env`,
    `node ${OWN_CF} tunnel-token --account ${AID} --tunnel ${TID} --env-path ${ctx.envFile}`,
    'docker compose --env-file deploy/.env up -d',
    'docker compose -f a.yml -f b.yml -p app --env-file deploy/.env up --detach web worker',
    'podman compose --env-file=deploy/.env down',
    'docker compose --env-file deploy/.env restart web',
    'docker compose --env-file deploy/.env stop',
    'docker compose --env-file deploy/.env pull',
    'docker run -d --env-file deploy/.env --name tunnel --restart unless-stopped cloudflare/cloudflared:latest',
    'podman run --detach --rm --env-file=deploy/.env img',
    'git add deploy/.env',
    'git rm --cached -q -- deploy/.env',
    'chmod 600 deploy/.env', 'chown me:staff deploy/.env', 'ls -la deploy/.env', 'stat deploy/.env', 'test -f deploy/.env', '[ -f deploy/.env ]', 'rm -f deploy/.env',
  ]) {
    assert.equal(guard(ctx, bash(cmd)), null, cmd);
  }
});

test('round 3: nl is a read verb, also under find -exec', (t) => {
  const ctx = secretSetup(t);
  assertDeny(guard(ctx, bash('cd x; nl .env')), SECRET_REASON);
  assertDeny(guard(ctx, bash("find . -name '.env' -exec nl {} \\;")), SECRET_REASON);
  assert.equal(guard(ctx, bash("find . -name '*.js' -exec nl {} \\;")), null);
});
