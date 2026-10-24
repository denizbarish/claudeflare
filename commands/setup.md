---
description: Check the Cloudflare MCP connection and API token, initialize claudeflare state, and show the token template.
---

Set up claudeflare for this project. Load the `cf-core` skill, then do these steps in order and report each result in the user's language.

1. **MCP connection.** Call the Cloudflare MCP `execute` tool with exactly:
   `const accounts = await cloudflare.request({ method: "GET", path: "/accounts", query: { per_page: 5 } }); return accounts;`
   If the tools are missing or the call fails with an auth error, tell the user to run `/mcp`, select the `cloudflare` server and sign in. Recommend granting read-only OAuth scopes: reads go through MCP, writes never do.
2. **API token.** Run `claudeflare get /user/tokens/verify`.
   - Success with `status: "active"`: the token works. Never print or repeat the token.
   - `missing_token`: writes and `claudeflare get` need `CLOUDFLARE_API_TOKEN` in the environment. Tell the user to export it in their shell profile and restart Claude Code. Never ask them to paste the token into chat.
   - Any other error: show the error code and hint.
   A token is optional for audits and diagnosis through MCP; it is required for `claudeflare apply`.
3. **Local state.** Run `claudeflare init`. Report the state directory and whether `.gitignore` was updated.
4. **Token template.** Read `${CLAUDE_PLUGIN_ROOT}/docs/token-template.md` and show the read and write permission sets. If the file is missing, say so.

Finish with a short status table (MCP, token, local state) and the next step, for example `/claudeflare:audit`.
