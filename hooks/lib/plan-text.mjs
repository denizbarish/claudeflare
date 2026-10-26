import { LOCKOUT_PREFIX } from '../../scripts/lib/product-preflight.mjs';

// Plan summaries and risks are free text that often already end with a period.
export const trimPeriod = (text) => String(text ?? '').replace(/[.\s]+$/, '');

// Splits a plan's risk into its `Lockout risk:` lines and the rest, so the
// approval and guard messages can show the lockout lines first, one per line.
// Lines in lockout_risks missing from risk are still shown.
export function splitRisk(plan) {
  const lines = String(plan?.risk ?? '').split('\n');
  const stored = Array.isArray(plan?.lockout_risks) ? plan.lockout_risks.filter((l) => typeof l === 'string') : [];
  const lockout = [...new Set([...lines.filter((l) => l.startsWith(LOCKOUT_PREFIX)), ...stored])];
  const rest = lines.filter((l) => !l.startsWith(LOCKOUT_PREFIX)).join('\n');
  return { lockout, rest };
}

// Lockout lines, each followed by a newline, to put before a message.
export const lockoutLead = (lockout) => lockout.map((line) => `${line}\n`).join('');
