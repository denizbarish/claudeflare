// Classifies and validates `wrangler` plan ops. wrangler answers its own
// confirmation prompts with "yes" when it runs non-interactively, so every
// destructive intent must be explicit in the plan and checked here, before any
// wrangler process starts. Runs on `plan new` and again in applyPlan.
//
// Each subcommand has a positive allowlist of flags and positionals, taken from
// `wrangler <subcommand> --help` (wrangler 4.152). Anything else is rejected.

import { existsSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { CfError } from './errors.mjs';

// Flag value types: 'bool' (bare flag only), 'string', 'list' (string, may
// repeat) and 'path' (string that must stay inside project_dir).
// Global flags allowed on every subcommand. --cwd, --env-file, --profile and
// --install-skills are deliberately absent.
const GLOBAL_FLAGS = { '--config': 'path', '--env': 'string' };
const GLOBAL_ALIASES = { '-c': '--config', '-e': '--env' };

const DO_MODE = { '--durable-objects-code-update-mode': 'string' };

// Positionals: { role, type, required, variadic }. role 'name' is the resource
// name, 'secret' the secret key.
const ALLOWLIST = [
  {
    words: ['deploy'],
    kind: 'worker_deploy',
    type: 'worker',
    positionals: [{ role: 'script', type: 'path' }],
    flags: {
      '--name': 'string', '--tag': 'string', '--no-bundle': 'bool', '--compatibility-date': 'string',
      '--compatibility-flags': 'list', '--latest': 'bool', '--assets': 'path', '--site': 'path', '--var': 'list',
      '--define': 'list', '--alias': 'list', '--jsx-factory': 'string', '--jsx-fragment': 'string',
      '--tsconfig': 'path', '--minify': 'bool', '--upload-source-maps': 'bool', '--keep-vars': 'bool',
      '--strict': 'bool', '--triggers': 'list', '--routes': 'list', '--domains': 'list', '--logpush': 'bool',
      '--old-asset-ttl': 'string', '--dispatch-namespace': 'string', '--containers-rollout': 'string', ...DO_MODE,
    },
    aliases: {
      '--compatibility-flag': '--compatibility-flags', '--schedule': '--triggers', '--schedules': '--triggers',
      '--route': '--routes', '--domain': '--domains',
    },
  },
  {
    words: ['versions', 'deploy'],
    kind: 'worker_versions_deploy',
    type: 'worker',
    positionals: [{ role: 'version-specs', type: 'string', variadic: true }],
    flags: { '--name': 'string', '--version-id': 'list', '--percentage': 'string', '--version-tag': 'list', ...DO_MODE },
  },
  {
    words: ['rollback'],
    kind: 'worker_rollback',
    type: 'worker',
    positionals: [{ role: 'version-id', type: 'string' }],
    flags: { '--name': 'string', ...DO_MODE },
  },
  {
    words: ['pages', 'deploy'],
    kind: 'pages_deploy',
    type: 'pages',
    positionals: [{ role: 'directory', type: 'path' }],
    flags: {
      '--project-name': 'string', '--branch': 'string', '--commit-hash': 'string', '--commit-message': 'string',
      '--commit-dirty': 'bool', '--skip-caching': 'bool', '--no-bundle': 'bool', '--upload-source-maps': 'bool',
    },
  },
  {
    words: ['d1', 'migrations', 'apply'],
    kind: 'd1_migrations_apply',
    type: 'd1',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--remote': 'bool' },
    required: ['--remote'],
  },
  {
    words: ['d1', 'time-travel', 'restore'],
    kind: 'd1_restore',
    type: 'd1',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--bookmark': 'string', '--json': 'bool' },
    required: ['--bookmark'],
  },
  {
    words: ['d1', 'create'],
    kind: 'resource_create',
    type: 'd1',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--location': 'string', '--jurisdiction': 'string' },
  },
  {
    words: ['d1', 'delete'],
    kind: 'resource_delete',
    type: 'd1',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: {},
  },
  {
    words: ['r2', 'bucket', 'create'],
    kind: 'resource_create',
    type: 'r2',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--location': 'string', '--storage-class': 'string', '--jurisdiction': 'string' },
    aliases: { '-s': '--storage-class', '-J': '--jurisdiction' },
  },
  {
    words: ['r2', 'bucket', 'delete'],
    kind: 'resource_delete',
    type: 'r2',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--jurisdiction': 'string' },
    aliases: { '-J': '--jurisdiction' },
  },
  {
    words: ['kv', 'namespace', 'create'],
    kind: 'resource_create',
    type: 'kv',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--preview': 'bool', '--jurisdiction': 'string' },
  },
  {
    // Only the namespace id identifies the target: no positional, no --binding.
    words: ['kv', 'namespace', 'delete'],
    kind: 'resource_delete',
    type: 'kv',
    positionals: [],
    flags: { '--namespace-id': 'string' },
    required: ['--namespace-id'],
    nameFlag: '--namespace-id',
  },
  {
    words: ['queues', 'create'],
    kind: 'resource_create',
    type: 'queue',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: { '--jurisdiction': 'string', '--delivery-delay-secs': 'string', '--message-retention-period-secs': 'string' },
  },
  {
    words: ['queues', 'delete'],
    kind: 'resource_delete',
    type: 'queue',
    positionals: [{ role: 'name', type: 'string', required: true }],
    flags: {},
  },
  {
    words: ['secret', 'put'],
    kind: 'secret_put',
    type: 'worker',
    positionals: [{ role: 'secret', type: 'string', required: true }],
    flags: { '--name': 'string' },
    required: ['--name'],
  },
  {
    words: ['secret', 'delete'],
    kind: 'secret_delete',
    type: 'worker',
    positionals: [{ role: 'secret', type: 'string', required: true }],
    flags: { '--name': 'string' },
    required: ['--name'],
  },
  {
    words: ['delete'],
    kind: 'worker_delete',
    type: 'worker',
    positionals: [],
    flags: { '--name': 'string' },
    required: ['--name'],
  },
];

const NOT_INVERTIBLE = new Set(['resource_delete', 'secret_put', 'secret_delete', 'worker_delete']);
export const DELETE_KINDS = new Set(['resource_delete', 'worker_delete']);
export const DEPLOY_KINDS = new Set(['worker_deploy', 'worker_versions_deploy', 'worker_rollback']);
// Deletes whose contents are lost with the resource (R2 deletes are refused
// at preflight when the bucket is not empty).
export const DATA_LOSS_TYPES = new Set(['kv', 'queue', 'd1']);

// The executor adds these at run time; drafts must not carry them so plans
// stay canonical.
const EXECUTOR_FLAGS = new Set(['--yes', '-y', '--message', '-m', '--skip-confirmation']);
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;
// Credentials and claudeflare's own settings must never become a secret value.
const RESERVED_ENV_PREFIXES = ['CLOUDFLARE_', 'WRANGLER_', 'CLAUDEFLARE_', 'ANTHROPIC_'];
const PRINTABLE = /^[\x20-\x7e]*$/;
const FLAG_LIKE = /^--?[a-z][a-z0-9-]*$/i;

function matchEntry(args) {
  let best = null;
  for (const entry of ALLOWLIST) {
    if (entry.words.length > args.length) continue;
    if (!entry.words.every((word, i) => args[i] === word)) continue;
    if (!best || entry.words.length > best.words.length) best = entry;
  }
  return best;
}

// yargs reads `--c` as `-c` and camelCase as kebab (--dryRun == --dry-run).
function normalizeFlag(raw) {
  if (/^--[A-Za-z]$/.test(raw)) return `-${raw.slice(2)}`;
  if (!raw.startsWith('--')) return raw;
  return raw.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

function canonicalFlag(entry, name) {
  return entry.aliases?.[name] ?? GLOBAL_ALIASES[name] ?? name;
}

function flagType(entry, name) {
  return entry.flags[name] ?? GLOBAL_FLAGS[name];
}

// Splits args after the subcommand words into flags and positionals. Never
// throws: the first problem is returned as `error` (messages never echo
// values, since a misplaced secret could be one).
function parseArgs(entry, rest) {
  const flags = new Map();
  const positionals = [];
  let error = null;
  const fail = (why) => {
    if (!error) error = why;
  };
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('-') || arg === '-') {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const raw = eq === -1 ? arg : arg.slice(0, eq);
    const name = canonicalFlag(entry, normalizeFlag(raw));
    const shown = FLAG_LIKE.test(name) ? name : 'an unrecognized flag';
    const type = flagType(entry, name);
    if (EXECUTOR_FLAGS.has(name)) {
      fail(`must not use ${name}; the executor adds confirmation flags at run time`);
      continue;
    }
    if (/^--(experimental|x)-/.test(name)) {
      fail(`must not use experimental flags (${shown})`);
      continue;
    }
    if (!type) {
      fail(`must not use ${shown} with "${entry.words.join(' ')}"`);
      continue;
    }
    let value = true;
    if (type === 'bool') {
      if (eq !== -1) fail(`${name} is a bare flag and takes no value`);
    } else if (eq !== -1) {
      value = arg.slice(eq + 1);
    } else if (rest[i + 1] !== undefined && !rest[i + 1].startsWith('-')) {
      value = rest[++i];
    } else {
      value = '';
    }
    if (type !== 'bool' && value === '') fail(`${name} needs a value`);
    if (flags.has(name) && type !== 'list') fail(`must not pass ${name} more than once`);
    flags.set(name, [...(flags.get(name) ?? []), value]);
  }
  const specs = entry.positionals;
  const variadic = specs.some((spec) => spec.variadic);
  if (!variadic && positionals.length > specs.length) {
    fail(`takes at most ${specs.length} positional argument(s) after "${entry.words.join(' ')}"`);
  }
  specs.forEach((spec, i) => {
    if (spec.required && (positionals[i] === undefined || positionals[i] === '')) {
      fail(`needs the ${spec.role === 'name' ? `${entry.type} name` : spec.role} as a positional argument`);
    }
  });
  for (const name of entry.required ?? []) {
    if (!flags.has(name)) fail(`must include ${name}`);
  }
  return { flags, positionals, error };
}

function flagValue(parsed, name) {
  const value = parsed.flags.get(name)?.[0];
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function positional(entry, parsed, role) {
  const i = entry.positionals.findIndex((spec) => spec.role === role);
  return i === -1 ? undefined : parsed.positionals[i] || undefined;
}

function resourceName(entry, parsed, op) {
  if (entry.nameFlag) return flagValue(parsed, entry.nameFlag);
  if (entry.type === 'worker') return flagValue(parsed, '--name') ?? (typeof op.worker === 'string' && op.worker ? op.worker : undefined);
  if (entry.type === 'pages') return flagValue(parsed, '--project-name');
  return positional(entry, parsed, 'name');
}

export function classifyWranglerOp(op) {
  const args = Array.isArray(op?.args) ? op.args : [];
  const entry = matchEntry(args);
  if (!entry) return { kind: 'unknown', invertible: false };
  const parsed = parseArgs(entry, args.slice(entry.words.length));
  const result = { kind: entry.kind, invertible: !NOT_INVERTIBLE.has(entry.kind) };
  const name = resourceName(entry, parsed, op);
  if (name) result.resource = { type: entry.type, name };
  return result;
}

function isInside(dir, target) {
  const rel = relative(dir, target);
  return rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

function nearestExisting(path) {
  let current = path;
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return current;
    current = parent;
  }
  return current;
}

// Lexically inside, and the nearest existing ancestor (the path itself when
// it exists) is inside after following symlinks.
function assertInsideProject(plan, what, value, reject) {
  const dir = plan?.project_dir;
  if (typeof dir !== 'string' || !isAbsolute(dir)) reject(`${what} needs an absolute project_dir to resolve against`);
  const target = resolve(dir, value);
  if (!isInside(dir, target)) reject(`${what} must point inside project_dir`);
  if (!existsSync(dir)) return;
  if (!isInside(realpathSync(dir), realpathSync(nearestExisting(target)))) reject(`${what} must point inside project_dir`);
}

function assertPaths(entry, parsed, plan, reject) {
  for (const [name, values] of parsed.flags) {
    if (flagType(entry, name) !== 'path') continue;
    for (const value of values) assertInsideProject(plan, name, value, reject);
  }
  entry.positionals.forEach((spec, i) => {
    const value = parsed.positionals[i];
    if (spec.type === 'path' && value !== undefined) assertInsideProject(plan, `the ${spec.role} argument`, value, reject);
  });
}

function assertWorker(parsed, op, reject) {
  if (op.worker !== undefined && (typeof op.worker !== 'string' || op.worker === '' || !PRINTABLE.test(op.worker))) {
    reject('worker must be a non-empty printable ASCII string');
  }
  const flag = flagValue(parsed, '--name');
  if (flag !== undefined && op.worker !== undefined && flag !== op.worker) reject('worker does not match --name');
}

function assertSecretPut(op, reject) {
  const name = op.value_from_env;
  if (typeof name !== 'string' || !ENV_NAME.test(name)) {
    reject('needs value_from_env naming an environment variable (^[A-Z_][A-Z0-9_]*$)');
  }
  if (RESERVED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix))) {
    reject(`value_from_env must not start with ${RESERVED_ENV_PREFIXES.join(', ')}`);
  }
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
  const parsed = parseArgs(entry, args.slice(entry.words.length));
  if (parsed.error) reject(parsed.error);
  assertPaths(entry, parsed, plan, reject);
  if (entry.type === 'worker') assertWorker(parsed, op, reject);
  if (entry.kind === 'secret_put') assertSecretPut(op, reject);
  if (DELETE_KINDS.has(entry.kind)) {
    const name = resourceName(entry, parsed, op);
    if (op.confirm_name !== name) reject(`needs confirm_name equal to the resource name (${JSON.stringify(name)})`);
  }
  assertHealth(op, reject);
}
