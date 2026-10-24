# Security policy

## Report a vulnerability

Report vulnerabilities privately through GitHub: open the repository's **Security** tab and choose **Report a vulnerability** (GitHub private vulnerability reporting). Do not open a public issue or pull request.

Include what you found, the steps to reproduce it, the Claude Code version and the impact. You will get an answer as soon as possible, and credit in the release notes if you want it.

## Supported versions

Only the latest release gets security fixes.

## Scope

In scope:

- A Cloudflare write that reaches the API without a valid, user-typed approval and the native confirmation.
- A way for the model to create, forge or reuse an approval, or to apply a plan other than the approved one.
- MCP `execute` code that writes and still passes the guard.
- The API token appearing on disk, in output or in errors.

Out of scope, as described in the README threat model:

- Attacks by a process that already runs as the same OS user (it can read the approval key directly).
- Writes through an MCP connection that was granted write scopes. Connect the Cloudflare MCP server with read-only scopes.
