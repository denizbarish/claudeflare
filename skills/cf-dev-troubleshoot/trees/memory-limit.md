# Memory limit exceeded

Symptom: error 1102 "Worker exceeded resource limits" with outcome `exceededMemory` ("Exceeded Memory" in the dashboard), or the runtime error `Memory limit would be exceeded before EOF`. Each isolate may use up to 128 MB (JavaScript heap and WebAssembly), on every plan. An isolate serves many requests at once, so one heavy request can fail others.

## Evidence

1. Outcome and paths: `claudeflare tail --worker api --seconds 30 --status error`, `outcomes.exceededMemory` and the request URLs in `samples`.
2. Rate over time: GraphQL query from SKILL.md, `exceededResources` count (it includes CPU too; the tail outcome tells them apart). The dashboard Metrics tab shows memory usage percentiles (P50 to P999).
3. What changed: `wrangler deployments list --name api --json`; a new dependency or larger payloads.
4. The code paths in the samples: buffering bodies (`await response.text()`, `arrayBuffer()`, `json()` on large bodies), module-scope caches, arrays that grow per request, large libraries.

## Hypotheses

1. **Buffering a large body.** Confirm: failing requests carry or fetch large bodies (uploads, R2 objects, big API responses), or the error is `Memory limit would be exceeded before EOF`. Reject: payloads are small.
2. **Global state that grows.** Confirm: module-scope maps, caches or arrays filled per request; errors rise with traffic and uptime. Reject: no module-scope state.
3. **Heavy dependency or schema.** Confirm: a new or large library (Zod before 4.5.0 uses much more memory per schema), or large data bundled into the Worker. Reject: no such change.
4. **Regression in a new version.** Confirm: errors start at a deployment. Reject: they predate it.

## Fix

- Hypothesis 4: a rollback plan to the last good version (cf-core): `{ "kind": "wrangler", "args": ["rollback", "<version-id>", "--name", "api"] }`.
- Hypothesis 1: suggest streaming (`TransformStream`, pass `response.body` through) instead of buffering; store large data in R2, KV or D1.
- Hypothesis 2: suggest bounding or removing module-scope caches; use the Cache API or KV.
- Hypothesis 3: suggest upgrading Zod to 4.5.0 or later, lazy-loading or replacing the library, moving bundled data to KV, R2 or static assets.
- Profile with DevTools memory snapshots in `wrangler dev` to find the allocation.
- Workers Paid has the same 128 MB limit as Free, so upgrading does not help; the fix is in the code.
- Verify: no `exceededMemory` in the tail while the user repeats the heavy request.

## Sources

- https://developers.cloudflare.com/workers/platform/limits/#memory
- https://developers.cloudflare.com/support/troubleshooting/http-status-codes/cloudflare-1xxx-errors/error-1102/
- https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
- https://developers.cloudflare.com/workers/observability/dev-tools/memory-usage/
