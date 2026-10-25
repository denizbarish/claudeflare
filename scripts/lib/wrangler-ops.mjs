// Classifies and validates `wrangler` plan ops. wrangler answers its own
// confirmation prompts with "yes" when it runs non-interactively, so every
// destructive intent must be explicit in the plan and checked here, before any
// wrangler process starts. Runs on `plan new` and again in applyPlan.

import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CfError } from './errors.mjs';

// Leading positional args, matched exactly. `name` says where the resource
// name lives: 'positional' (first arg after the words), 'worker' (--name or
// op.worker), 'project' (--project-name) or 'namespace' (--namespace-id).
const ALLOWLIST = [
  { words: ['deploy'], kind: 'worker_deploy', type: 'worker', name: 'worker' },
  { words: ['versions', 'deploy'], kind: 'worker_versions_deploy', type: 'worker', name: 'worker' },
  { words: ['rollback'], kind: 'worker_rollback', type: 'worker', name: 'worker' },
  { words: ['pages', 'deploy'], kind: 'pages_deploy', type: 'pages', name: 'project' },
  { words: ['d1', 'migrations', 'apply'], kind: 'd1_migrations_apply', type: 'd1', name: 'positional', remote: true },
  { words: ['d1', 'time-travel', 'restore'], kind: 'd1_restore', type: 'd1', name: 'positional', remote: true },
  { words: ['d1', 'create'], kind: 'resource_create', type: 'd1', name: 'positional' },
  { words: ['d1', 'delete'], kind: 'resource_delete', type: 'd1', name: 'positional' },
  { words: ['r2', 'bucket', 'create'], kind: 'resource_create', type: 'r2', name: 'positional' },
  { words: ['r2', 'bucket', 'delete'], kind: 'resource_delete', type: 'r2', name: 'positional' },
  { words: ['kv', 'namespace', 'create'], kind: 'resource_create', type: 'kv', name: 'positional' },
  { words: ['kv', 'namespace', 'delete'], kind: 'resource_delete', type: 'kv', name: 'namespace' },
  { words: ['queues', 'create'], kind: 'resource_create', type: 'queue', name: 'positional' },
  { words: ['queues', 'delete'], kind: 'resource_delete', type: 'queue', name: 'positional' },
  { words: ['secret', 'put'], kind: 'secret_put', type: 'worker', name: 'worker', secret: true },
  { words: ['secret', 'delete'], kind: 'secret_delete', type: 'worker', name: 'worker', secret: true },
  { words: ['delete'], kind: 'worker_delete', type: 'worker', name: 'worker' },
];

const NOT_INVERTIBLE = new Set(['resource_delete', 'secret_put', 'secret_delete', 'worker_delete']);
export const DELETE_KINDS = new Set(['resource_delete', 'worker_delete']);
export const DEPLOY_KINDS = new Set(['worker_deploy', 'worker_versions_deploy', 'worker_rollback']);

// --dry-run and --outdir belong to preflight; --yes and --message are added
// by the executor so plans stay canonical; --cwd and --env-file would change
// what runs or which values it sees.
const FORBIDDEN_FLAGS = new Set(['--dry-run', '--outdir', '--out-dir', '--cwd', '--env-file', '--yes', '--message', '-y']);
const CONFIG_FLAGS = ['--config', '-c'];
const SECRET_PUT_FLAGS = new Set(['--name', '--env', '-e', '--config', '-c']);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
const PRINTABLE = /^[\x20-\x7e]*$/;

function matchEntry(args) {
  let best = null;
  for (const entry of ALLOWLIST) {
    if (entry.words.length > args.length) continue;
    if (!entry.words.every((word, i) => args[i] === word)) continue;
    if (!best || entry.words.length > best.words.length) best = entry;
  }
  return best;
}

