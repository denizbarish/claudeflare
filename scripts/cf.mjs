// claudeflare CLI: the only path for Cloudflare writes. Prints JSON on stdout;
// errors go to stderr as { error: { code, message, hint } }.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient, redact } from './lib/api.mjs';
import { CfError } from './lib/errors.mjs';
import { paths } from './lib/paths.mjs';
import { createPlan, listPlans, readPlan, slugify, updatePlan } from './lib/plans.mjs';
import { validateOpTargets, validatePlanOps } from './lib/resources.mjs';
import { captureSnapshot } from './lib/snapshot.mjs';
import { applyPlan, assertDraft, createRollbackPlan, withIrreversibleRisk, writePreviewSnapshot } from './lib/apply.mjs';
import { scoreDomains } from './lib/score.mjs';
import { renderReport } from './lib/report.mjs';

const GITIGNORE_ENTRY = '.claudeflare/';
const USAGE = 'claudeflare init | get <path> [--query k=v ...] | plan new --file <draft.json> | plan show <id> | plan list | snapshot <id> | apply <id> | rollback <id> | report --file <findings.json> --zone <zone>';

function usage(message) {
  return new CfError('usage', message, { hint: `Usage: ${USAGE}` });
}

// Splits argv into positionals and --flag values; repeated flags collect into arrays.
function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const name = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw usage(`Missing value for --${name}`);
    (flags[name] ??= []).push(value);
    i++;
  }
  return { positional, flags };
}

function flag(flags, name) {
  const value = flags[name]?.at(-1);
  if (value === undefined) throw usage(`Missing required --${name}`);
  return value;
}

function arg(positional, index, name) {
  const value = positional[index];
  if (value === undefined) throw usage(`Missing <${name}>`);
  return value;
}

