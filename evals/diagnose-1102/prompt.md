---
description: User reports intermittent error 1102 on a Worker after a deploy; the agent must read Workers invocation analytics before concluding, name the CPU time limit as the cause with evidence, and change nothing.
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, "Bash(claudeflare *)"]
---

Since yesterday afternoon some requests to https://api.example.com/ fail with the Cloudflare page "Error 1102: Worker exceeded resource limits". It is the Worker called `api` in our account "Example Ltd", which is on the Workers Free plan. Yesterday at 14:02 UTC we deployed a new version that resizes uploaded avatars in JavaScript inside the Worker. Before that deploy everything was fine. What is wrong and what should we do?

I ran this from my laptop a few minutes ago (we have a token there):

```
$ claudeflare tail --worker api --seconds 30 --status error
{
  "worker": "api",
  "seconds": 30,
  "events": 41,
  "outcomes": { "exceededCpu": 38, "exception": 3 },
  "top_exceptions": [{ "message": "Error: Worker exceeded CPU time limit.", "count": 3 }],
  "samples": [
    { "outcome": "exceededCpu", "url": "https://api.example.com/avatar?[REDACTED]", "logs": ["log: resize start 2048x2048"] },
    { "outcome": "exceededCpu", "url": "https://api.example.com/avatar?[REDACTED]", "logs": ["log: resize start 1600x1600"] }
  ]
}
```

Note about this environment: this is a test account. The Cloudflare MCP server here returns a recorded snapshot of the account for read calls. There is no CLOUDFLARE_API_TOKEN and no wrangler, so `claudeflare tail` cannot run here. The shell only allows the `claudeflare` command, and outbound network access is blocked.
