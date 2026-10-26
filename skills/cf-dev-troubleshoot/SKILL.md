---
name: cf-dev-troubleshoot
description: Evidence-first diagnosis of Cloudflare Workers and Pages problems with one decision tree per symptom. Errors 1101 (Worker threw exception), 1102 (CPU or memory limit), 1042 (fetch to another Worker on the same zone), missing bindings, memory limit, failed Worker deploys (build, auth, size, startup) and failed Pages builds. Load it when a Worker or Pages Function returns an error, a deploy or Pages build fails, or a binding is undefined. Load cf-core first.
---

# cf-dev-troubleshoot: Workers and Pages diagnosis

Load `cf-core` first. This skill finds the root cause; config fixes live in cf-workers, cf-pages and cf-storage, and the trees point to their finding ids instead of repeating them. Zone-level errors (520 to 526, other 1xxx) belong to cf-troubleshoot.

## Method

1. **Symptom.** Collect the error code and page text, the URL or Worker name, the Pages project, when it started, and the scope (all requests or some paths, production or preview, one environment or all).
2. **Evidence.** Deployment history, a live tail sample and invocation analytics (commands below). For deploy and build failures, the failing command output or build log.
3. **What changed.** Match the start time against the deployments list (new version, who, when) and any config change (bindings, compatibility date or flags, secrets).
4. **Hypotheses.** Open the tree for the symptom and confirm or reject each hypothesis with the evidence it names. Check the cheap remaining ones even after one is confirmed.
5. **Result.** Root cause, evidence, fix, verification.

## Rules

- **Every conclusion cites evidence**: the command or read, and the exact value, exception message or log line it returned. Unconfirmed hypotheses are reported as unconfirmed.
- **Read only while diagnosing.** Reads: MCP `execute` (GET and GraphQL), `claudeflare get`, read-only wrangler, `claudeflare tail`. No direct wrangler writes; no deploy "to test".
- **Fixes are a plan or a code suggestion.** Cloudflare-side fixes go through the cf-core change protocol: a rollback op (`["rollback", "<version-id>", "--name", "<worker>"]`), a Pages rollback REST op, or a config deploy. Code fixes are suggested edits to the user's project, made only with the user's consent and then deployed through a plan.
- **No secrets in chat.** Never ask for a token or secret value; tail output from claudeflare is already redacted.

## Pick a tree

| Symptom | Tree |
|---|---|
| Error 1101, "Worker threw exception", "The script will never generate a response" | [trees/1101.md](trees/1101.md) |
| Error 1102, "Worker exceeded resource limits", `exceededCpu` | [trees/1102.md](trees/1102.md) |
| Error 1042, Worker `fetch()` to another Worker on the same zone fails | [trees/1042.md](trees/1042.md) |
| `env.X` is undefined, "Cannot read properties of undefined", binding errors at deploy | [trees/missing-binding.md](trees/missing-binding.md) |
| `exceededMemory`, "Memory limit would be exceeded before EOF" | [trees/memory-limit.md](trees/memory-limit.md) |
| `wrangler deploy` or a claudeflare deploy plan fails (build, auth, size, startup) | [trees/deploy-failed.md](trees/deploy-failed.md) |
| Pages build or deployment fails | [trees/pages-build-failed.md](trees/pages-build-failed.md) |

## Shared evidence

Replace `api` with the Worker name, `ACCOUNT_ID` with the real account id (cf-core discovery) and timestamps with a window around the start time (ISO 8601 UTC).

Deployment history (read-only wrangler, run in the project):

```
wrangler deployments list --name api --json
wrangler deployments status --name api --json
wrangler versions list --name api --json
wrangler versions view <version-id> --name api --json
```

The deployment created just before the start time is the first suspect. A split deployment (two versions with percentages) explains errors on only part of the traffic. Rollback can target only the 100 most recent versions.

Live logs, at most 60 seconds per run:

```
claudeflare tail --worker api --seconds 30 --status error
```

It returns `events`, `outcomes` (counts by outcome: `ok`, `exception`, `exceededCpu`, `exceededMemory`, `canceled`), `top_exceptions`, `samples` (status, exceptions, logs; secret-looking values redacted). Zero events means no traffic in the window, a wrong name, or the request never reached this Worker (route, Custom Domain or 1042). Ask the user to reproduce the request while the tail runs.

Errors and CPU time per status for one Worker (GraphQL; `status` values are `success`, `clientDisconnected`, `scriptThrewException`, `exceededResources`, `internalError`):

```js
async () => {
  const stats = await cloudflare.request({ method: "POST", path: "/client/v4/graphql", body: { query: `query ($accountTag: string, $scriptName: string, $since: string, $until: string) {
  viewer { accounts(filter: { accountTag: $accountTag }) {
    workersInvocationsAdaptive(limit: 100, filter: { scriptName: $scriptName, datetime_geq: $since, datetime_leq: $until }) {
      sum { requests errors subrequests }
      quantiles { cpuTimeP50 cpuTimeP99 }
      dimensions { scriptName status }
    }
  } }
}`, variables: { accountTag: "ACCOUNT_ID", scriptName: "api", since: "2026-10-24T06:00:00Z", until: "2026-10-24T12:00:00Z" } } });
  return stats;
}
```

Drop the `scriptName` filter to compare all Workers in the account; add `datetime` to `dimensions` for a timeline. GraphQL holds up to one month per query and data up to three months back. If a field is rejected, check the schema with the MCP `docs` or `search` tool instead of guessing; check the unit of the `cpuTime` quantiles there too before comparing them with the CPU limit. GraphQL needs MCP; without it, ask the user for the Worker's Metrics tab.

Configuration evidence: the project's wrangler file (`main`, `compatibility_date`, `compatibility_flags`, bindings per `env`), `wrangler secret list --name api --format json` (names only), and the Worker's bound resources from cf-storage (Read current state).

## Result format

Report in the user's language:

- **Root cause**: one sentence.
- **Evidence**: each command or read with the value it returned; rejected hypotheses with the evidence that rejected them.
- **Fix**: a plan (rollback, Pages rollback, config deploy) through cf-core, or numbered code changes for the user.
- **Verify**: the exact check, for example `claudeflare tail --worker api --seconds 30 --status error` shows zero events while the user repeats the request, or `scriptThrewException` drops to zero in the GraphQL query.

## Sources

- https://developers.cloudflare.com/workers/observability/errors/
- https://developers.cloudflare.com/workers/observability/metrics-and-analytics/
- https://developers.cloudflare.com/workers/observability/logs/real-time-logs/
- https://developers.cloudflare.com/analytics/graphql-api/tutorials/querying-workers-metrics/
- https://developers.cloudflare.com/workers/platform/limits/
- https://developers.cloudflare.com/workers/wrangler/commands/workers/
- https://developers.cloudflare.com/workers/configuration/versions-and-deployments/rollbacks/
- https://developers.cloudflare.com/logs/logpush/logpush-job/datasets/account/workers_trace_events/