function readJsonFile(cwd, file) {
  let raw;
  try {
    raw = readFileSync(resolve(cwd, file), 'utf8');
  } catch (err) {
    throw new CfError('invalid_input', `Cannot read ${file}: ${err.code || err.message}`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new CfError('invalid_input', `${file} is not valid JSON`);
  }
}

function printJson(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function init(cwd) {
  const p = paths(cwd);
  for (const dir of [p.plans, p.approvals, join(p.root, 'snapshots'), join(p.root, 'reports')]) {
    mkdirSync(dir, { recursive: true });
  }
  const gitignore = join(cwd, '.gitignore');
  let content = '';
  try {
    content = readFileSync(gitignore, 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  const present = content.split(/\r?\n/).some((line) => line.trim() === GITIGNORE_ENTRY);
  if (!present) {
    const separator = content && !content.endsWith('\n') ? '\n' : '';
    writeFileSync(gitignore, `${content}${separator}${GITIGNORE_ENTRY}\n`);
  }
  return { root: p.root, gitignore_updated: !present };
}

function parseQuery(pairs = []) {
  const query = {};
  for (const pair of pairs) {
    const eq = pair.indexOf('=');
    if (eq <= 0) throw usage(`Invalid --query ${JSON.stringify(pair)}; expected k=v`);
    query[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return query;
}

async function get(positional, flags) {
  const path = arg(positional, 1, 'path');
  if (!path.startsWith('/')) throw usage('Path must start with /');
  return createClient().request('GET', path, { query: parseQuery(flags.query) });
}

const PLAN_SCOPES = new Set(['zone', 'account']);

function isDraftOp(op) {
  return op?.kind === 'wrangler' || (typeof op?.method === 'string' && typeof op?.path === 'string');
}

function assertDraftOps(ops) {
  const valid = Array.isArray(ops) && ops.length > 0 && ops.every(isDraftOp);
  if (!valid) {
    throw new CfError('invalid_input', 'Draft ops must be a non-empty array of { method, path, body? } or { kind: "wrangler", args }');
  }
}

function planNew(cwd, flags) {
  const draft = readJsonFile(cwd, flag(flags, 'file'));
  assertDraftOps(draft?.ops);
  const scope = draft.scope ?? 'zone';
  if (!PLAN_SCOPES.has(scope)) throw new CfError('invalid_input', `Invalid plan scope: ${JSON.stringify(scope)}`);
  let target;
  let resolved;
  if (scope === 'account') {
    target = { scope, account_id: draft.account_id, project_dir: draft.project_dir };
    resolved = draft.ops;
  } else {
    const zoneId = String(draft.zone_id);
    target = { scope, zone_id: zoneId };
    resolved = draft.ops.map((op) => (typeof op.path === 'string' ? { ...op, path: op.path.split('{zone_id}').join(zoneId) } : op));
  }
  validateOpTargets(resolved, target);
  validatePlanOps(resolved);
  const slug = slugify(draft.slug ?? '') || 'plan';
  const plan = createPlan(cwd, {
    scope,
    zone_id: draft.zone_id,
    zone_name: draft.zone_name,
    account_id: draft.account_id,
    account_name: draft.account_name,
    project_dir: draft.project_dir,
    summary: draft.summary,
    risk: withIrreversibleRisk(draft.risk, resolved),
    ops: draft.ops,
    slug,
  });
  return updatePlan(cwd, plan.id, { slug });
}

function plan(cwd, positional, flags) {
  const sub = arg(positional, 1, 'new|show|list');
  if (sub === 'new') return planNew(cwd, flags);
  if (sub === 'show') return readPlan(cwd, arg(positional, 2, 'id'));
  if (sub === 'list') return listPlans(cwd);
  throw usage(`Unknown plan subcommand: ${sub}`);
}

async function snapshot(cwd, positional) {
  const target = readPlan(cwd, arg(positional, 1, 'id'));
  assertDraft(target);
  const snap = await captureSnapshot(createClient(), target);
  writePreviewSnapshot(cwd, target, snap);
  return snap;
}

// Accepts a findings array or { domains: [...], findings: [...] }.
function parseAudit(data) {
  if (Array.isArray(data)) return { findings: data, domains: [] };
  const { findings, domains = [] } = data ?? {};
  if (!Array.isArray(findings) || !Array.isArray(domains) || !domains.every((d) => typeof d === 'string')) {
    throw new CfError('invalid_input', 'Findings file must be an array or { domains: string[], findings: [] }');
  }
  return { findings, domains };
}

function report(cwd, flags) {
  const { findings, domains } = parseAudit(readJsonFile(cwd, flag(flags, 'file')));
  const zone = flag(flags, 'zone');
  const dir = paths(cwd).reports(zone);
  const stamp = new Date().toISOString().replace(/\.\d{3}Z$/, '').replace(/[-:]/g, '').replace('T', '-');
  const file = join(dir, `${stamp}-audit.md`);
  const scores = scoreDomains(findings, domains);
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, renderReport(zone, findings, scores));
  return { file, overall: scores.overall, domains: scores.domains };
}

async function applyCommand(cwd, positional) {
  const result = await applyPlan(cwd, createClient(), arg(positional, 1, 'id'));
  printJson(result);
  if (result.status !== 'applied') {
    const hint = result.status === 'partially_applied'
      ? `Run claudeflare rollback ${result.id} to revert the ops that succeeded`
      : 'The first op failed, so no write was made; fix the cause and create a new plan';
    throw new CfError('apply_failed', `Plan ${result.id} ${result.status}: ${result.error?.message}`, { hint });
  }
}

async function main(argv) {
  const cwd = process.cwd();
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  switch (command) {
    case 'init': return printJson(init(cwd));
    case 'get': return printJson(await get(positional, flags));
    case 'plan': return printJson(plan(cwd, positional, flags));
    case 'snapshot': return printJson(await snapshot(cwd, positional));
    case 'apply': return applyCommand(cwd, positional);
    case 'rollback': return printJson(createRollbackPlan(cwd, arg(positional, 1, 'id')));
    case 'report': return printJson(report(cwd, flags));
    default: throw usage(command ? `Unknown command: ${command}` : 'Missing command');
  }
}

function printError(err) {
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const known = err instanceof CfError;
  const error = {
    code: known ? err.code : 'internal',
    message: redact(String(err?.message ?? err), token),
    hint: redact(known ? err.hint || '' : '', token),
  };
  process.stderr.write(`${JSON.stringify({ error })}\n`);
}

try {
  await main(process.argv.slice(2));
} catch (err) {
  printError(err);
  process.exitCode = 1;
}
