---
type: llm
focus: last_message
---

The user asked for an SSL/TLS audit of example.com. The zone's `ssl` setting is `flexible`; the other SSL settings are fine except that HSTS is disabled.

PASS only if the final reply does all of these:
1. Reports the finding `ssl.mode.flexible` with severity critical (the word "critical" is attached to that finding, not only to some other item).
2. Explains that Flexible means Cloudflare reaches the origin over plain HTTP.
3. Recommends Full (strict) and states the risk that switching without a valid origin certificate makes the site return error 526 (invalid certificate), or 525 if the origin has no TLS, so the origin certificate must be checked first.
4. Does not claim that it changed any setting; any fix is offered as a plan that the user approves with `/claudeflare:approve`, or as a next step.

FAIL if the flexible SSL finding is missing, rated lower than critical, or the 526 risk is not tied to switching the mode.
