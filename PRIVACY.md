# Privacy

claudeflare is a local Claude Code plugin. It has no server, no telemetry and no analytics. The project maintainers receive no data from your use of it.

## What runs where

- **The `claudeflare` CLI and hooks** run on your machine. They talk to the Cloudflare API (`https://api.cloudflare.com/client/v4`) using the token you set in `CLOUDFLARE_API_TOKEN`, and run your project's local `wrangler`, which talks to Cloudflare too.
- **Verification after apply** sends plain HTTPS requests, without credentials, to your own hostnames that a plan changed (for example `https://app.example.com/` to check that a tunnel serves it or that Access answers with a login redirect). The skills also suggest `curl -sI` checks against your hostnames.
- **The Cloudflare MCP server** (`https://mcp.cloudflare.com/mcp`) is operated by Cloudflare. Requests sent through it are covered by Cloudflare's own privacy policy.
- **Claude** processes your prompts and the tool results under the terms of your Claude or Anthropic account.

## What is stored locally

- `.claudeflare/` in your project: plans, approvals, snapshots of the resources a plan changes, and audit reports. Snapshots can contain zone configuration such as DNS records and rules, and Zero Trust configuration such as Access policies, which can name people's email addresses or email domains. Secret fields (identity provider secrets, tunnel tokens, service token secrets) are left out of snapshots. The folder is added to `.gitignore` by `claudeflare init`.
- `~/.config/claudeflare/approval.key`: a random key used to sign approvals. Next to it, `secret-files.json` lists the env files `claudeflare tunnel-token` wrote, so the guard can keep the model from reading them.
- An env file you name with `claudeflare tunnel-token --env-path`: the tunnel token, mode 0600.

Nothing is sent to the project maintainers or any other third party. Local files stay until you delete them.

Your API token is read from the environment only. claudeflare never writes it to disk or prints it.

## Deleting your data

Delete the `.claudeflare/` folder in your project, the `~/.config/claudeflare/` folder and any env file written by `claudeflare tunnel-token`.

## Contact

Open an issue at https://github.com/denizbarish/claudeflare/issues, or use GitHub private vulnerability reporting for security matters (see SECURITY.md).
