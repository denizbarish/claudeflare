import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSecretFiles } from '../scripts/lib/secret-files.mjs';
import { isGitIgnored, runTunnelToken, writeEnvVar } from '../scripts/lib/tunnel-token.mjs';

// In-process calls write the per-user index: keep it out of the real key dir.
const KEY_DIR = mkdtempSync(join(tmpdir(), 'claudeflare-tt-key-'));
process.env.CLAUDEFLARE_KEY_DIR = KEY_DIR;
after(() => rmSync(KEY_DIR, { recursive: true, force: true }));

const CLI = fileURLToPath(new URL('../scripts/cf.mjs', import.meta.url));
const TOKEN = 'tok-tunnel-token-API-123';
const AID = 'abcdef0123456789abcdef0123456789';
const TID = 'c1744f8b-faa1-48a4-9e5c-02ac921467fa';
const VALUE = 'eyJhIjoiVFVOTkVMLVNFQ1JFVC1WQUxVRSJ9';
const TOKEN_PATH = `/accounts/${AID}/cfd_tunnel/${TID}/token`;

function tempDir(t, prefix = 'claudeflare-tt-') {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Async spawn: the stub server lives in this process, so spawnSync would deadlock.
function run(cwd, args, env = {}) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env: { PATH: process.env.PATH, CLAUDEFLARE_KEY_DIR: join(cwd, '.key'), CLOUDFLARE_API_TOKEN: TOKEN, ...env } },
      (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr }),
    );
  });
}

async function stub(t, { result = VALUE, status = 200 } = {}) {
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization });
    const body = status === 200 ? { success: true, errors: [], result } : { success: false, errors: [{ code: 1000, message: 'bad' }] };
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  return { base: `http://127.0.0.1:${server.address().port}`, seen };
}

const args = (envFile, extra = []) => ['tunnel-token', '--account', AID, '--tunnel', TID, '--env-path', envFile, ...extra];

function assertNoValue(res) {
  assert.ok(!res.stdout.includes(VALUE), 'value printed on stdout');
  assert.ok(!res.stderr.includes(VALUE), 'value printed on stderr');
}

