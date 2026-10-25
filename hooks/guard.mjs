#!/usr/bin/env node
// PreToolUse hook: keeps Cloudflare writes inside the change protocol and keeps
// the model away from approval state. Prints one decision or nothing (no
// decision, normal permissions apply). Never fails open on a call it inspects.
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { checkApproval } from '../scripts/lib/approvals.mjs';
import { keyDir } from '../scripts/lib/approval-key.mjs';
import { readPlan } from '../scripts/lib/plans.mjs';
import { inspectCode } from './lib/inspect-code.mjs';
import { isAllowedCall } from './lib/allowed-call.mjs';
import { trimPeriod } from './lib/plan-text.mjs';

const PROTOCOL_REASON =
  'Writes are not allowed through MCP. Create a plan with "claudeflare plan new" and follow the change protocol (skills/cf-core).';
const CANONICAL_REASON =
  'This execute code is not in the canonical read form. Use the async wrapper with literal method "GET" and literal path, as in skills/cf-core section 3.';
const STATE_REASON = 'claudeflare state files are managed by the claudeflare CLI and hooks only.';

const MCP_EXECUTE = /^mcp__.*cloudflare.*__execute$/;
const FILE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const APPLY_PATTERN = /(^|[\s;&|(])(claudeflare|node\s+\S*cf\.mjs)\s+apply\s+([a-z0-9-]+)/g;
const PROTECTED_COMMAND_PARTS = [
  '.claudeflare/approvals',
  '.claudeflare/plans',
  '.claudeflare/snapshots',
  'approval.key',
  '.config/claudeflare',
  'approvals.mjs',
  'approval-key.mjs',
];
const CF_API_HOST = 'api.cloudflare.com';
const CURL_METHOD = /(?:^|\s)(?:-[A-Za-z]*X\s*|--request(?:\s+|=))['"]?([A-Za-z]+)/g;
const CURL_BODY = /(?:^|\s)(?:-[A-Za-z]*[dFT]|--data|--json|--form|--upload-file)/;
const ASK_OPS_LIMIT = 20;
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';

const deny = (reason) => ({ permissionDecision: 'deny', permissionDecisionReason: reason });
const ask = (reason) => ({ permissionDecision: 'ask', permissionDecisionReason: reason });

// MCP execute

// A quoted write method anywhere in the code, read or not.
const WRITE_METHOD_LITERAL = /['"`](?:POST|PUT|PATCH|DELETE)['"`]/i;

// The reason only steers the model; the decision is the same deny either way.
function writeDetected(code, calls) {
  return calls.some((call) => !isAllowedCall(call) && call.method.toUpperCase() !== 'GET') ||
    WRITE_METHOD_LITERAL.test(code);
}

function decideExecute(toolInput) {
  if (typeof toolInput.code !== 'string') return deny(CANONICAL_REASON);
  const { calls, determinable } = inspectCode(toolInput.code);
  // Allowlist: code must make at least one readable call, and only allowed ones.
  if (determinable && calls.length > 0 && calls.every(isAllowedCall)) return null;
  return deny(writeDetected(toolInput.code, calls) ? PROTOCOL_REASON : CANONICAL_REASON);
}

// Approval state protection

// Resolves symlinks in the longest existing prefix so aliases (for example
// /tmp and /private/tmp) compare equal.
function canonicalPath(path) {
  let existing = path;
  const rest = [];
  while (!existsSync(existing) && dirname(existing) !== existing) {
    rest.unshift(basename(existing));
    existing = dirname(existing);
  }
  const real = join(realpathSync(existing), ...rest);
  return CASE_INSENSITIVE_FS ? real.toLowerCase() : real;
}

function isInside(root, target) {
  const rel = relative(canonicalPath(root), canonicalPath(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function toolTargets(toolInput, cwd) {
  return [toolInput.file_path, toolInput.notebook_path]
    .filter((p) => typeof p === 'string' && p !== '')
    .map((p) => resolve(cwd, p));
}

const inKeyDir = (target) => isInside(resolve(keyDir()), target);

// Any `.claudeflare` segment counts, whatever the session cwd is.
const inStateDir = (target) => canonicalPath(target).split(sep).includes('.claudeflare');

function decideFileTool(toolInput, cwd) {
  const hit = toolTargets(toolInput, cwd).some((target) => inStateDir(target) || inKeyDir(target));
  return hit ? deny(STATE_REASON) : null;
}

// Plans and snapshots stay readable; only the approval key is off limits.
function decideRead(toolInput, cwd) {
  return toolTargets(toolInput, cwd).some(inKeyDir) ? deny(STATE_REASON) : null;
}

// Static directory part of an absolute glob, e.g. /a/b for /a/b/**/*.key.
function globBase(pattern) {
  const parts = pattern.split(/[\\/]/);
  const firstGlob = parts.findIndex((part) => /[*?[{]/.test(part));
  return resolve(parts.slice(0, firstGlob < 0 ? parts.length : firstGlob).join(sep) || sep);
}

// Grep/Glob: deny when a search root (path, else cwd; plus the base of an
// absolute Glob pattern) is the key dir or inside it. A root that only
// contains the key dir (for example $HOME) stays allowed.
function decideSearch(toolName, toolInput, cwd) {
  const hasPath = typeof toolInput.path === 'string' && toolInput.path !== '';
  const roots = [hasPath ? resolve(cwd, toolInput.path) : resolve(cwd)];
  if (toolName === 'Glob' && typeof toolInput.pattern === 'string' && isAbsolute(toolInput.pattern)) {
    roots.push(globBase(toolInput.pattern));
  }
  return roots.some(inKeyDir) ? deny(STATE_REASON) : null;
}

function touchesState(command) {
  return [...PROTECTED_COMMAND_PARTS, resolve(keyDir())].some((part) => command.includes(part));
}

// claudeflare apply

function describeOps(ops) {
  const list = Array.isArray(ops) ? ops : [];
  const shown = list.slice(0, ASK_OPS_LIMIT).map((op) => `${op.method} ${op.path}`).join('; ');
  const more = list.length > ASK_OPS_LIMIT ? ` (+${list.length - ASK_OPS_LIMIT} more)` : '';
  return `${shown}${more}`;
}

function decideApply(cwd, planId) {
  const askUser = `Ask the user to run /claudeflare:approve ${planId}`;
  try {
    const result = checkApproval(cwd, planId);
    if (!result.ok) return deny(`Plan ${planId} is not approved (${result.reason}). ${askUser}`);
    const plan = readPlan(cwd, planId);
    return ask(`Apply plan ${planId}: ${trimPeriod(plan.summary)}. Risk: ${trimPeriod(plan.risk)}. Ops: ${describeOps(plan.ops)}`);
  } catch (err) {
    return deny(`Plan ${planId} could not be verified (${err?.message ?? err}). ${askUser}`);
  }
}

function applyDecisions(cwd, command) {
  const ids = [...new Set([...command.matchAll(APPLY_PATTERN)].map((m) => m[3]))];
  return ids.map((id) => decideApply(cwd, id));
}

// curl to the Cloudflare API

function isApiWrite(command) {
  if (!command.toLowerCase().includes(CF_API_HOST)) return false;
  const methods = [...command.matchAll(CURL_METHOD)].map((m) => m[1].toUpperCase());
  return methods.some((m) => m !== 'GET') || CURL_BODY.test(command);
}

function decideBash(toolInput, cwd) {
  const command = typeof toolInput.command === 'string' ? toolInput.command : '';
  const decisions = [
    touchesState(command) ? deny(STATE_REASON) : null,
    ...applyDecisions(cwd, command),
    isApiWrite(command) ? deny(PROTOCOL_REASON) : null,
  ].filter(Boolean);
  if (decisions.length === 0) return null;
  // Any deny wins, so an ask for a valid apply never hides another part of the command.
  const denied = decisions.find((d) => d.permissionDecision === 'deny');
  return denied ?? ask(decisions.map((d) => d.permissionDecisionReason).join(' | '));
}

function decide(input) {
  const toolName = input.tool_name;
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  if (typeof toolName !== 'string') return null;
  if (MCP_EXECUTE.test(toolName)) return decideExecute(toolInput);
  if (FILE_TOOLS.has(toolName)) return decideFileTool(toolInput, cwd);
  if (toolName === 'Read') return decideRead(toolInput, cwd);
  if (toolName === 'Grep' || toolName === 'Glob') return decideSearch(toolName, toolInput, cwd);
  if (toolName === 'Bash') return decideBash(toolInput, cwd);
  return null;
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return;
  }
  if (!input || typeof input !== 'object') return;
  let decision;
  try {
    decision = decide(input);
  } catch (err) {
    decision = deny(`claudeflare guard could not evaluate this call (${err?.message ?? err}); denied.`);
  }
  if (!decision) return;
  process.stdout.write(`${JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', ...decision } })}\n`);
}

main();