// yargs accepts camelCase spellings of kebab flags (--dryRun == --dry-run).
function flagName(arg) {
  const name = arg.split('=')[0];
  if (!name.startsWith('--')) return name;
  return name.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

// Every occurrence of the flag: { value } where value is null when missing.
function flagOccurrences(rest, names) {
  const found = [];
  rest.forEach((arg, i) => {
    if (!arg.startsWith('-')) return;
    const name = flagName(arg);
    if (!names.includes(name)) return;
    const eq = arg.indexOf('=');
    if (eq !== -1) {
      found.push({ value: arg.slice(eq + 1) || null });
      return;
    }
    const next = rest[i + 1];
    found.push({ value: next !== undefined && !next.startsWith('-') ? next : null });
  });
  return found;
}

function hasFlag(rest, name) {
  return rest.some((arg) => arg.startsWith('-') && flagName(arg) === name);
}

function firstPositional(rest) {
  const arg = rest[0];
  return typeof arg === 'string' && arg !== '' && !arg.startsWith('-') ? arg : undefined;
}

function workerName(rest, op) {
  return flagOccurrences(rest, ['--name'])[0]?.value ?? (typeof op.worker === 'string' ? op.worker : undefined);
}

function resourceName(entry, rest, op) {
  if (entry.name === 'positional') return firstPositional(rest);
  if (entry.name === 'worker') return workerName(rest, op) || undefined;
  if (entry.name === 'project') return flagOccurrences(rest, ['--project-name'])[0]?.value ?? undefined;
  return flagOccurrences(rest, ['--namespace-id'])[0]?.value ?? undefined;
}

export function classifyWranglerOp(op) {
  const args = Array.isArray(op?.args) ? op.args : [];
  const entry = matchEntry(args);
  if (!entry) return { kind: 'unknown', invertible: false };
  const rest = args.slice(entry.words.length);
  const result = { kind: entry.kind, invertible: !NOT_INVERTIBLE.has(entry.kind) };
  const name = resourceName(entry, rest, op);
  if (name) result.resource = { type: entry.type, name };
  return result;
}

function isInside(dir, target) {
  const rel = relative(dir, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function assertConfigInside(rest, plan, reject) {
  const found = flagOccurrences(rest, CONFIG_FLAGS);
  if (found.length === 0) return;
  if (found.length > 1) reject('must not pass --config more than once');
  const { value } = found[0];
  if (!value) reject('--config needs a value');
  const dir = plan?.project_dir;
  if (typeof dir !== 'string' || !isAbsolute(dir)) reject('--config needs an absolute project_dir to resolve against');
  const target = resolve(dir, value);
  if (!isInside(dir, target)) reject('--config must point inside project_dir');
  // Symlinks are followed when the file exists, so a link cannot escape.
  if (existsSync(target) && existsSync(dir) && !isInside(realpathSync(dir), realpathSync(target))) {
    reject('--config must point inside project_dir');
  }
}

function assertFlags(rest, reject) {
  for (const arg of rest) {
    if (!arg.startsWith('-')) continue;
    const name = flagName(arg);
    if (FORBIDDEN_FLAGS.has(name) || name.startsWith('--x-')) reject(`must not use ${name}`);
    if (/^-[^-]./.test(name)) reject(`must not group short flags (${name}); pass each short flag on its own`);
  }
}

function single(rest, name, reject) {
  const found = flagOccurrences(rest, [name]);
  if (found.length > 1) reject(`must not pass ${name} more than once`);
  if (found.length === 1 && !found[0].value) reject(`${name} needs a value`);
  return found[0]?.value ?? undefined;
}

function assertWorker(entry, rest, op, reject) {
  if (op.worker !== undefined && (typeof op.worker !== 'string' || op.worker === '' || !PRINTABLE.test(op.worker))) {
    reject('worker must be a non-empty printable ASCII string');
  }
  const flag = single(rest, '--name', reject);
  if (flag !== undefined && op.worker !== undefined && flag !== op.worker) reject('worker does not match --name');
  const name = flag ?? op.worker;
  if (entry.kind === 'worker_delete') {
    if (firstPositional(rest)) reject('must name the Worker with --name or worker, not a positional argument');
    if (!name) reject('needs the Worker name in --name or worker');
  }
  if (entry.kind === 'secret_put' && !name) reject('needs the target worker in --name or worker');
}

// Only known flags with values may follow the secret name, so a literal value
// cannot ride along in args. The message never echoes the offending arg.
function assertSecretPut(rest, op, reject) {
  if (typeof op.value_from_env !== 'string' || !ENV_NAME.test(op.value_from_env)) {
    reject('needs value_from_env naming an environment variable (^[A-Z_][A-Z0-9_]*$)');
  }
  for (let i = 1; i < rest.length; i++) {
    const arg = rest[i];
    const known = arg.startsWith('-') && SECRET_PUT_FLAGS.has(flagName(arg));
    if (!known) reject(`has an extra argument (args[${i + 2}]); only --name, --env and --config may follow the secret name`);
    if (arg.includes('=')) continue;
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('-')) reject(`${flagName(arg)} needs a value`);
    i++;
  }
}

function assertNamed(entry, rest, op, reject) {
  if (entry.name === 'positional' && !firstPositional(rest)) {
    reject(`needs the ${entry.type} name right after "${entry.words.join(' ')}"`);
  }
  if (entry.secret && !firstPositional(rest)) reject(`needs the secret name right after "${entry.words.join(' ')}"`);
  if (entry.name === 'namespace' && !single(rest, '--namespace-id', reject)) reject('needs --namespace-id <id>');
  if (entry.name === 'worker') assertWorker(entry, rest, op, reject);
  if (entry.name === 'project') single(rest, '--project-name', reject);
}

function assertRemote(entry, rest, reject) {
  if (!entry.remote) return;
  // Only the bare flag counts: --remote=false would run against the local copy.
  if (rest.some((arg) => arg.startsWith('-') && flagName(arg) === '--remote' && arg !== '--remote')) reject('must pass --remote without a value');
  if (!rest.includes('--remote')) reject('must include --remote');
  if (hasFlag(rest, '--local') || hasFlag(rest, '--no-remote')) reject('must not use --local or --no-remote');
  if (entry.kind === 'd1_restore' && !single(rest, '--bookmark', reject)) reject('needs --bookmark <bookmark>');
}

function assertHealth(op, reject) {
  if (op.on_failed_check !== undefined && op.on_failed_check !== 'rollback') {
    reject('on_failed_check must be "rollback" or absent');
  }
  if (op.health_check === undefined) return;
  const url = op.health_check?.url;
  let parsed = null;
  try {
    parsed = typeof url === 'string' && typeof op.health_check === 'object' ? new URL(url) : null;
  } catch {
    parsed = null;
  }
  if (!parsed || parsed.protocol !== 'https:') reject('health_check.url must be an https URL');
}

export function validateWranglerOp(op, plan, index) {
  const label = index === undefined ? 'Wrangler op' : `Op ${index} (wrangler)`;
  const reject = (why) => {
    throw new CfError('invalid_op', `${label} ${why}`);
  };
  const args = op.args;
  if (!args.every((arg) => PRINTABLE.test(arg))) reject('args must be printable ASCII without control characters');
  const entry = matchEntry(args);
  if (!entry) reject(`subcommand ${JSON.stringify(args.slice(0, 3).join(' '))} is not allowlisted`);
  const rest = args.slice(entry.words.length);
  assertFlags(rest, reject);
  assertConfigInside(rest, plan, reject);
  assertNamed(entry, rest, op, reject);
  assertRemote(entry, rest, reject);
  if (entry.kind === 'secret_put') assertSecretPut(rest, op, reject);
  if (DELETE_KINDS.has(entry.kind)) {
    const name = resourceName(entry, rest, op);
    if (op.confirm_name !== name) reject(`needs confirm_name equal to the resource name (${JSON.stringify(name)})`);
  }
  assertHealth(op, reject);
}
