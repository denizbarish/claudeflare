---
name: cf-audit
description: Scored Cloudflare zone audit. Defines the shared finding format and severity scale, runs one cf-auditor per domain in parallel, merges and deduplicates findings, and writes the report with claudeflare report. Use for audits, health checks, security or performance reviews of a zone, and whenever findings need the shared format.
---

# cf-audit: scored zone audit

Load `cf-core` first; it covers zone discovery and the change protocol. An audit is read-only. Nothing changes until the user picks findings to fix and approves a plan.

## 1. Pick the zone

Use cf-core discovery to get `zone_id`, `zone_name` and the plan tier (`plan.legacy_id`). If the user did not name a zone and more than one exists, ask. Run `claudeflare init` if this project has no `.claudeflare/` yet.

## 2. Domains

The full audit covers these domains, each checked against the skill with the same name:

| Domain | Checklist skill |
|---|---|
| dns | `cf-dns` |
| ssl | `cf-ssl` |
| cache | `cf-cache` |
| performance | `cf-performance` |
| rules | `cf-rules` |
| waf | `cf-waf` |
| bots-ratelimit | `cf-bots-ratelimit` |

A command may ask for a subset (for example performance, cache and ssl). Audit only domains whose skill folder exists next to this skill (`<plugin skills dir>/cf-<domain>/SKILL.md`). Tell the user which requested domains were skipped because their skill is missing.

## 3. Dispatch auditors in parallel

If the Agent tool is available, start one `cf-auditor` subagent per domain, all in the same message so they run in parallel. Give each one everything it needs, since it starts with no context:

```
Domain: <domain>
Zone name: <zone_name>
Zone id: <zone_id>
Account id: <account_id>
Plan tier: <free|pro|business|enterprise>
Checklist: <absolute path to skills/cf-<domain>/SKILL.md>
Return only a JSON array of findings in the cf-audit finding format.
```

The absolute checklist path is this skill's base directory with `cf-audit` replaced by `cf-<domain>`.

If the Agent tool is not available (for example you are running as a subagent), audit each domain yourself, one after another, following the same checklist and output rules.

## 4. Finding format

Every finding is one JSON object with exactly these fields:

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

| Field | Rule |
|---|---|
| `id` | Stable dotted id `<domain>.<area>.<problem>`, lowercase. The same problem always gets the same id, so audits can be compared and merged. |
| `domain` | One of the domains in section 2. |
| `severity` | `critical`, `high`, `medium` or `low` (section 5). |
| `title` | One short line stating the problem. |
| `current` / `recommended` | The observed value and the target value. Use a string, number, boolean or small object. |
| `reason` | Why it matters, one or two sentences, based on evidence you read. |
| `risk` | What the fix can break and how to avoid it. |
| `prerequisites` | Things that must be true before the fix (may be empty). |
| `plan_tier` | Lowest Cloudflare plan that supports the recommended fix: `free`, `pro`, `business` or `enterprise`. |
| `fix` | Plan ops `{ method, path, body? }` using `{zone_id}` in paths, ready for a plan draft. Use `[]` when the fix is origin-side, manual, or needs a higher plan than the zone has. Never a Page Rule create. |

Report only what you observed through reads. Do not invent values; if a read fails, say so in the summary instead of guessing.

## 5. Severity

- **critical**: outage, data exposure or open attack surface.
- **high**: significant security or performance loss.
- **medium**: best practice gap with measurable impact.
- **low**: polish.

Scores: each domain starts at 100 and loses 25 per critical, 10 per high, 4 per medium and 1 per low, with a floor of 0. The overall score is the rounded mean of domain scores. `claudeflare report` computes this; do not compute it by hand.

## 6. Merge and deduplicate

1. Parse each auditor result as a JSON array. If a result is not valid JSON or a finding misses fields, re-run that auditor once; if it fails again, list the domain as not audited.
2. Combine all findings. When two findings share an `id`, keep one: the higher severity wins; on a tie keep the first and merge their `prerequisites`.
3. Keep the list of domains you actually audited, including domains with zero findings (they score 100).

## 7. Write the report

Write the audit file with the Write tool to the system temp directory (never inside `.claudeflare/`), for example `/tmp/claudeflare-audit-example.com.json`:

```json
{ "domains": ["dns", "ssl", "cache"], "findings": [ ... ] }
```

Then run:

```
claudeflare report --file /tmp/claudeflare-audit-example.com.json --zone example.com
```

It prints the path of the Markdown report under `.claudeflare/reports/<zone>/`.

## 8. Summarize in chat

In the user's language:

- overall score and the score per domain,
- critical and high findings first, one line each (title, current, recommended),
- findings that need a higher plan, with the best option on the current plan,
- the report path,
- domains skipped or not audited, and why.

Then ask which findings to fix. Selected findings with a non-empty `fix` become plans through the cf-core change protocol. Group compatible fixes into one plan, and split where cf-core's plan limits require it (same DNS record or rule twice, more than one rule delete per ruleset, same phase entrypoint twice). Findings with an empty `fix` get step-by-step instructions instead.
