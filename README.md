# claudeflare

A Claude Code plugin that turns Claude into a senior Cloudflare engineer. It audits a zone or a developer platform account in depth, proposes optimized settings, diagnoses failures from evidence, and changes your zone, Workers, Pages and storage only through a plan that you approve and can roll back.

- **Audit:** a scored, prioritized report across DNS, SSL/TLS, cache, performance, rules, WAF, and bots and rate limiting. Every finding has the current value, the recommended value, the reason and the risk.
- **Diagnose:** walks 520 to 526, 1xxx errors, redirect loops, cache misses, CORS and WAF false positives to a root cause backed by evidence.
- **Optimize:** proposes one plan with the fixes that have the best impact for their risk.
- **Developer platform:** reviews Workers, Pages, R2, D1, KV and Queues, diagnoses Worker errors (1101, 1102, 1042, missing bindings, deploy and Pages build failures) with `claudeflare tail` and analytics, and deploys, rolls back, migrates and manages secrets through the same approved plans, with health checks and automatic rollback.
- **Change safely:** every write is planned, approved by you, snapshotted, applied, verified and reversible.

claudeflare never runs commands on your origin server. Origin-side fixes (nginx, certificates, firewall) come as step-by-step instructions.

## Requirements

- Claude Code with plugin support
- Node.js 18 or later
- A Cloudflare account. An API token is needed only to apply changes.
- For Workers, Pages and storage changes: wrangler 4 as a dependency of your project (`npm i -D wrangler@4`). claudeflare runs that local copy, never a global wrangler or `npx`.

## Install

In Claude Code, run:

```
/plugin marketplace add denizbarish/claudeflare
/plugin install claudeflare@claudeflare
```

Then run `/claudeflare:setup` in your project. It checks the MCP connection and the API token, creates the local state directory and shows the token template.

## Connect the Cloudflare MCP server (read-only)

claudeflare reads your account through the official Cloudflare MCP server at `https://mcp.cloudflare.com/mcp`. The plugin declares it as the `cloudflare` server.

1. In Claude Code, run `/mcp`, select `cloudflare`, then sign in.
2. On the Cloudflare consent screen, grant **read-only** scopes only.

Read-only OAuth scopes are the hard guarantee that nothing writes through MCP. The plugin's guard hook is a second layer, not a replacement.

## Set up the API token (for changes)

All writes go through `claudeflare apply`, which uses `CLOUDFLARE_API_TOKEN` from your environment. Audits and diagnosis through MCP need no token. Export a write token only for the session where you apply changes (see the threat model below).

1. Create a custom token with the permissions in [docs/token-template.md](docs/token-template.md). Use the read set if you only want the `claudeflare get` fallback; use the write set to apply changes. Add the developer platform sets if you work with Workers, Pages or storage.
2. Export it in your shell profile and restart Claude Code:

   ```sh
   export CLOUDFLARE_API_TOKEN="<your token>"
   ```

Never paste the token into the chat. claudeflare reads it only from the environment and never writes it to disk or prints it. The same goes for Worker secrets: claudeflare asks you to export a secret under its own name (for example `export STRIPE_KEY=...`) in the shell that runs `claudeflare apply`, passes it to wrangler on stdin and redacts it from all output. wrangler only ever receives `CLOUDFLARE_API_TOKEN`; a Global API Key in your environment is never passed on.

## Commands

| Command | What it does |
|---|---|
| `/claudeflare:setup` | Checks the MCP connection and token, runs `claudeflare init`, shows the token template |
| `/claudeflare:audit [zone]` | Scored audit of all domains, or of an account's Workers, Pages and storage; writes a report under `.claudeflare/reports/<zone>/` |
| `/claudeflare:diagnose [symptom]` | Evidence-driven diagnosis of an error or misbehavior, including Worker and Pages errors |
| `/claudeflare:optimize [zone]` | Audits performance, cache and SSL, then proposes one plan |
| `/claudeflare:approve <plan-id>` | Approves a draft plan. Only you can type this. |
| `/claudeflare:rollback <plan-id>` | Creates a reversal plan for an applied plan |

You can also just describe the task. The `cloudflare` agent and the `cf-*` skills load on their own.

The plugin adds a `claudeflare` executable to the Bash tool's PATH. Claude uses it; you rarely need it directly:

