# Contributing to claudeflare

Thanks for helping. This guide covers the rules every change follows and how to add a domain skill.

## Ground rules

- **No dependencies.** No runtime or dev dependencies. Use Node.js 18 built-ins only (`fetch`, `node:test`, `node:crypto`).
- **ESM only.** Code files are `.mjs`; `package.json` has `"type": "module"`.
- **English** for code, prompts, docs and commit messages.
- **No em dashes or en dashes** anywhere in the repo. Use commas, colons or parentheses. `test/no-dashes.test.mjs` fails on them.
- **Writes go through `claudeflare apply` only.** Never add a code path, prompt or example that sends a write any other way.
- **Never touch the origin.** Skills give origin-side fixes as instructions; they never run commands on the origin.
- **Page Rules** are read and migrated, never created.
- The token comes only from `CLOUDFLARE_API_TOKEN`. Never write it to disk, print it or include it in errors.

## Run the tests

```sh
npm test
claude plugin validate .
```

`npm test` runs `node --test test/*.test.mjs`: the API client, plans, approvals, snapshots, apply and rollback, the CLI, both hooks, manifests, skill content and the no-dashes check. Tests mock `fetch`; they never call Cloudflare.

## Add a domain skill

A domain skill is a checklist for one area of a zone, used by audits and by changes.

1. Create `skills/cf-<domain>/SKILL.md` with frontmatter `name: cf-<domain>` (equal to the folder name) and a `description` that says when to load it and to load `cf-core` first.
2. Use these `##` sections, in this order:
   - `## Read current state`: the exact MCP `execute` reads, written in the canonical form from `skills/cf-core/SKILL.md` section 3. The guard denies any other form.
   - `## Checks`: a table of findings. Each finding has a stable id `<domain>.<area>.<problem>` in backticks, the condition, severity (critical, high, medium, low), the recommended value and the plan tier it needs.
   - `## Applying changes`: the plan ops for each fix, the risk to state, and any op that rollback cannot undo.
   - `## Traps`: mistakes that break sites.
3. Add the domain to the table in `skills/cf-audit/SKILL.md` section 2.
4. Add a content test in `test/content.test.mjs`: put the folder and its finding ids in a map and call `assertDomainSkill(folder, ids)`. It checks the four sections and every finding id.
5. If a fix needs a new resource kind for snapshots and rollback, add it to `scripts/lib/resources.mjs` and `scripts/lib/snapshot.mjs` with unit tests. Without that, the op is flagged as not reversible.
6. Add any new token permission to `docs/token-template.md`, checked against the [Cloudflare permissions reference](https://developers.cloudflare.com/fundamentals/api/reference/permissions/).

## Evals

Behavior evals in `evals/<case>/` have a `prompt.md`, `graders/*.md` and mocks for the Cloudflare MCP server. Run them as shown in the README "Evals" section. Each run costs real money (about $3 to $12). Add an eval when you change agent behavior that unit tests cannot cover, for example the change protocol or how a diagnosis gathers evidence.

In CI the `evals` job runs in a GitHub environment named `evals` (`environment: evals` in `.github/workflows/ci.yml`). Create that environment as a protected environment with required reviewers and store `ANTHROPIC_API_KEY` as an environment secret, so every paid eval run, including runs triggered by pull requests, waits for a maintainer to approve it. The job uploads only `eval-summary.json` (case names, scores and pass or fail), kept for 7 days.

## Pull requests

- Keep a pull request to one change.
- Run `npm test` and `claude plugin validate .` before you open it.
- Add an entry under `## [Unreleased]` in `CHANGELOG.md` when users would notice the change.
- Report security issues privately, as described in `SECURITY.md`, not in a pull request or issue.
