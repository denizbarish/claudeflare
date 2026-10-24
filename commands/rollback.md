---
description: Create a rollback plan for an applied claudeflare plan and take it through approval and apply.
argument-hint: "<plan-id>"
---

Roll back the claudeflare plan `$ARGUMENTS`.

Load `cf-core`. Run `claudeflare rollback $ARGUMENTS`. This creates a new draft rollback plan from the snapshot's inverse ops and changes nothing yet. If it fails (plan not applied, nothing to roll back), explain the error to the user.

Then follow the cf-core change protocol for the new rollback plan: present its ops as a before and after table with the risk, ask the user to type `/claudeflare:approve <rollback-plan-id>`, and after approval run `claudeflare apply <rollback-plan-id>` and verify.
