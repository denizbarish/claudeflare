// claudeflare CLI: the only path for Cloudflare writes. Prints JSON on stdout;
// errors go to stderr as { error: { code, message, hint } }.

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createClient, redact } from './lib/api.mjs';
import { CfError } from './lib/errors.mjs';
import { paths } from './lib/paths.mjs';
import { accountTarget, createPlan, listPlans, needsProjectDir, readPlan, slugify, updatePlan } from './lib/plans.mjs';
import { validateOpTargets, validatePlanOps } from './lib/resources.mjs';
import { captureSnapshot } from './lib/snapshot.mjs';
import { addRollbackLockout, applyPlan, assertDraft, createRollbackPlan, withIrreversibleRisk, writePreviewSnapshot } from './lib/apply.mjs';
import { assertR2DeletesEmpty } from './lib/wrangler-exec.mjs';
import { classifyWranglerOp } from './lib/wrangler-ops.mjs';
import { migrationRisk, runPreflight } from './lib/preflight.mjs';
import { hasProductOps } from './lib/product-preflight.mjs';
import { runTail } from './lib/tail.mjs';
import { scoreDomains } from './lib/score.mjs';
import { renderReport } from './lib/report.mjs';
import { DEFAULT_VARIABLE, runTunnelToken } from './lib/tunnel-token.mjs';
import { isTokenEndpoint, TUNNEL_TOKEN_REASON } from './lib/token-endpoint.mjs';
import { applyFailure } from './lib/apply-message.mjs';

const GITIGNORE_ENTRY = '.claudeflare/';
const USAGE = 'claudeflare init | get <path> [--query k=v ...] | preflight --file <draft.json> | plan new --file <draft.json> | plan show <id> | plan list | snapshot <id> | apply <id> | rollback <id> | report --file <findings.json> --zone <zone> | tail --worker <name> --seconds <n> [--status error] [--account <id>] | tunnel-token --account <id> --tunnel <uuid> --env-path <path> [--var TUNNEL_TOKEN]';

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
  // Enforced here, not only in the guard: shell quoting or a path built from
  // variables never reaches a token endpoint through get.
  if (isTokenEndpoint(path)) throw new CfError('invalid_input', `${TUNNEL_TOKEN_REASON} claudeflare get refuses ${path}.`);
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

function hasR2Delete(ops) {
  return ops.some((op) => {
    if (op?.kind !== 'wrangler') return false;
    const { kind, resource } = classifyWranglerOp(op);
    return kind === 'resource_delete' && resource?.type === 'r2';
  });
}

function readDraft(cwd, flags) {
  const draft = readJsonFile(cwd, flag(flags, 'file'));
  assertDraftOps(draft?.ops);
  const scope = draft.scope ?? 'zone';
  if (!PLAN_SCOPES.has(scope)) throw new CfError('invalid_input', `Invalid plan scope: ${JSON.stringify(scope)}`);
  if (scope === 'account') {
    const { account_id, project_dir } = accountTarget(draft, { requireProjectDir: needsProjectDir(draft.ops) });
    return { draft, target: { scope, account_id, project_dir }, resolved: draft.ops };
  }
  const zoneId = String(draft.zone_id);
  const resolved = draft.ops.map((op) => (typeof op.path === 'string' ? { ...op, path: op.path.split('{zone_id}').join(zoneId) } : op));
  return { draft, target: { scope, zone_id: zoneId }, resolved };
}

async function preflight(cwd, flags) {
  const { target, resolved } = readDraft(cwd, flags);
  // ctx holds the raw account reads product modules gathered; not printed.
  const { ops: _ops, ctx: _ctx, ...report } = await runPreflight(target, resolved, { client: createClient() });
  printJson(report);
  if (!report.ok) process.exitCode = 1;
}

