# claudeflare: Design Spec

- Date: 2026-10-24
- Status: Draft, awaiting review
- License: MIT
- Repo: `denizbarish/claudeflare` (public release only after owner approval)

## 1. Goal

claudeflare is an open-source Claude Code plugin that turns Claude into a senior Cloudflare engineer. It audits a zone in depth, applies optimized settings down to the smallest detail, diagnoses failures from evidence, and intervenes safely. Every write is planned, snapshotted, approved by a human and reversible.

### Success criteria

1. `/claudeflare:audit` produces a scored, prioritized report for a zone with current value, recommended value, reason and risk for every finding.
2. Any finding can be fixed through the change protocol (section 6) with a snapshot and a working rollback.
3. `/claudeflare:diagnose` walks the common failures (520 to 526, 1xxx errors, redirect loops, cache misses, false WAF blocks) to a root cause backed by evidence.
4. No write reaches the Cloudflare API without a user approval that the model cannot forge.
5. Unit tests and plugin evals pass in CI without a real Cloudflare account.

### Non-goals (v1)

- Developer platform (Workers, Pages, R2, D1, KV, Queues, Durable Objects, wrangler). Planned for v2.
- Zero Trust and network (Access, Tunnel, Gateway, WARP, Load Balancing, Spectrum). Planned for v3.
- Touching the origin server. claudeflare gives origin-side instructions (nginx, certificates, firewall) but never runs commands on the origin.
- A standalone CLI or MCP server of our own.
- Docker. There is no running service; the plugin lives inside Claude Code. This is a documented exception to the dockerize-by-default policy.

## 2. Target users and assumptions

- Developers and agencies who run sites on Cloudflare and use Claude Code.
- Docs, code and prompts are in English. The agent answers in the user's language.
- Node.js 18 or newer is available (built-in `fetch`, `node:test`).

## 3. Verified platform facts (2026-10-24)

These facts shape the design. Sources are listed in section 13.

**Claude Code**
- Plugin layout: `.claude-plugin/plugin.json` (only `name` required), `skills/<name>/SKILL.md`, `commands/*.md`, `agents/*.md`, `hooks/hooks.json`, `.mcp.json`.
- A repo becomes a marketplace through `.claude-plugin/marketplace.json` (`name`, `owner`, `plugins[]` with `name` and `source`).
- Every component is namespaced by the plugin name. Commands are therefore `/claudeflare:<command>`; a shorter `/cf:` prefix would require renaming the plugin to `cf`.
- PreToolUse hooks return `hookSpecificOutput.permissionDecision` of `allow`, `deny` or `ask`, with `permissionDecisionReason`. Precedence: deny > defer > ask > allow.
- Hook stdin includes `tool_name`, `tool_input`, `cwd`, `permission_mode`, `session_id`.
- Plugin MCP tools are named `mcp__plugin_<plugin>_<server>__<tool>`; matchers are regex.
- `${CLAUDE_PLUGIN_ROOT}` resolves in hook commands and MCP config.
- `claude plugin eval` exists: `evals/<case>/prompt.md` plus `graders/*.md`; CI needs `--trust-plugin`.
- **Unverified:** whether a hook `ask` still shows a prompt in `bypassPermissions` mode. The approval design (section 6.3) does not depend on it.

**Cloudflare**
- One official MCP server covers the whole REST API: `https://mcp.cloudflare.com/mcp` ("Code Mode"). Tools: `search`, `execute`, `docs`. `execute` runs JS that calls `cloudflare.request({method, path, ...})`. GraphQL analytics also goes through `execute` with `POST /graphql`.
- Auth: OAuth by default (scopes chosen at connect time) or `Authorization: Bearer <token>`.
- Because every call is `execute`, read and write cannot be told apart by tool name. Parsing the JS for the HTTP method is best effort only.
- Code Mode truncates results at about 6k tokens unless `?truncateToolResult=false`.
- Rulesets phases: Cache Rules `http_request_cache_settings`, Single Redirects `http_request_dynamic_redirect`, URL rewrite `http_request_transform`, request headers `http_request_late_transform`, response headers `http_response_headers_transform`, Configuration Rules `http_config_settings`, Origin Rules `http_request_origin`, custom WAF `http_request_firewall_custom`, rate limiting `http_ratelimit`.
- Page Rules are deprecated. claudeflare reads them during audit and recommends migration but never creates new ones.
- Audit logs v2: `GET /accounts/{account_id}/logs/audit` (v1 still works, used as fallback).
- Zone settings: `PATCH /zones/{zone_id}/settings` (bulk) and `PATCH /zones/{zone_id}/settings/{setting_id}`.

