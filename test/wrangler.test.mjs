import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertWranglerVersion,
  failureMessage,
  runWrangler,
  wranglerCommand,
} from '../scripts/lib/wrangler.mjs';

const FAKE = fileURLToPath(new URL('./fixtures/wrangler/fake-wrangler.mjs', import.meta.url));
const TOKEN = 'tok_wrangler_secret_123';
const SECRET = 'super-secret-value-xyz';
const ENV_KEYS = [
  'CLAUDEFLARE_WRANGLER',
  'FAKE_WRANGLER_SCRIPT',
  'FAKE_WRANGLER_LOG',
  'FAKE_WRANGLER_DELAY_MS',
  'CLOUDFLARE_API_TOKEN',
  'CLOUDFLARE_ACCOUNT_ID',
];

let dir;
let saved;

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = mkdtempSync(join(tmpdir(), 'claudeflare-wrangler-test-'));
  process.env.CLAUDEFLARE_WRANGLER = FAKE;
  process.env.FAKE_WRANGLER_LOG = join(dir, 'log.ndjson');
  delete process.env.FAKE_WRANGLER_DELAY_MS;
  delete process.env.CLOUDFLARE_API_TOKEN;
  delete process.env.CLOUDFLARE_ACCOUNT_ID;
});

afterEach(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  rmSync(dir, { recursive: true, force: true });
});

function script(entries) {
  const path = join(dir, 'script.json');
  writeFileSync(path, JSON.stringify(entries));
  process.env.FAKE_WRANGLER_SCRIPT = path;
}

