# Worker deploy failed

Symptom: a claudeflare deploy plan stops with `preflight_failed` or `wrangler_failed`, or the user's own `wrangler deploy` (CI or local) fails. Causes fall into build, auth, size or startup, config, and source changes.

## Evidence

1. The exact error: the failing check in `claudeflare preflight --file draft.json` (`checks[].name`, `detail`), the `wrangler_failed` message from apply, or the CI log the user shares. Quote the first error line, not the last.
2. Wrangler and auth (read-only):
   ```
   npx wrangler --version
   npx wrangler whoami --json
   ```
   `whoami` shows the account(s) the credentials reach. Compare with the plan `account_id` and `CLOUDFLARE_ACCOUNT_ID`.
3. Size: preflight reports `upload_size` from the dry-run build (`Total Upload` is the uncompressed size; the limit is 64 MiB uncompressed on Free and Paid; there is no compressed limit).
4. Config: the wrangler file for the target `env` (`main`, `compatibility_date`, bindings, `routes`, Durable Object `exports` or `migrations`).
5. Previous good deploy: `wrangler deployments list --name api --json`.

## Hypotheses

1. **Build error.** Confirm: the dry-run build fails (preflight check `dry-run build`), with a bundler error (unresolved import, TypeScript error, Node.js built-in without `nodejs_compat`). Reject: the dry-run build passes.
2. **Auth or account.** Confirm: `whoami` fails or lists a different account; preflight reports the token cannot read the account; `account_mismatch`; in CI, `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_ACCOUNT_ID` is missing, or the token lacks Workers edit permission (the "Edit Cloudflare Workers" template covers it). Reject: `whoami` shows the plan account and the token works for reads.
3. **Size limit.** Confirm: `upload_size` near or over 64 MiB uncompressed. Reject: well below.
4. **Startup time.** Confirm: `Script startup exceeded CPU time limit` (code `10021`): the global scope takes over 1 second to parse and run. Wrangler writes a CPU profile. Reject: no such error.
5. **Config or binding error.** Confirm: the error names a binding, route, Custom Domain, compatibility date or Durable Object class (for example a binding to a resource that does not exist, or a Durable Object lifecycle conflict). Reject: none named.
6. **Source changed after approval.** Confirm: `source_changed` from apply. Reject: other error.

## Fix

- Hypothesis 1: suggest the code or config fix to the user (add the missing dependency, fix the type error, add `nodejs_compat` to `compatibility_flags` when Node.js built-ins are used); rerun preflight.
- Hypothesis 2: the user creates or fixes the token (dashboard, API Tokens; template "Edit Cloudflare Workers") and exports `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` in their shell or CI secrets. Never ask for the token in chat. For `account_mismatch`, fix the plan `account_id` or the credentials, then draft again.
- Hypothesis 3: suggest removing unused dependencies, moving static files to Workers Static Assets or R2, or splitting into Workers joined by service bindings.
- Hypothesis 4: suggest moving work out of global scope (lazy init in the handler, precompute at build time); open the CPU profile wrangler wrote.
- Hypothesis 5: missing resources, see [missing-binding.md](missing-binding.md); Durable Object lifecycle errors: fix `exports` per the error's `suggestion` (cf-storage, Durable Objects traps).
- Hypothesis 6: review what changed in the project, then a fresh `/claudeflare:approve <plan-id>` (approval is kept, the plan is unchanged) or a new plan if the change is intended.
- After a partly applied deploy (timeout), read `wrangler deployments status --name api --json` before planning again.
- Verify: preflight passes; apply ends `applied` and the `health_check` passes; `deployments status` shows the new version at 100%.

## Sources

- https://developers.cloudflare.com/workers/platform/limits/#worker-size
- https://developers.cloudflare.com/workers/platform/limits/#worker-startup-time
- https://developers.cloudflare.com/workers/wrangler/commands/general/#whoami
- https://developers.cloudflare.com/workers/wrangler/system-environment-variables/
- https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/
- https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/