## 4. Key architecture decision: read through MCP, write through the script

The approved approach was hybrid access. The facts in section 3 sharpen it into a strict split:

| Concern | Channel | Why |
|---|---|---|
| Discovery, reads, analytics, docs | Official MCP (`search`, `execute` with GET or GraphQL) | Full API coverage, no maintenance on our side, small context cost |
| Every write | `scripts/cf apply <plan-id>` | Deterministic snapshot, rollback and approval check; no reliance on parsing arbitrary JS |
| Reads when MCP is unavailable or for bulk work | `scripts/cf get ...` | Fallback with an API token |

Consequences:
- The guard hook **denies** any MCP `execute` call whose code contains a write method (`POST`, `PUT`, `PATCH`, `DELETE`) except `POST` to `/graphql`, and any call whose method cannot be determined. The deny reason tells the model to create a plan and use `cf apply`.
- README recommends connecting the MCP with **read-only OAuth scopes**. This is the hard guarantee; the hook is defense in depth.
- Writes need `CLOUDFLARE_API_TOKEN` with the edit permissions listed in the token template. Users who only audit and diagnose never need a write token.

## 5. Components

```
claudeflare/
  .claude-plugin/
    plugin.json
    marketplace.json
  .mcp.json                     official Cloudflare MCP (https://mcp.cloudflare.com/mcp)
  agents/
    cloudflare.md               orchestrating expert, entry point for all work
    cf-auditor.md               read-only, scans domains in parallel during audits
  skills/
    cf-core/                    account and zone discovery, channel choice, change protocol
    cf-dns/                     records, proxy status, DNSSEC, CNAME flattening, CAA
    cf-ssl/                     encryption mode (Full strict), HSTS, min TLS, edge and origin certs
    cf-cache/                   Cache Rules, TTLs, cache key, purge, Tiered Cache, Cache Reserve
    cf-performance/             HTTP/3, Brotli/Zstd, Early Hints, Polish, Argo, Speed settings
    cf-rules/                   Redirect, Transform, Origin, Configuration Rules, Page Rules migration
    cf-waf/                     managed rulesets, custom rules, skip rules, exceptions
    cf-bots-ratelimit/          Bot Fight Mode, Super Bot Fight Mode, rate limiting, Turnstile
    cf-incident/                live attack response and controlled return to normal
    cf-troubleshoot/            decision trees for 52x, 1xxx, redirect loops, cache miss, CORS, WAF false positives
    cf-audit/                   scored audit checklist and report format
  commands/
    setup.md                    /claudeflare:setup
    audit.md                    /claudeflare:audit
    diagnose.md                 /claudeflare:diagnose
    optimize.md                 /claudeflare:optimize
    approve.md                  /claudeflare:approve <plan-id>
    rollback.md                 /claudeflare:rollback <plan-id>
  hooks/
    hooks.json
    guard.mjs                   PreToolUse: blocks unapproved writes
    approve.mjs                 UserPromptSubmit: records human approval
  scripts/
    cf.mjs                      CLI entry: get, plan, apply, rollback, snapshot
    lib/                        api client, snapshot, inverse ops, plan store, errors
  evals/                        claude plugin eval suites
  test/                         node:test unit tests
  docs/
    token-template.md           least-privilege token permissions (read set, write set)
  README.md  CONTRIBUTING.md  SECURITY.md  CHANGELOG.md  LICENSE
```

### 5.1 Agents

- **cloudflare**: the persona. Knows the change protocol, loads at most the skills a task needs, never writes outside the protocol, answers in the user's language, states plan limits plainly.
- **cf-auditor**: read-only tools only (MCP reads, `cf get`, `curl`). Receives one domain (for example "cache") and returns findings in the shared finding format (section 7.1). The orchestrator runs several in parallel.

### 5.2 Skills

Each skill is self-contained: what to check, the optimal value per plan tier, how to read the current state, how to express the change as plan operations, and known traps. Skills load on demand so the base context stays small. Adding a v2 or v3 domain means adding skills, not changing the core.

### 5.3 Script (`scripts/cf.mjs`)

Zero dependencies, Node 18+. Subcommands:

- `cf get <path> [--query k=v]`: read, prints JSON.
- `cf plan new|show|list`: create and inspect plan files.
- `cf apply <plan-id>`: verifies approval token, takes snapshot, executes ops in order, verifies, records result.
- `cf rollback <plan-id>`: builds a rollback plan from the snapshot's inverse ops; it needs its own approval.
- `cf snapshot <plan-id>`: snapshot only (used by apply, also runnable alone).

