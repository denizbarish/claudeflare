#!/usr/bin/env node
// UserPromptSubmit hook: records an approval for a plan. The event fires on user
// prompts (and, per the Claude Code docs, on some harness-delivered messages), not
// on model output. Only a prompt that is exactly `/claudeflare:approve <id>` is
// recorded.
import { readFileSync } from 'node:fs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { readPlan } from '../scripts/lib/plans.mjs';
import { lockoutLead, splitRisk, trimPeriod } from './lib/plan-text.mjs';

const APPROVE_PATTERN = /^\s*\/claudeflare:approve\s+([a-z0-9-]+)\s*$/;
const HASH_PREVIEW_LENGTH = 12;

function readInput() {
  try {
    return JSON.parse(readFileSync(0, 'utf8'));
  } catch {
    return null;
  }
}

function errorCode(err) {
  return err && typeof err === 'object' ? err.code : undefined;
}

function approve(cwd, planId, sessionId) {
  let plan;
  try {
    plan = readPlan(cwd, planId);
  } catch (err) {
    if (errorCode(err) === 'plan_missing') return `No plan ${planId}; approval not recorded.`;
    return `Plan ${planId} could not be read (${err.message}); approval not recorded.`;
  }
  if (plan.status !== 'draft') {
    return `Plan ${planId} is ${plan.status}; only draft plans can be approved.`;
  }
  const approval = writeApproval(cwd, { plan_id: planId, session_id: sessionId });
  const opCount = Array.isArray(plan.ops) ? plan.ops.length : 0;
  const hashPreview = String(approval.ops_hash).replace(/^sha256:/, '').slice(0, HASH_PREVIEW_LENGTH);
  const { lockout, rest } = splitRisk(plan);
  return (
    `${lockoutLead(lockout)}Approval recorded for ${planId}. Run claudeflare apply ${planId}. ` +
    `Approved: ${trimPeriod(plan.summary)}. Risk: ${trimPeriod(rest)}. ${opCount} op${opCount === 1 ? '' : 's'}, ops hash ${hashPreview}.`
  );
}

function main() {
  const input = readInput();
  const match = typeof input?.prompt === 'string' ? APPROVE_PATTERN.exec(input.prompt) : null;
  if (!match) return;
  const cwd = typeof input.cwd === 'string' && input.cwd ? input.cwd : process.cwd();
  let message;
  try {
    message = approve(cwd, match[1], input.session_id ?? null);
  } catch (err) {
    message = `Approval for ${match[1]} was not recorded: ${err.message}`;
  }
  process.stdout.write(
    `${JSON.stringify({
      systemMessage: message,
      hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: message },
    })}\n`,
  );
}

main();
