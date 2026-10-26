// claudeflare tunnel-token: reads a tunnel token and writes it into an env
// file. The token is never printed, logged or put in an error message; the
// env file is recorded in secret-files.json so the guard keeps the agent from
// reading it back. Not a Cloudflare write, so no plan; the endpoint needs
// Tunnel Write, so it runs with the same token as apply.

import { spawnSync } from 'node:child_process';
import { realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { createClient, redact } from './api.mjs';
import { CfError } from './errors.mjs';
import { lstatOrNull, readOrEmpty, recordSecretFile, refuseLink, replaceFile } from './secret-files.mjs';

export const DEFAULT_VARIABLE = 'TUNNEL_TOKEN';
const VARIABLE = /^[A-Z_][A-Z0-9_]*$/;
const ACCOUNT_ID = /^[0-9a-f]{32}$/i;
const TUNNEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SINGLE_LINE = /^[^\r\n\0]+$/;
const NEW_FILE_MODE = 0o600;
const OTHERS_MASK = 0o077;

const lineFor = (name) => new RegExp(`^(\\s*(?:export\\s+)?)${name}\\s*=`);

// Refuses a symlink or a non-file at the env file path; returns its lstat or null.
function envFileStat(file) {
  const stat = lstatOrNull(file);
  refuseLink(file, stat);
  if (stat && !stat.isFile()) throw new Error(`${file} is not a regular file`);
  return stat;
}

// Creates file with mode 0600 or rewrites it keeping its mode: every NAME=
// line (also `export NAME=`) gets the new value, other lines stay, and NAME
// is appended when absent. Never follows a symlink.
export function writeEnvVar(file, name, value) {
  if (typeof name !== 'string' || !VARIABLE.test(name)) throw new TypeError(`Invalid variable name: ${JSON.stringify(name)}`);
  if (typeof value !== 'string' || !SINGLE_LINE.test(value)) throw new TypeError('The value must be a non-empty single-line string');
  const stat = envFileStat(file);
  const content = stat ? readOrEmpty(file) : '';
  const lines = content === '' ? [] : content.replace(/\r?\n$/, '').split(/\r?\n/);
  const pattern = lineFor(name);
  let found = false;
  const next = lines.map((line) => {
    const match = pattern.exec(line);
    if (!match) return line;
    found = true;
    return `${match[1]}${name}=${value}`;
  });
  if (!found) next.push(`${name}=${value}`);
  replaceFile(file, `${next.join('\n')}\n`, stat ? stat.mode & 0o777 : NEW_FILE_MODE);
}

// True when git ignores file; false outside a git repo or without git.
export function isGitIgnored(file) {
  const res = spawnSync('git', ['check-ignore', '-q', '--', basename(file)], { cwd: dirname(file), stdio: 'ignore' });
  return res.status === 0;
}

function validate({ account, tunnel, variable }) {
  if (!ACCOUNT_ID.test(account)) throw new CfError('invalid_input', `Invalid --account ${JSON.stringify(account)}; expected a 32 character hex account id`);
  if (!TUNNEL_ID.test(tunnel)) throw new CfError('invalid_input', `Invalid --tunnel ${JSON.stringify(tunnel)}; expected a tunnel UUID`);
  if (!VARIABLE.test(variable)) throw new CfError('invalid_input', `Invalid --var ${JSON.stringify(variable)}; expected ${VARIABLE.source}`);
}

// Everything that can be checked without the token is checked first, so a
// bad path never costs a token read. Returns the canonical file path and its stat.
function prepareFile(cwd, envFile) {
  const abs = resolve(cwd, envFile);
  let dir;
  try {
    dir = realpathSync(dirname(abs));
    if (!statSync(dir).isDirectory()) throw new Error(`${dir} is not a directory`);
  } catch (err) {
    throw new CfError('invalid_input', `Cannot use ${abs}: ${err.code === 'ENOENT' ? 'its directory does not exist' : err.message}`);
  }
  const file = join(dir, basename(abs));
  try {
    return { file, stat: envFileStat(file) };
  } catch (err) {
    throw new CfError('invalid_input', err.message);
  }
}

function modeWarning(file, stat) {
  const mode = stat ? stat.mode & 0o777 : NEW_FILE_MODE;
  if (!(mode & OTHERS_MASK)) return null;
  return `${file} has mode 0${mode.toString(8)}, so group or other users can read the token; run chmod 600 on it`;
}

export async function runTunnelToken(cwd, { account, tunnel, envFile, variable = DEFAULT_VARIABLE }, makeClient = createClient) {
  validate({ account, tunnel, variable });
  const { file, stat } = prepareFile(cwd, envFile);
  const value = await makeClient().request('GET', `/accounts/${account}/cfd_tunnel/${tunnel}/token`);
  if (typeof value !== 'string' || !SINGLE_LINE.test(value)) {
    throw new CfError('invalid_response', 'The tunnel token response is not a non-empty single-line string; nothing was written');
  }
  try {
    writeEnvVar(file, variable, value);
    recordSecretFile(cwd, file);
  } catch (err) {
    const message = redact(String(err?.message ?? err), process.env.CLOUDFLARE_API_TOKEN, [value]);
    throw new CfError('write_failed', `Writing ${variable} failed: ${message}`);
  }
  const gitignored = isGitIgnored(file);
  const out = { file, variable, gitignored };
  if (!gitignored) out.gitignore_warning = `${file} is not ignored by git; add it to .gitignore before committing`;
  const warning = modeWarning(file, stat);
  if (warning) out.mode_warning = warning;
  return out;
}