The token is read only from `CLOUDFLARE_API_TOKEN` and never written to disk or printed.

### 5.4 Local state

All under `<project>/.claudeflare/`, added to `.gitignore` automatically by `/claudeflare:setup`:

```
.claudeflare/
  plans/<plan-id>.json
  approvals/<plan-id>.json      written only by approve.mjs
  snapshots/<zone>/<plan-id>.json
  reports/<zone>/<timestamp>-audit.md
```

## 6. Data flow

### 6.1 Audit

1. `cf-core` lists accounts and zones; the user picks a zone.
2. The orchestrator runs `cf-auditor` per domain in parallel: dns, ssl, cache, performance, rules, waf, bots-ratelimit.
3. Findings are merged, deduplicated and scored per domain (section 7.2).
4. The report is written to `.claudeflare/reports/` and summarized in chat.
5. If the user asks to fix findings, the selected ones become a plan (6.3).

### 6.2 Diagnose

1. Collect the symptom: error code, URL, start time, scope (all users or some).
2. Outside evidence: `curl -sI` headers (`cf-ray`, `cf-cache-status`, `server`), DNS resolution, TLS handshake, direct origin request if the user provides the origin IP.
3. Inside evidence: relevant zone settings and rules, audit log entries around the start time, firewall events and analytics through GraphQL.
4. `cf-troubleshoot` ranks hypotheses; each one is confirmed or rejected with evidence.
5. Output: root cause, evidence, fix. A Cloudflare-side fix becomes a plan. An origin-side fix is given as step-by-step instructions.

### 6.3 Change protocol (every write)

1. **Plan.** The agent runs `cf plan new` with operations (method, path, body), the target resources, a before/after diff and a risk note. Plan id: `<zone-short>-<yyyymmdd-hhmmss>-<slug>`. The plan file stores a SHA-256 hash of its operations.
2. **Present.** The agent shows the diff and risk in chat and asks the user to run `/claudeflare:approve <plan-id>`.
3. **Approve.** The user types `/claudeflare:approve <plan-id>`. The `UserPromptSubmit` hook `approve.mjs` matches the prompt, checks the plan exists, and writes `approvals/<plan-id>.json` with the plan hash, timestamp and session id. `UserPromptSubmit` only fires on real user input, so the model cannot create an approval. The approval expires after 30 minutes (configurable through `CLAUDEFLARE_APPROVAL_TTL`).
4. **Apply.** The agent runs `cf apply <plan-id>`. The guard hook checks that an approval exists, is not expired and matches the current plan hash; otherwise it denies. When allowed, the guard also returns `ask` with the plan summary, which adds the native Claude Code prompt in modes that show it. `cf apply` repeats the approval check itself, takes the snapshot, then executes operations in order.
5. **Partial failure.** On the first failed operation, apply stops, records which operations succeeded, and offers a rollback plan for them. It never continues silently.
6. **Verify.** Re-read the changed resources through the API and, where useful, check live behavior with `curl` (for example a redirect now returns 301 to the right target).
7. **Consume.** The approval is deleted after use. A second apply needs a new approval.
8. **Rollback.** `/claudeflare:rollback <plan-id>` creates a new plan from the snapshot's inverse operations and goes through steps 2 to 7.

### 6.4 Guard hook rules (`guard.mjs`)

| Tool call | Decision |
|---|---|
| MCP `search`, `docs`, `whoami` | allow |
| MCP `execute`, code has only GET or `POST` to `/graphql` | allow |
| MCP `execute`, code has a write method or method not determinable | deny, reason: use the change protocol |
| Bash `cf get`, `cf plan ...`, `cf snapshot` | allow |
| Bash `cf apply` / `cf rollback` with valid approval | ask (with plan summary) |
| Bash `cf apply` / `cf rollback` without valid approval | deny |
| Bash `curl` to `api.cloudflare.com` with a non-GET method | deny, reason: use the change protocol |
| Anything else | no decision (normal permissions apply) |

## 7. Formats

### 7.1 Finding

```json
{
  "id": "ssl.mode.flexible",
  "domain": "ssl",
  "severity": "critical",
  "title": "SSL mode is Flexible",
  "current": "flexible",
  "recommended": "strict",
  "reason": "Traffic between Cloudflare and origin is unencrypted.",
  "risk": "Origin must serve a valid certificate first, or the site returns 526.",
  "prerequisites": ["Origin certificate installed"],
  "plan_tier": "free",
  "fix": [{ "method": "PATCH", "path": "/zones/{zone_id}/settings/ssl", "body": { "value": "strict" } }]
}
```

