# Security policy

## Report a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue or pull request.

Include what you found, the steps to reproduce it, the Claude Code version and the impact. You will get an answer as soon as possible, and credit in the release notes if you want it.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope: the CLI and hook logic failing on the documented paths, for example:

- A forged, expired, reused or mismatched approval that `checkApproval` accepts.
- `claudeflare apply` writing without a valid approval for that exact plan.
- The approval hook recording an approval from anything other than a prompt that is exactly `/claudeflare:approve <plan-id>`.
- The guard misclassifying MCP `execute` code in the canonical form, for example allowing a write.
- The API token appearing on disk, in output or in errors.

Out of scope, as described in the README threat model:

- Deliberate evasion by a process or shell running as the same OS user, including writes through HTTP clients other than `curl`, commands built at run time, and shell globs that reach the approval key. The Bash checks are string matches for mistakes, not a sandbox.
- Writes through an MCP connection that was granted write scopes. Connect the Cloudflare MCP server with read-only scopes.
