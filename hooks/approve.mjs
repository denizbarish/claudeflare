#!/usr/bin/env node
// UserPromptSubmit hook: records a human approval for a plan. This event fires on
// real user input, so the model cannot create an approval by itself.
import { readFileSync } from 'node:fs';
import { writeApproval } from '../scripts/lib/approvals.mjs';
import { readPlan } from '../scripts/lib/plans.mjs';

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
  return (
    `Approval recorded for ${planId}. Run claudeflare apply ${planId}. ` +
    `Approved: ${plan.summary}. Risk: ${plan.risk}. ${opCount} op${opCount === 1 ? '' : 's'}, ops hash ${hashPreview}.`
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
