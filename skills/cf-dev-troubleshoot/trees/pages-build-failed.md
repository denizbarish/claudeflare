# Pages build failed

Symptom: a Pages deployment (Git integration) shows status `failure`, or a direct upload (`pages deploy` op) fails. The deployment's `latest_stage.name` tells where: `queued`, `initialize`, `clone_repo`, `build` or `deploy`.

## Evidence

1. Recent deployments and the failing stage:
   ```
   wrangler pages deployment list --project-name site --json
   ```
   Or through MCP, with the build log of the failed deployment:
   ```js
   async () => {
     const deployments = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/pages/projects/site/deployments" });
     const logs = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/pages/projects/site/deployments/DEPLOYMENT_ID/history/logs" });
     return { deployments: deployments.result, logs: logs.result };
   }
   ```
   Each log entry has `ts` and `line`. Quote the first error line.
2. Build config: `/accounts/ACCOUNT_ID/pages/projects/site` (`build_config.build_command`, `destination_dir`, `root_dir`, `deployment_configs.production` and `.preview` env vars and bindings).
3. Last good deployment: same list, newest with `latest_stage.status: "success"` in the same environment; compare commit and config.

## Hypotheses

1. **Git integration (`initialize` stage).** Confirm: failure before cloning; the GitHub or GitLab app lost access, or the user linking the repo is below Maintainer (GitLab). Reject: the stage passed.
2. **Clone (`clone_repo` stage).** Confirm: Git LFS quota exceeded, or a `.gitmodules` entry without both `path` and `url`. Reject: clone passed.
3. **Build command or output directory (`build` stage).** Confirm: the build command fails in the log (missing script, dependency error), or the build passes but `destination_dir` does not match the framework's output folder. Reject: the build log ends cleanly and the output folder exists.
4. **Language version.** Confirm: the error is a Node.js (or Python, Ruby) version mismatch; the project relies on the build image default (v3 image: Node.js 22.16.0) and needs another version. v1 projects move to v3 on September 15, 2026 and v2 projects on February 23, 2027, which can change defaults. Reject: `NODE_VERSION` or `.nvmrc`/`.node-version` pins a working version.
5. **Missing environment variable.** Confirm: the build reads a variable that is set only for production or only for preview. Reject: set in both.
6. **Limits.** Confirm: build over 20 minutes (timeout), more than 20,000 files (Free; paid plans 100,000 with `PAGES_WRANGLER_MAJOR_VERSION=4`), a single asset over 25 MiB, or the monthly build quota (500 on Free) used up. Reject: within limits.
7. **Functions or deploy stage.** Confirm: the `deploy` stage fails with a Pages Functions error (bad `functions/` code, missing binding). Reject: the deploy stage is not reached or passes. If no project cause shows, check https://www.cloudflarestatus.com/.

## Fix

- Restore service first when production is broken by a bad deploy: a Pages rollback plan to the last successful production deployment (cf-core account REST op):
  ```json
  { "method": "POST", "path": "/accounts/<account_id>/pages/projects/site/deployments/<deployment_id>/rollback" }
  ```
  Only successful production deployments are rollback targets; roll back when a deployment that succeeded is the bad one.
- Hypotheses 1 and 2: steps for the user (reinstall or reauthorize the Cloudflare Pages app in GitHub or GitLab; fix LFS quota or `.gitmodules`).
- Hypotheses 3 to 5: suggest the change (build command, output directory, `NODE_VERSION` variable or `.nvmrc`, missing variable). Build settings and env vars are project settings changed by the user in the dashboard (cf-pages); a `.nvmrc` is a normal file edit with consent.
- Hypothesis 6: reduce files or move large assets to R2 (cf-storage); for the file count on a paid plan, set `PAGES_WRANGLER_MAJOR_VERSION=4`.
- Hypothesis 7: fix the Function code or binding ([missing-binding.md](missing-binding.md)), then a new deployment (`pages deploy` plan or a Git push by the user).
- Verify: the next deployment ends with `latest_stage.name: "deploy"` and `status: "success"`; the site answers `curl -sI https://<project subdomain>.pages.dev/` with 200.

## Sources

- https://developers.cloudflare.com/pages/configuration/debugging-pages/
- https://developers.cloudflare.com/pages/configuration/build-image/
- https://developers.cloudflare.com/pages/configuration/build-configuration/
- https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/workers/wrangler/commands/pages/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/subresources/history/subresources/logs/methods/get/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
