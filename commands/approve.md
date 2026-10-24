---
description: Approve a claudeflare plan so it can be applied. Type it yourself; the agent cannot approve plans.
argument-hint: "<plan-id>"
---

The user typed `/claudeflare:approve $ARGUMENTS`.

The claudeflare approval hook has already handled this before you saw it: it either recorded the approval or refused it, and its message is in your context. Do not write, create or check approval files yourself; that is the hook's job.

1. Read the hook's message.
2. If it says the approval was recorded, run `claudeflare apply $ARGUMENTS`. The user then confirms the native permission prompt that lists the ops. After apply, follow cf-core: report the result and verify the changed resources.
3. If it refused the approval (no such plan, the plan is not a draft, or another error), tell the user why in their language and what to do next, for example create a new plan with `claudeflare plan new`. Do not run apply.