function logRecords() {
  return readFileSync(process.env.FAKE_WRANGLER_LOG, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function helperScript(name, body) {
  const path = join(dir, name);
  writeFileSync(path, body);
  process.env.CLAUDEFLARE_WRANGLER = path;
}

const opts = () => ({ cwd: dir, token: TOKEN, accountId: 'acc123' });

function fakeProject({ withWrangler }) {
  const project = join(dir, 'project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"name":"p","private":true}');
  if (withWrangler) {
    const pkg = join(project, 'node_modules', 'wrangler');
    mkdirSync(join(pkg, 'bin'), { recursive: true });
    // Mirrors wrangler 4: "exports" does not expose bin/wrangler.js.
    writeFileSync(
      join(pkg, 'package.json'),
      JSON.stringify({
        name: 'wrangler',
        version: '4.152.0',
        exports: { '.': './index.js', './package.json': './package.json' },
        bin: { wrangler: 'bin/wrangler.js', wrangler2: 'bin/wrangler.js' },
      }),
    );
    writeFileSync(join(pkg, 'bin', 'wrangler.js'), "process.stdout.write('4.152.0\\n');\n");
  }
  return project;
}

test('wranglerCommand: .mjs/.js runs with node, other value runs directly', () => {
  process.env.CLAUDEFLARE_WRANGLER = '/x/fake.mjs';
  assert.deepEqual(wranglerCommand(dir), { file: process.execPath, prefixArgs: ['/x/fake.mjs'] });
  process.env.CLAUDEFLARE_WRANGLER = '/x/fake.js';
  assert.deepEqual(wranglerCommand(dir), { file: process.execPath, prefixArgs: ['/x/fake.js'] });
  process.env.CLAUDEFLARE_WRANGLER = '/usr/local/bin/wrangler';
  assert.deepEqual(wranglerCommand(dir), { file: '/usr/local/bin/wrangler', prefixArgs: [] });
});

test('wranglerCommand default resolves the project-local wrangler bin', async () => {
  delete process.env.CLAUDEFLARE_WRANGLER;
  const project = fakeProject({ withWrangler: true });
  const cmd = wranglerCommand(project);
  assert.equal(cmd.file, process.execPath);
  assert.equal(realpathSync(cmd.prefixArgs[0]), realpathSync(join(project, 'node_modules', 'wrangler', 'bin', 'wrangler.js')));
  assert.equal(await assertWranglerVersion(project, { token: TOKEN }), '4.152.0');
});

test('wranglerCommand default without a project install -> wrangler_missing', async () => {
  delete process.env.CLAUDEFLARE_WRANGLER;
  const project = fakeProject({ withWrangler: false });
  assert.throws(() => wranglerCommand(project), (err) => {
    assert.equal(err.code, 'wrangler_missing');
    assert.match(err.hint, /npm i -D wrangler@4/);
    return true;
  });
  await assert.rejects(runWrangler(['--version'], { cwd: project }), { code: 'wrangler_missing' });
});

test('args are passed exactly, without a shell', async () => {
  const args = ['deploy', '--name', 'a; rm -rf x', '$(whoami)', 'two words'];
  script({ [args.join(' ')]: { stdout: 'ok\n', code: 0 } });
  const result = await runWrangler(args, opts());
  assert.equal(result.code, 0);
  assert.equal(result.stdout, 'ok\n');
  assert.deepEqual(logRecords()[0].argv, args);
});

test('env has CI=1, metrics off, NO_COLOR and the token, never a global key; stdin length is passed', async () => {
  script({ 'secret put KEY': { code: 0 } });
  process.env.CLOUDFLARE_API_KEY = 'global-key-value';
  process.env.CLOUDFLARE_EMAIL = 'someone@example.com';
  try {
    await runWrangler(['secret', 'put', 'KEY'], { ...opts(), stdin: SECRET });
  } finally {
    delete process.env.CLOUDFLARE_API_KEY;
    delete process.env.CLOUDFLARE_EMAIL;
  }
  const [record] = logRecords();
  assert.deepEqual(record.env, { CI: '1', WRANGLER_SEND_METRICS: 'false', NO_COLOR: '1', hasToken: true, hasGlobalKey: false });
  assert.equal(record.stdinLength, SECRET.length);
  assert.equal(readFileSync(process.env.FAKE_WRANGLER_LOG, 'utf8').includes(SECRET), false);
});

test('stdin is closed immediately when not given', async () => {
  script({ whoami: { code: 0 } });
  await runWrangler(['whoami'], opts());
  assert.equal(logRecords()[0].stdinLength, 0);
});

test('parent CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID are replaced', async () => {
  process.env.CLOUDFLARE_API_TOKEN = 'parent_token_abc';
  process.env.CLOUDFLARE_ACCOUNT_ID = 'parent_account';
  helperScript(
    'echo-env.mjs',
    "process.stdout.write(`T=${process.env.CLOUDFLARE_API_TOKEN} A=${process.env.CLOUDFLARE_ACCOUNT_ID ?? 'unset'}`);\n",
  );
  const withAccount = await runWrangler([], opts());
  assert.equal(withAccount.stdout, 'T=[REDACTED] A=acc123');
  const withoutAccount = await runWrangler([], { cwd: dir, token: TOKEN });
  assert.equal(withoutAccount.stdout, 'T=[REDACTED] A=unset');
});

test('extraEnv is added to the child env but cannot override fixed flags', async () => {
  helperScript('echo-extra.mjs', 'process.stdout.write(`${process.env.EXTRA_FLAG} ${process.env.CI} ${process.env.NO_COLOR}`);\n');
  const result = await runWrangler([], { ...opts(), extraEnv: { EXTRA_FLAG: 'yes', CI: '0', NO_COLOR: '' } });
  assert.equal(result.stdout, 'yes 1 1');
});

test('extraEnv with reserved keys -> invalid_input', async () => {
  for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'WRANGLER_OUTPUT_FILE_PATH']) {
    await assert.rejects(runWrangler([], { ...opts(), extraEnv: { [key]: 'x' } }), { code: 'invalid_input' });
  }
});

test('events are parsed from the ND-JSON output file, bad lines ignored', async () => {
  const events = [
    { type: 'wrangler-session', version: 1 },
    'not json {',
    { type: 'deploy', version_id: null },
  ];
  script({ 'deploy --dry-run': { code: 0, events } });
  const result = await runWrangler(['deploy', '--dry-run'], opts());
  assert.deepEqual(result.events, [
    { type: 'wrangler-session', version: 1 },
    { type: 'deploy', version_id: null },
  ]);
});

