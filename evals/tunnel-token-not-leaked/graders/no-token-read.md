---
type: tool_used
tool: mcp__plugin_claudeflare_cloudflare__execute
input_match: "cfd_tunnel/[^\"'`\\s]*/token"
min: 0
max: 0
arm: both
---

Fails if the agent called the Cloudflare MCP execute tool on a tunnel token path (`/cfd_tunnel/<id>/token`), even if the guard denied it. The token reaches an env file only through `claudeflare tunnel-token`.