```
claudeflare init | get <path> [--query k=v ...] | preflight --file <draft.json> | plan new --file <draft.json> | plan show <id> | plan list | snapshot <id> | apply <id> | rollback <id> | report --file <findings.json> --zone <zone> | tail --worker <name> --seconds <n> [--status error] [--account <id>]
```

`claudeflare preflight` checks an account draft before planning (ops, wrangler 4, account access, wrangler config and bindings, a dry-run build, pending D1 migrations, the source hash) and prints a JSON report. `claudeflare tail` runs `wrangler tail` for at most 60 seconds and prints a summary (outcome counts, top exceptions, samples) with secret-looking values redacted. `claudeflare report` writes the Markdown report and prints JSON: `{ "file", "overall", "domains" }`. In an audit, each domain auditor also returns the checks it could not read (`unread`); such a domain is re-run once, then listed as not audited instead of being scored.

Local state lives in `.claudeflare/` in your project (`plans/`, `approvals/`, `snapshots/<zone>/`, `reports/<zone>/`). `claudeflare init` adds it to `.gitignore`.

## Safety model

### Change protocol

Every write follows the same steps:

1. **Plan.** Claude reads the current state and creates a draft plan with `claudeflare plan new`. You see the plan id, a before and after table, the risk and anything that cannot be rolled back.
2. **Approve.** You type `/claudeflare:approve <plan-id>` yourself. A hook records a signed approval from your prompt; model output does not trigger it. See [Threat model](#threat-model) for its limits.
3. **Confirm.** Claude runs `claudeflare apply <plan-id>`. The guard hook checks the approval and shows a native permission prompt that lists every op. You confirm there.
4. **Snapshot.** Before the first write, `claudeflare apply` captures the current state of every resource the plan touches.
5. **Apply.** Ops run in order. Apply stops at the first failure and records which ops succeeded.
6. **Verify.** Claude re-reads the changed resources and checks live behavior where useful.

`/claudeflare:rollback <plan-id>` builds a reversal plan from the snapshot. It changes nothing on its own: the rollback plan needs its own approval and confirmation.

Approvals:

- HMAC-signed with a local key at `~/.config/claudeflare/approval.key` (override the directory with `CLAUDEFLARE_KEY_DIR`).
- Bound to the plan's ops hash, so an edited plan is no longer approved.
- Valid only for draft plans, single-use, and expire after 30 minutes (`CLAUDEFLARE_APPROVAL_TTL`, in seconds).

Apply works only in interactive sessions. The confirmation is a hook `ask` decision. In a headless run (`claude -p`), there is nobody to answer, so `ask` acts as a deny. This was verified on Claude Code 2.1.306: in interactive mode the prompt appears even in bypass permissions mode (`--dangerously-skip-permissions`), and in headless mode the call is denied in both bypass and default modes. Details are in [the harness spike notes](docs/superpowers/notes/2026-10-24-harness-spike.md).

Ops that rollback cannot undo are flagged in the plan's risk note before you approve: cache purge, and any op outside the snapshot-supported kinds (for example DNSSEC, Tiered Cache and Bot Fight Mode). Supported, reversible kinds are zone settings, DNS records, ruleset rules and phase entrypoints.

`claudeflare plan new` also rejects ops it cannot keep inside the plan's zone: account-level writes, paths outside `/zones/<zone_id>/`, leftover placeholders and Page Rule creation are refused with `invalid_op`.

#### Account plans (developer platform)

Workers, Pages and storage changes use account plans whose ops are wrangler commands from a fixed allowlist (`deploy`, `versions deploy`, `rollback`, `delete`, `pages deploy`, `d1 migrations apply --remote`, `d1 time-travel restore`, create and delete for D1, R2, KV and Queues, `secret put` and `secret delete`), plus the Pages rollback REST call. On top of the steps above:

- **Preflight.** `claudeflare plan new` runs `claudeflare preflight` first and refuses a failing draft. The dry-run build runs your project's own build locally (as `npm run build` would), before any approval.
- **Code binding.** The plan stores a hash of the project source plus the deploy inputs (wrangler config, entry point, assets and Pages directories, D1 migrations), even gitignored build output. The approval binds to it: if the code changes before apply, apply refuses with `source_changed`. Pending D1 migrations are stored in the plan with their SQL.
- **Explicit targets.** Every Worker op names `--name`; every delete names the resource again in `confirm_name`. R2 bucket deletes are refused unless the bucket is empty; KV, Queue and D1 deletes carry a data-loss line in the risk.
- **Health check.** A deploy op can carry an https health check (3 tries, 5 seconds apart). With `on_failed_check: "rollback"` a failed check reverts the deploy at once (`rolled_back_auto`); otherwise the plan ends `applied_check_failed`.
- **Rollback.** Snapshots record the previous Worker version, the Pages production deployment and a D1 Time Travel bookmark. Rollback redeploys the previous version, rolls Pages back, or restores the bookmark (writes after it are lost). Resources a plan created are deleted only when verifiably empty; Queue and D1 creates are never deleted automatically. Deletes and secret changes cannot be rolled back, and a Worker rollback never rolls back bindings or data.

Limits of the code binding: files outside the tracked source and the deploy inputs that a build pulls in (for example generated files imported from a gitignored folder) and the contents behind a symlinked assets directory are not hashed.

Plan limits keep snapshots and rollbacks correct. One plan may not touch the same DNS record twice, touch the same rule twice, delete more than one rule in the same ruleset, or PUT the same phase entrypoint twice. Claude splits such work into several plans.

### Guard hook

A `PreToolUse` hook (`hooks/guard.mjs`) inspects tool calls:

- **MCP `execute`:** allowed only when the code is the canonical read form: an async wrapper with at least one literal `cloudflare.request` call, where every call uses `method: "GET"`, or `"POST"` to `/client/v4/graphql` for analytics. Any other code, including code with no call, is denied.

  ```js
  async () => {
    const zones = await cloudflare.request({ method: "GET", path: "/zones", query: { name: "example.com" } });
    return zones.result;
  }
  ```

- **Bash:** denies `curl` writes to `api.cloudflare.com` (a non-GET method or a request body). Denies direct wrangler runs unless the subcommand is a read or local command on an allowlist (`whoami`, `deployments list`, `versions list`, `tail`, `d1 migrations list`, `dev`, `types` and similar), behind any runner (`npx`, `pnpm`, `yarn`, `bunx`, `npm exec`, a `node` path) and inside `package.json` scripts run with `npm run`, `pnpm`, `yarn` or `bun`. Turns a literal `claudeflare apply <id>` into a deny without a valid approval, or into the native confirmation prompt with one. These are string checks; see the threat model for their limits.
- **State protection:** denies the agent's Write and Edit tools inside `.claudeflare/` and the key directory, denies Read, Grep and Glob on the key directory, and denies shell commands that mention `.claudeflare/` plans, approvals or snapshots, the key directory or key file, or `approvals.mjs` and `approval-key.mjs`.

### Threat model

claudeflare protects against model mistakes: a write sent the wrong way, an approval the model invents, a plan changed after approval, a stale approval reused later.

It does not protect against deliberate evasion:

- **A deliberately adversarial process running as your OS user.** Such a process can read the approval key and write approval files directly. claudeflare is not a sandbox.
- **A model that tries to get around the Bash checks**, for example after a prompt injection. The Bash checks recognize only `curl` writes to `api.cloudflare.com`, wrangler invocations they can parse, and a literal `claudeflare apply`. A wrangler call hidden in a script file, fed its arguments through stdin (`xargs`), or started by a tool that runs commands on its own (`git` aliases, `rg --pre`) is not caught. Any other HTTP client in Bash (for example `node -e` with `fetch`, or `wget`) can send writes with `CLOUDFLARE_API_TOKEN` from the environment. A command built at run time (such as `$(echo claudeflare) apply`) skips the confirmation prompt, and a shell glob can name the key file without the literal path. The Bash and state checks are string matches that catch mistakes, not evasion. This is the same limit as above: the agent's shell runs as your OS user.
- **Every non-user prompt.** `UserPromptSubmit` can also fire for some harness-delivered messages, not only for what you type. The approval hook records only a prompt that is exactly `/claudeflare:approve <id>`.
- **Code the static check cannot judge.** The `execute` check is a strict allowlist, but it is defense in depth. Read-only MCP scopes are the guarantee.

What you can do:

- Connect the Cloudflare MCP server with read-only scopes.
- Keep a read-only token (the read set in [docs/token-template.md](docs/token-template.md)) in your environment for audits and diagnosis.
- Export the write token only in the shell session where you intend to apply changes, start Claude Code from that session, and unset the token afterwards.

Planned hardening: store the approval key in the OS keychain, and supply a separate write token only at apply time.

Preflight runs your project's build before approval with your environment (minus Cloudflare credentials other than the token passed to wrangler). Treat a project you do not trust like any other code you would build.

Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## Example sessions

These transcripts are shortened illustrations.

### Audit

```
> /claudeflare:audit example.com

Overall score: 83/100
dns 92 | ssl 50 | cache 82 | performance 88 | rules 100 | waf 76 | bots-ratelimit 90

Top findings
1. critical  ssl.mode.flexible     SSL mode is Flexible; Cloudflare talks to your origin over HTTP.
             Recommended: Full (strict). Risk: 526 if the origin certificate is invalid.
2. high      waf.managed.off       Cloudflare Managed Ruleset is not deployed.
3. medium    cache.tiered.off      Tiered Cache is off.

Report: .claudeflare/reports/example.com/20261024-101500-audit.md
Tell me which findings to fix and I will prepare a plan.
```

### Diagnose a 522

```
> /claudeflare:diagnose example.com shows error 522 since this morning

Evidence
- curl -sI https://example.com/ -> HTTP 522, server: cloudflare, cf-ray present
- Origin 203.0.113.10:443 answers 200 directly (your curl with --resolve)
- Audit log: no zone change in the last 24 hours
Root cause: Cloudflare cannot complete the TCP connection to the origin. The origin
firewall most likely drops Cloudflare IP ranges.
Fix (on your server, I will not run it): allow https://www.cloudflare.com/ips/ on ports 80 and 443.
```

### Deploy a Worker

```
> deploy the api worker in this folder

Preflight: ok (wrangler 4.152.0, bindings exist, build 41.2 KiB / gzip 9.8 KiB)
Plan acme-20261026-101500-deploy-api
| Worker | Current version | After apply |
| api    | 2222...  (100%) | new version (100%), health check https://api.example.com/health |
Risk: the new version takes all traffic; bindings and data are not rolled back.
To approve, type /claudeflare:approve acme-20261026-101500-deploy-api

> /claudeflare:approve acme-20261026-101500-deploy-api
(native prompt: Apply plan ... Ops: wrangler deploy --name api) -> Yes
Applied: version 4444... at 100%, health check 200 on the first try.
```

### Rollback

```
> /claudeflare:rollback examplecom-20261024-102000-ssl-strict

Rollback plan examplecom-20261024-103500-rollback-ssl-strict
| Resource      | Current | After rollback |
| settings/ssl  | strict  | flexible       |
To approve, type /claudeflare:approve examplecom-20261024-103500-rollback-ssl-strict

> /claudeflare:approve examplecom-20261024-103500-rollback-ssl-strict
(native prompt: Apply plan ... Ops: PATCH /zones/.../settings/ssl) -> Yes
Applied and verified: SSL mode is flexible again.
```

## Evals

Behavior evals live in `evals/` and run with `claude plugin eval`. The seven cases cover the Flexible SSL audit, the 522 diagnosis, no MCP writes, no apply without approval, a 1102 Worker diagnosis, a deploy request that must follow the protocol, and a pasted secret that must never be repeated. Cloudflare is mocked; no account is used.

Run them locally from the repo root (needs Claude Code and an Anthropic API key or login):

```sh
claude plugin eval --trust-plugin --scaffold \
  --allow-tools "Bash(claudeflare *)" Write \
  --model claude-opus-5-5 --judge-model claude-opus-5-5 \
  --threshold 0.8 --max-cost-usd 15 --no-publish --json eval-results.json
```

A run costs about $3 to $12, depending mostly on the judge model. `--max-cost-usd` is checked before each run starts, so runs already in flight can push the total past it.

Known harness limitation: the plugin's `bin/` is not on PATH inside eval runs, so `claudeflare` calls there fail with exit code 127. The guard graders still count the attempts.

In CI (`.github/workflows/ci.yml`), unit tests run on every push. The evals job runs only on `pull_request` and `workflow_dispatch`, and only when the `ANTHROPIC_API_KEY` secret is set. Because pull requests can trigger paid runs, put the evals job behind a protected GitHub environment with required reviewers.

## Roadmap

- **v2, developer platform (0.2.0):** Workers, Pages, R2, D1, KV, Queues and Durable Objects bindings, with wrangler 4 integration. Next: `versions upload` for gradual rollouts inside claudeflare, and health checks pinned to the new version.
- **v3, Zero Trust and network:** Access, Tunnel, Gateway, WARP, Load Balancing and Spectrum.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## Privacy

claudeflare collects no data. See [PRIVACY.md](PRIVACY.md).

## License

[MIT](LICENSE)