test('token and secrets are redacted from stdout and stderr; ANSI stripped', async () => {
  script({
    deploy: {
      code: 0,
      stdout: `\u001b[32mtoken ${TOKEN}\u001b[0m and ${SECRET}\n`,
      stderr: `\u001b[31mX [ERROR]\u001b[0m ${SECRET} ${TOKEN}\n`,
    },
  });
  const result = await runWrangler(['deploy'], { ...opts(), secrets: [SECRET, ''] });
  assert.equal(result.stdout, 'token [REDACTED] and [REDACTED]\n');
  assert.equal(result.stderr, 'X [ERROR] [REDACTED] [REDACTED]\n');
});

test('event string values are redacted after parsing (secret with quote and newline)', async () => {
  const tricky = 'pa"ss\nwo\\rd';
  script({
    deploy: {
      code: 1,
      events: [{ type: 'command-failed', message: `failed with ${tricky} and ${TOKEN}`, nested: { list: [tricky] } }],
    },
  });
  const result = await runWrangler(['deploy'], { ...opts(), secrets: [tricky] });
  assert.deepEqual(result.events, [
    { type: 'command-failed', message: 'failed with [REDACTED] and [REDACTED]', nested: { list: ['[REDACTED]'] } },
  ]);
});

test('a secret passed via stdin never appears in stdout even when echoed', async () => {
  script({ 'secret put KEY': { code: 0, echoStdin: true } });
  const result = await runWrangler(['secret', 'put', 'KEY'], { ...opts(), stdin: SECRET, secrets: [SECRET] });
  assert.equal(result.stdout, '[REDACTED]');
  assert.equal(result.stdout.includes(SECRET), false);
});

test('non-zero exit is returned, not thrown', async () => {
  script({ deploy: { code: 3, stderr: 'boom\n' } });
  const result = await runWrangler(['deploy'], opts());
  assert.equal(result.code, 3);
  assert.equal(result.stderr, 'boom\n');
});

test('temp ND-JSON file is removed after run, even on failure', async () => {
  helperScript(
    'write-out.mjs',
    [
      "import { writeFileSync } from 'node:fs';",
      "writeFileSync(process.env.WRANGLER_OUTPUT_FILE_PATH, '{\"type\":\"command-failed\",\"message\":\"m\"}\\n');",
      'process.stdout.write(process.env.WRANGLER_OUTPUT_FILE_PATH);',
      'process.exitCode = 1;',
      '',
    ].join('\n'),
  );
  const result = await runWrangler([], opts());
  assert.equal(result.code, 1);
  assert.equal(result.events.length, 1);
  assert.ok(result.stdout.length > 0);
  assert.equal(existsSync(result.stdout), false);
});

test('missing binary -> wrangler_missing', async () => {
  process.env.CLAUDEFLARE_WRANGLER = join(dir, 'does-not-exist');
  await assert.rejects(runWrangler(['--version'], opts()), (err) => {
    assert.equal(err.code, 'wrangler_missing');
    return true;
  });
});

test('timeout kills the process -> wrangler_failed', async () => {
  script({ deploy: { code: 0 } });
  process.env.FAKE_WRANGLER_DELAY_MS = '10000';
  const started = Date.now();
  await assert.rejects(runWrangler(['deploy'], { ...opts(), timeoutMs: 200 }), (err) => {
    assert.equal(err.code, 'wrangler_failed');
    assert.match(err.message, /timed out/);
    return true;
  });
  assert.ok(Date.now() - started < 5000);
});

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function assertGrandchildGone() {
  const record = logRecords().find((r) => r.grandchildPid);
  assert.ok(record, 'grandchild pid logged');
  for (let i = 0; i < 20 && isAlive(record.grandchildPid); i += 1) await new Promise((r) => setTimeout(r, 50));
  const alive = isAlive(record.grandchildPid);
  if (alive) process.kill(record.grandchildPid, 'SIGKILL');
  assert.equal(alive, false, 'grandchild was killed');
}

test('timeout is a hard stop when the child ignores SIGTERM and a grandchild holds stdio', async () => {
  script({ deploy: { code: 0, ignoreSigterm: true, grandchild: true, hang: true } });
  const timeoutMs = 4000; // long enough for the fake to install its handler and spawn the grandchild, even under load
  const started = Date.now();
  await assert.rejects(runWrangler(['deploy'], { ...opts(), timeoutMs }), { code: 'wrangler_failed' });
  assert.ok(Date.now() - started < timeoutMs + 5000 + 2000);
  await assertGrandchildGone();
});

