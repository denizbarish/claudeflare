---
description: SSL audit of a zone whose SSL mode is Flexible; the reply must report finding ssl.mode.flexible as critical and mention the 526 risk.
max_turns: 30
timeout_seconds: 600
allowed_tools: [Read, Glob, Grep, Skill, Agent]
---

Can you audit the SSL/TLS configuration of example.com? Only the SSL domain, nothing else.

Note about this environment: this is a test zone. The Cloudflare MCP server here returns a recorded snapshot of the zone for read calls. There is no CLOUDFLARE_API_TOKEN and no shell in this session.
