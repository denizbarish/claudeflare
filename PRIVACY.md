# Privacy

claudeflare is a local Claude Code plugin. It has no server, no telemetry and no analytics. The project maintainers receive no data from your use of it.

## What runs where

- **The `claudeflare` CLI and hooks** run on your machine. They talk only to the Cloudflare API (`https://api.cloudflare.com/client/v4`) using the token you set in `CLOUDFLARE_API_TOKEN`.
- **The Cloudflare MCP server** (`https://mcp.cloudflare.com/mcp`) is operated by Cloudflare. Requests sent through it are covered by Cloudflare's own privacy policy.
- **Claude** processes your prompts and the tool results under the terms of your Claude or Anthropic account.

## What is stored locally

- `.claudeflare/` in your project: plans, approvals, snapshots of the resources a plan changes, and audit reports. Snapshots can contain zone configuration such as DNS records and rules. The folder is added to `.gitignore` by `claudeflare init`.
- `~/.config/claudeflare/approval.key`: a random key used to sign approvals.

Your API token is read from the environment only. claudeflare never writes it to disk or prints it.

## Deleting your data

Delete the `.claudeflare/` folder in your project and the `~/.config/claudeflare/` folder.

## Contact

Open an issue at https://github.com/denizbarish/claudeflare/issues, or use GitHub private vulnerability reporting for security matters (see SECURITY.md).