### 7.2 Score

Per domain: start at 100, subtract 25 per critical, 10 per high, 4 per medium, 1 per low, floor at 0. Overall score is the average of domain scores. The report lists findings by severity, then by effort.

### 7.3 Plan

```json
{
  "id": "examplecom-20261024-143000-ssl-strict",
  "zone_id": "...",
  "zone_name": "example.com",
  "created_at": "2026-10-24T14:30:00Z",
  "summary": "Set SSL mode to Full (strict)",
  "risk": "526 if origin cert is invalid",
  "ops": [{ "method": "PATCH", "path": "/zones/{zone_id}/settings/ssl", "body": { "value": "strict" } }],
  "ops_hash": "sha256:...",
  "status": "draft | applied | partially_applied | failed | rolled_back"
}
```

### 7.4 Snapshot

The current state of every resource an operation touches, plus the inverse operations computed from it (for example restore the previous setting value, delete a newly created rule, recreate a deleted DNS record with its original fields). Operations that cannot be inverted (for example cache purge) are flagged in the plan's risk note before approval.

## 8. Error handling

| Case | Behavior |
|---|---|
| Missing permission (Cloudflare `9109`, `10000`) | Name the missing permission and point to the matching line in the token template. Do not guess or retry. |
| Feature needs a higher plan | Say so and offer the best alternative on the current plan. |
| 429 rate limit | Exponential backoff honoring `Retry-After`; bulk operations are queued. |
| MCP unavailable | Fall back to `cf get` if a token exists, otherwise guide through `/claudeflare:setup`. |
| Partial apply failure | Stop, record, offer rollback (6.3 step 5). |
| Snapshot read fails | Abort apply before any write. |
| Plan changed after approval | Hash mismatch, guard denies, new approval required. |

## 9. Testing

- **Unit (`node:test`, mocked `fetch`):** API client, error mapping, backoff, plan hashing, snapshot capture, inverse op generation for every supported resource type, rollback, partial failure.
- **Hooks:** fixture JSON inputs for `guard.mjs` and `approve.mjs` covering every row of the table in 6.4, expired approvals and hash mismatch.
- **Behavior (`claude plugin eval`):** at minimum: 522 diagnosis follows the evidence path; Flexible SSL audit produces a critical finding with the 526 risk; the agent never attempts an MCP write; the agent refuses to apply without approval.
- **Live:** optional, manual, against the user's own test zone. CI never uses a real account.
- **Spike before implementation:** confirm on the local machine whether a hook `ask` prompts in `bypassPermissions` mode and record the result in the README. The approval design works either way.
- **CI:** GitHub Actions runs unit and hook tests on Node 18 and the current LTS, plus `claude plugin validate`. Evals run where the CLI and credentials allow.

## 10. Release

- Install: `/plugin marketplace add denizbarish/claudeflare`, then `/plugin install claudeflare@claudeflare`.
- README: what it does, install, MCP connection with read-only scopes, token template, example sessions (audit, 522 diagnosis, rollback), safety model, roadmap.
- SECURITY.md: private vulnerability reporting through GitHub.
- CHANGELOG follows Keep a Changelog; versions follow SemVer, v1 ships as `0.1.0`.
- Pushing and making the repo public happen only after explicit owner approval.

## 11. Roadmap

- **v2 developer platform:** Workers, Pages, R2, D1, KV, Queues, Durable Objects; wrangler 4 integration; guard extended to `wrangler deploy` and `delete`.
- **v3 Zero Trust and network:** Access, Tunnel, Gateway, WARP, Load Balancing, Spectrum.

## 12. Open questions

None blocking. The `bypassPermissions` behavior is covered by the spike in section 9.

## 13. Sources

- https://code.claude.com/docs/en/plugins/manifest-reference.md
- https://code.claude.com/docs/en/plugins/create-marketplace.md
- https://code.claude.com/docs/en/hooks.md
- https://code.claude.com/docs/en/plugin-evals.md
- https://code.claude.com/docs/en/mcp.md
- https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/
- https://github.com/cloudflare/mcp
- https://developers.cloudflare.com/ruleset-engine/reference/phases-list/
- https://developers.cloudflare.com/rules/page-rules/
- https://developers.cloudflare.com/fundamentals/account/account-security/audit-logs/
- https://developers.cloudflare.com/api/resources/zones/subresources/settings/methods/bulk_edit/
