// The error the CLI prints when `claudeflare apply` ends in any status other
// than applied: { code, message, hint }.

const FRESH_PLAN = 'read the current state of every touched resource and create a fresh plan for what still differs';

const APPLY_HINTS = {
  partially_applied: (id, result) => (result.rollback_of
    // A rollback of this rollback would re-apply the original change, which
    // may be the lockout the user is recovering from (cf-core 5.7).
    ? `Inspect the drift: each skipped resource changed after the original apply. Do not roll back this rollback or retry it; ${FRESH_PLAN}`
    : `Run claudeflare rollback ${id} to revert the ops that succeeded`),
  failed: () => 'The first op failed; a REST op wrote nothing, but a failed wrangler op (timed-out deploy, d1 migrations apply) may have partly applied, so check the resource, fix the cause and create a new plan',
  applied_check_failed: (id) => `The health check failed and nothing was reverted; run claudeflare rollback ${id} to revert the applied ops`,
  rolled_back_auto: (id) => `The health check failed and the op was reverted automatically; inspect the plan and run claudeflare rollback ${id} for any earlier ops`,
  applied_verify_failed: (id, result) => (result.rollback_of
    ? 'Every op ran but verification failed and nothing was reverted; inspect the resources and create a fresh plan if needed'
    : `Verification failed and nothing was reverted; ${draftHint(id, result)}`),
};

function draftHint(id, result) {
  if (result.rollback_draft) return `review rollback draft ${result.rollback_draft} (claudeflare plan show ${result.rollback_draft}) and approve it to revert`;
  return `no rollback draft was created (${result.rollback_draft_error ?? 'unknown reason'}); run claudeflare rollback ${id} after fixing the cause`;
}

// "op <i> <check>: <detail>" for every failed verification check.
function failedVerifyChecks(result) {
  return (result.results ?? []).flatMap((r, i) => (r?.verify?.checks ?? [])
    .filter((c) => !c.ok)
    .map((c) => `op ${i} ${c.name}: ${c.detail}`));
}

// "op <i> skipped (<reason>): <detail>" for every op a drift precheck skipped.
function skippedOps(result) {
  return (result.results ?? []).flatMap((r, i) => (r?.skipped ? [`op ${i} skipped (${r.reason ?? 'skipped'}): ${r.detail ?? 'no detail'}`] : []));
}

export function applyFailure(result) {
  const failed = failedVerifyChecks(result);
  const skipped = skippedOps(result);
  const code = result.error?.code === 'check_failed' ? 'check_failed' : 'apply_failed';
  let hint = (APPLY_HINTS[result.status] ?? APPLY_HINTS.failed)(result.id, result);
  if (failed.length && result.status === 'partially_applied' && !result.rollback_of) hint = `${hint}; ${draftHint(result.id, result)}`;
  const results = result.results ?? [];
  const nothing = skipped.length > 0 && results.every((r) => r === null || r === undefined || r?.skipped);
  const why = [
    result.error?.message,
    ...(nothing ? ['nothing was applied'] : []),
    ...skipped,
    ...(failed.length ? [`verification failed: ${failed.join('; ')}`] : []),
  ].filter(Boolean).join('; ');
  return { code, message: `Plan ${result.id} ${result.status}: ${why}`, hint };
}
