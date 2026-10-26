# Missing binding

Symptom: `env.DB`, `env.CACHE` or another binding is `undefined` at runtime (`TypeError: Cannot read properties of undefined`, often as error 1101), a binding works locally but not in production, or preflight or deploy fails because a bound resource does not exist.

## Evidence

1. The exception and the binding name: `claudeflare tail --worker api --seconds 30 --status error`, `top_exceptions`.
2. Bindings of the deployed Worker, as Cloudflare sees them:
   ```js
   async () => {
     const settings = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/workers/scripts/api/settings" });
     return settings.result.bindings;
   }
   ```
   Each binding has `name` and `type` (`d1`, `kv_namespace`, `r2_bucket`, `queue`, `durable_object_namespace`, `service`, `secret_text`, `plain_text` and others).
3. Bindings in the wrangler file: top level and the `env.<name>` block used for the deploy (`--env`). For Pages Functions, the project's `deployment_configs.production` and `.preview` (`/accounts/ACCOUNT_ID/pages/projects/<project>`).
4. Secrets by name: `wrangler secret list --name api --format json`.
5. The bound resources exist: cf-storage Read current state (D1 `uuid`, KV `id`, R2 bucket name, queue name, Durable Object namespace).
6. Preflight output if a plan was refused: the `bindings exist` check names the missing resource.

## Hypotheses

1. **Binding declared at the top level but not in the deployed environment.** Confirm: the deploy used `--env production` and the `env.production` block lacks the binding. `kv_namespaces`, `r2_buckets`, `queues`, `durable_objects`, `services` and `vars` are not inherited by environments. Reject: the environment declares it.
2. **Name mismatch.** Confirm: the code reads `env.DB` while the binding is named differently (case matters). Reject: names match.
3. **Resource deleted or wrong id.** Confirm: the KV `id`, D1 `database_id` or bucket name in the config is not in the account. Reject: the resource exists.
4. **Secret or variable missing in production.** Confirm: the name is in `.dev.vars` or `.env` locally but not in `wrangler secret list`. Reject: present.
5. **Pages project bindings not set for that environment.** Confirm: the binding exists in `production` but the failing deployment is a preview (or the reverse). Reject: both set.
6. **Deployed version predates the binding.** Confirm: the binding was added to the config after the active version (`wrangler deployments status --name api --json`), or a rollback went to an older version. Reject: the active version has it (step 2).

## Fix

- Hypotheses 1, 2, 3, 5 and 6: suggest the config change to the user (add the binding to the right `env` block, fix the name or id; the binding snippets are in cf-storage, Applying changes), then a deploy plan (cf-workers) or a Pages deploy plan (cf-pages). If the resource no longer exists, create it first in a plan (cf-storage).
- Hypothesis 4: a secret plan with `value_from_env` (cf-core 5.2.2); ask the user to export the variable in their shell, never to paste the value.
- Code side: suggest a startup guard that returns a clear error Response when a required binding is missing, and `wrangler types` to generate the `Env` type so names are checked at build time.
- Verify: the settings read lists the binding; the tail shows no exception during a repeat.

## Sources

- https://developers.cloudflare.com/workers/runtime-apis/bindings/
- https://developers.cloudflare.com/workers/wrangler/configuration/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/api/resources/workers/subresources/scripts/subresources/script_and_version_settings/methods/get/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
