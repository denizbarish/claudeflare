---
description: Run a scored audit of a Cloudflare zone across all domains and write a report.
argument-hint: "[zone]"
---

Audit the Cloudflare zone `$ARGUMENTS`.

Load `cf-core` and `cf-audit`, then follow cf-audit from start to finish: pick the zone (if no zone was given above, list the zones and ask which one), run one `cf-auditor` per domain in parallel, merge and deduplicate findings, write the report with `claudeflare report`, and summarize the scores and top findings in the user's language.

The audit is read-only. Do not create plans until the user picks findings to fix.
