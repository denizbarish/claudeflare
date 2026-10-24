---
description: Diagnose a Cloudflare problem (5xx, 1xxx, redirect loop, cache miss, CORS, WAF false positive) from a symptom.
argument-hint: "[symptom]"
---

Diagnose this Cloudflare problem: $ARGUMENTS

Load `cf-core`, and `cf-troubleshoot` if it exists. Then:

1. **Symptom.** Collect what is missing: error code, exact URL, when it started, and scope (all users or some). Ask only for what you cannot read yourself.
2. **Outside evidence.** `curl -sI` the URL (look at `cf-ray`, `cf-cache-status`, `server`, `location`), check DNS resolution and the TLS handshake. Request the origin directly only if the user gives you the origin IP.
3. **Inside evidence.** Through MCP GET and GraphQL: relevant zone settings and rules, audit log entries around the start time, firewall events and analytics.
4. **Hypotheses.** Rank them and confirm or reject each one with evidence. Do not stop at the first plausible one.
5. **Result.** Root cause, evidence, fix. A Cloudflare-side fix becomes a plan through the cf-core change protocol. An origin-side fix is step-by-step instructions for the user; never run commands on the origin.