function failedChecks(report) {
  return report.checks.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`).join('; ');
}

async function planNew(cwd, flags) {
  const { draft, target, resolved: draftOps } = readDraft(cwd, flags);
  let resolved = draftOps;
  let risk = draft.risk;
  validateOpTargets(resolved, target);
  validatePlanOps(resolved, target);
  // Zone plans run preflight only for product ops; without them they stay as in 0.2.x.
  let report = null;
  if (target.scope === 'account' || hasProductOps(target, resolved)) {
    const client = createClient();
    // R2 bucket deletes are refused unless the bucket is verifiably empty.
    if (target.scope === 'account' && hasR2Delete(resolved)) await assertR2DeletesEmpty(client, { account_id: draft.account_id, ops: resolved });
    // Preflight embeds source_hash into source-uploading ops.
    report = await runPreflight(target, resolved, { client });
    if (!report.ok) {
      throw new CfError('preflight_failed', `Preflight failed: ${failedChecks(report)}`, {
        hint: 'Run claudeflare preflight --file <draft.json> for the full report, fix the cause and try again',
      });
    }
    if (target.scope === 'account') resolved = report.ops;
    const pending = migrationRisk(report.pending_migrations);
    if (pending) risk = `${risk ?? ''}${risk ? ' ' : ''}${pending}`;
  }
  // Lockout lines never refuse a plan; they are stored and shown in the risk.
  const lockout = report?.lockout_risks;
  const slug = slugify(draft.slug ?? '') || 'plan';
  const plan = createPlan(cwd, {
    scope: target.scope,
    zone_id: draft.zone_id,
    zone_name: draft.zone_name,
    account_id: draft.account_id,
    account_name: draft.account_name,
    project_dir: target.project_dir,
    summary: draft.summary,
    risk: [withIrreversibleRisk(risk, resolved, target, report?.ctx), ...(lockout ?? [])].filter(Boolean).join('\n'),
    ops: target.scope === 'account' ? resolved : draft.ops,
    slug,
    // Inside the approval hash from creation (hashPlan).
    ...(lockout ? { lockout_risks: lockout } : {}),
  });
  return updatePlan(cwd, plan.id, { slug });
}

// Rollback plans get their lockout lines now; apply does not re-run them.
// The client is created first, so a missing token writes no rollback plan.
async function rollback(cwd, positional) {
  const id = arg(positional, 1, 'id');
  const client = hasProductOps(readPlan(cwd, id)) ? createClient() : null;
  const created = createRollbackPlan(cwd, id);
  return client && hasProductOps(created) ? addRollbackLockout(cwd, created, client) : created;
}

function tail(cwd, flags) {
  return runTail({
    cwd,
    worker: flag(flags, 'worker'),
    seconds: flag(flags, 'seconds'),
    status: flags.status?.at(-1),
    accountId: flags.account?.at(-1) ?? process.env.CLOUDFLARE_ACCOUNT_ID,
  });
}

// Writes the tunnel token into an env file; prints the path, never the value.
function tunnelToken(cwd, flags) {
  return runTunnelToken(cwd, {
    account: flag(flags, 'account'),
    tunnel: flag(flags, 'tunnel'),
    envFile: flag(flags, 'env-path'),
    variable: flags.var?.at(-1) ?? DEFAULT_VARIABLE,
  });
}

async function plan(cwd, positional, flags) {
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
  const result = await applyPlan(cwd, createClient(), arg(positional, 1, 'id'), new Date(), {});
  printJson(result);
  // Advisory lockout lines first found at apply did not stop it (Ruling 27);
  // one plain line each on stderr so the user sees them. An error, if any,
  // stays the last stderr line.
  for (const line of result.advisory_lockout ?? []) process.stderr.write(`${line}\n`);
  if (result.status !== 'applied') {
    const { code, message, hint } = applyFailure(result);
    throw new CfError(code, message, { hint });
  }
}

async function main(argv) {
  const cwd = process.cwd();
  const { positional, flags } = parseArgs(argv);
  const command = positional[0];
  switch (command) {
    case 'init': return printJson(init(cwd));
    case 'get': return printJson(await get(positional, flags));
    case 'plan': return printJson(await plan(cwd, positional, flags));
    case 'snapshot': return printJson(await snapshot(cwd, positional));
    case 'apply': return applyCommand(cwd, positional);
    case 'rollback': return printJson(await rollback(cwd, positional));
    case 'report': return printJson(report(cwd, flags));
    case 'preflight': return preflight(cwd, flags);
    case 'tail': return printJson(await tail(cwd, flags));
    case 'tunnel-token': return printJson(await tunnelToken(cwd, flags));
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