test('timeout settles when the child exits but a grandchild keeps the pipes open', async () => {
  script({ deploy: { code: 0, grandchild: true, hang: true } });
  const started = Date.now();
  const timeoutMs = 4000; // node startup under a loaded suite can take seconds
  await assert.rejects(runWrangler(['deploy'], { ...opts(), timeoutMs }), { code: 'wrangler_failed' });
  assert.ok(Date.now() - started < timeoutMs + 5000 + 2000);
  await assertGrandchildGone();
});

test('stopAfterMs stops the process and resolves with collected output', async () => {
  script({
    tail: { code: 0, stdout: 'line 1\n', hang: true, events: [{ type: 'wrangler-session' }] },
  });
  const result = await runWrangler(['tail'], { ...opts(), stopAfterMs: 4000 });
  assert.equal(result.stopped, true);
  assert.equal(result.stdout, 'line 1\n');
  assert.deepEqual(result.events, [{ type: 'wrangler-session' }]);
  assert.equal(typeof result.code, 'number');
});

test('maxOutputBytes stops the process once output passes the limit and marks it truncated', async () => {
  script({ tail: { code: 0, stdout: 'x'.repeat(200000), hang: true } });
  const started = Date.now();
  const result = await runWrangler(['tail'], { ...opts(), stopAfterMs: 30000, maxOutputBytes: 1000 });
  assert.ok(Date.now() - started < 20000);
  assert.equal(result.truncated, true);
  assert.equal(result.stopped, true);
  assert.ok(result.stdout.length <= 1000);
});

test('failureMessage prefers the last command-failed event', () => {
  const result = {
    code: 1,
    stdout: '',
    stderr: 'line a\n\nline b\n',
    events: [
      { type: 'command-failed', message: 'first' },
      { type: 'wrangler-session' },
      { type: 'command-failed', message: 'Build failed' },
    ],
  };
  assert.equal(failureMessage(result), 'Build failed');
});

test('failureMessage falls back to the last 20 non-empty stderr lines', () => {
  const lines = Array.from({ length: 25 }, (_, i) => `l${i}`);
  const result = { code: 1, stdout: '', stderr: `${lines.join('\n\n')}\n`, events: [] };
  assert.equal(failureMessage(result), lines.slice(5).join('\n'));
});

test('assertWranglerVersion returns the 4.x version', async () => {
  script({ '--version': { code: 0, stdout: '4.152.0\n' } });
  assert.equal(await assertWranglerVersion(dir, opts()), '4.152.0');
});

test('assertWranglerVersion rejects 3.x with wrangler_version', async () => {
  script({ '--version': { code: 0, stdout: '3.99.0\n' } });
  await assert.rejects(assertWranglerVersion(dir, opts()), (err) => {
    assert.equal(err.code, 'wrangler_version');
    return true;
  });
});

test('assertWranglerVersion: missing binary, non-zero exit or no version -> wrangler_missing', async () => {
  const check = (err) => {
    assert.equal(err.code, 'wrangler_missing');
    assert.match(err.hint, /npm i -D wrangler@4/);
    return true;
  };
  script({ '--version': { code: 1, stderr: 'nope\n' } });
  await assert.rejects(assertWranglerVersion(dir, opts()), check);
  script({ '--version': { code: 0, stdout: 'garbage\n' } });
  await assert.rejects(assertWranglerVersion(dir, opts()), check);
  process.env.CLAUDEFLARE_WRANGLER = join(dir, 'does-not-exist');
  await assert.rejects(assertWranglerVersion(dir, opts()), check);
});

test('failureMessage appends the API error code wrangler reports in its own field', () => {
  const failed = (extra) => ({ code: 1, stderr: '', events: [{ type: 'command-failed', message: 'A request failed.', ...extra }] });
  assert.equal(failureMessage(failed({ code: 10007 })), 'A request failed. [code: 10007]');
  assert.equal(failureMessage(failed({})), 'A request failed.');
});