test('tunnel-token writes TUNNEL_TOKEN to a new env file with mode 0600 and prints no value', async (t) => {
  const cwd = tempDir(t);
  const { base, seen } = await stub(t);
  const res = await run(cwd, args('.env'), { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  assertNoValue(res);
  const out = JSON.parse(res.stdout);
  assert.deepEqual(out, { file: join(cwd, '.env'), variable: 'TUNNEL_TOKEN', gitignored: false, gitignore_warning: out.gitignore_warning });
  assert.equal(readFileSync(join(cwd, '.env'), 'utf8'), `TUNNEL_TOKEN=${VALUE}\n`);
  assert.equal(statSync(join(cwd, '.env')).mode & 0o777, 0o600);
  assert.deepEqual(seen, [{ method: 'GET', url: TOKEN_PATH, auth: `Bearer ${TOKEN}` }]);
});

test('tunnel-token replaces an existing TUNNEL_TOKEN line and keeps others', async (t) => {
  const cwd = tempDir(t);
  const file = join(cwd, 'app.env');
  writeFileSync(file, 'FOO=1\nTUNNEL_TOKEN=old\n# comment\nexport TUNNEL_TOKEN=older\nBAR=2', { mode: 0o600 });
  const { base } = await stub(t);
  const res = await run(cwd, args(file), { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  assertNoValue(res);
  assert.equal(readFileSync(file, 'utf8'), `FOO=1\nTUNNEL_TOKEN=${VALUE}\n# comment\nexport TUNNEL_TOKEN=${VALUE}\nBAR=2\n`);
  assert.equal(JSON.parse(res.stdout).mode_warning, undefined);
});

test('tunnel-token keeps the mode of an existing file and warns when others can read it', async (t) => {
  const cwd = tempDir(t);
  const file = join(cwd, '.env');
  writeFileSync(file, 'FOO=1\n');
  chmodSync(file, 0o644);
  const { base } = await stub(t);
  const res = await run(cwd, args('.env', ['--var', 'CF_TUNNEL']), { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.variable, 'CF_TUNNEL');
  assert.match(out.mode_warning, /0644/);
  assert.equal(statSync(file).mode & 0o777, 0o644);
  assert.equal(readFileSync(file, 'utf8'), `FOO=1\nCF_TUNNEL=${VALUE}\n`);
});

test('tunnel-token reports gitignored false outside .gitignore', async (t) => {
  const cwd = tempDir(t);
  const { base } = await stub(t);
  const res = await run(cwd, args('.env'), { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  const out = JSON.parse(res.stdout);
  assert.equal(out.gitignored, false);
  assert.match(out.gitignore_warning, /not ignored by git/);
});

test('isGitIgnored follows .gitignore inside a git repo and is false outside one', (t) => {
  const outside = tempDir(t);
  assert.equal(isGitIgnored(join(outside, '.env')), false);
  const repo = tempDir(t);
  if (spawnSync('git', ['init', '-q'], { cwd: repo }).status !== 0) return t.skip('git not available');
  writeFileSync(join(repo, '.gitignore'), '.env\n');
  assert.equal(isGitIgnored(join(repo, '.env')), true);
  assert.equal(isGitIgnored(join(repo, 'other.env')), false);
});

test('tunnel-token records the env file in secret-files.json', async (t) => {
  const cwd = tempDir(t);
  const { base } = await stub(t);
  for (let i = 0; i < 2; i++) {
    const res = await run(cwd, args('.env'), { CLOUDFLARE_API_BASE: base });
    assert.equal(res.code, 0, res.stderr);
  }
  assert.deepEqual(listSecretFiles(cwd), [join(cwd, '.env')]);
  assert.ok(!readFileSync(join(cwd, '.claudeflare', 'secret-files.json'), 'utf8').includes(VALUE));
});

test('tunnel-token validates --account, --tunnel and --var before any request', async (t) => {
  const cwd = tempDir(t);
  const { base, seen } = await stub(t);
  for (const bad of [
    ['tunnel-token', '--account', 'xyz', '--tunnel', TID, '--env-path', '.env'],
    ['tunnel-token', '--account', AID, '--tunnel', 'not-a-uuid', '--env-path', '.env'],
    args('.env', ['--var', 'lower']),
    args('.env', ['--var', '1BAD']),
    ['tunnel-token', '--account', AID, '--tunnel', TID],
  ]) {
    const res = await run(cwd, bad, { CLOUDFLARE_API_BASE: base });
    assert.notEqual(res.code, 0, bad.join(' '));
    assert.ok(JSON.parse(res.stderr).error.code, res.stderr);
  }
  assert.deepEqual(seen, []);
  assert.equal(existsSync(join(cwd, '.env')), false);
});

test('tunnel-token refuses a symlinked env file before reading the token', async (t) => {
  const cwd = tempDir(t);
  writeFileSync(join(cwd, 'real.env'), 'A=1\n');
  symlinkSync(join(cwd, 'real.env'), join(cwd, '.env'));
  const { base, seen } = await stub(t);
  const res = await run(cwd, args('.env'), { CLOUDFLARE_API_BASE: base });
  assert.notEqual(res.code, 0);
  assert.match(JSON.parse(res.stderr).error.message, /symlink/);
  assert.deepEqual(seen, []);
  assert.equal(readFileSync(join(cwd, 'real.env'), 'utf8'), 'A=1\n');
});

test('tunnel-token fails with the error JSON on an API error and on a malformed value, never printing it', async (t) => {
  const cwd = tempDir(t);
  const failing = await stub(t, { status: 403 });
  const res = await run(cwd, args('.env'), { CLOUDFLARE_API_BASE: failing.base });
  assert.notEqual(res.code, 0);
  assert.equal(JSON.parse(res.stderr).error.code, 'permission');
  assert.equal(existsSync(join(cwd, '.env')), false);

  const multiline = await stub(t, { result: `${VALUE}\nINJECTED=1` });
  const bad = await run(cwd, args('.env'), { CLOUDFLARE_API_BASE: multiline.base });
  assert.notEqual(bad.code, 0);
  assertNoValue(bad);
  assert.equal(JSON.parse(bad.stderr).error.code, 'invalid_response');
  assert.equal(existsSync(join(cwd, '.env')), false);
});

test('writeEnvVar creates a 0600 file and appends to a file without the variable', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'x.env');
  assert.equal(writeEnvVar(file, 'A_B', 'v1'), undefined);
  assert.equal(readFileSync(file, 'utf8'), 'A_B=v1\n');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  writeEnvVar(file, 'C', 'v2');
  assert.equal(readFileSync(file, 'utf8'), 'A_B=v1\nC=v2\n');
  assert.throws(() => writeEnvVar(file, 'bad-name', 'v'), /variable name/);
});

test('writeEnvVar keeps CRLF line endings and values containing =', (t) => {
  const dir = tempDir(t);
  const file = join(dir, 'x.env');
  writeFileSync(file, 'A=1\r\nTUNNEL_TOKEN=old\r\nB=2\r\n', { mode: 0o600 });
  writeEnvVar(file, 'TUNNEL_TOKEN', 'eyJhYmMi==');
  assert.equal(readFileSync(file, 'utf8'), 'A=1\r\nTUNNEL_TOKEN=eyJhYmMi==\r\nB=2\r\n');
  writeEnvVar(file, 'TUNNEL_TOKEN', 'x=y=z');
  assert.equal(readFileSync(file, 'utf8'), 'A=1\r\nTUNNEL_TOKEN=x=y=z\r\nB=2\r\n');
});

test('tunnel-token records the env file under the project root shared with the guard', async (t) => {
  const project = tempDir(t);
  mkdirSync(join(project, '.git'));
  mkdirSync(join(project, 'a'));
  mkdirSync(join(project, 'b'));
  const { base } = await stub(t);
  const res = await run(join(project, 'b'), args('../a/.env'), { CLOUDFLARE_API_BASE: base });
  assert.equal(res.code, 0, res.stderr);
  assert.equal(JSON.parse(res.stdout).file, join(project, 'a', '.env'));
  assert.deepEqual(listSecretFiles(project), [join(project, 'a', '.env')]);
  assert.equal(existsSync(join(project, 'b', '.claudeflare')), false);
});

test('a write failure after a successful read is redacted and the index entry is already recorded', async (t) => {
  const root = tempDir(t);
  // The value doubles as the folder name, so the OS error message contains it.
  const value = 'eyJTRUNSRVQtRElSLVZBTFVFIn0';
  const dir = join(root, value);
  mkdirSync(dir);
  chmodSync(dir, 0o500);
  const fake = () => ({ request: async () => value });
  const opts = { account: AID, tunnel: TID, envFile: join(dir, '.env') };
  try {
    await assert.rejects(runTunnelToken(root, opts, fake), (err) => {
      assert.equal(err.code, 'write_failed');
      assert.ok(!err.message.includes(value), err.message);
      assert.match(err.message, /\[REDACTED\]/);
      return true;
    });
  } finally {
    chmodSync(dir, 0o700);
  }
  assert.deepEqual(listSecretFiles(root), [join(dir, '.env')]);
  assert.equal(existsSync(join(dir, '.env')), false);
});
