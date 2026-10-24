---
description: Audit performance, cache and SSL for a zone and propose one plan with the best fixes.
argument-hint: "[zone]"
---

Optimize the Cloudflare zone `$ARGUMENTS`.

Load `cf-core` and `cf-audit`. Run the cf-audit flow for only the `performance`, `cache` and `ssl` domains (if no zone was given above, list the zones and ask which one), write the report with `claudeflare report`, and summarize it.

Then propose one plan through the cf-core change protocol that contains the fixes with the best impact for their risk, limited to findings with a non-empty `fix` that the zone's plan tier supports. If cf-core's plan limits force a split, say so and present the first plan only. Show the before and after table and the risk, then ask the user to type `/claudeflare:approve <plan-id>`. List the remaining findings as follow-ups.
