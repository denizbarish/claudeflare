---
name: cf-pages
description: Cloudflare Pages checklist for one account. Projects, build config and build cache, production branch, preview vs production deployments and their access, custom domains, and deploy and rollback plans. Load it when auditing Pages projects, deploying a Pages site, or rolling back a Pages production deployment. Load cf-core first.
---

# cf-pages: projects, builds, previews, domains, deploys

Load `cf-core` first. Findings use the `cf-audit` finding format and severity scale. Pages projects are account resources: plans use `"scope": "account"`. In the MCP examples below, replace `ACCOUNT_ID` with the real account id (32 hex characters) from cf-core discovery and `PROJECT` with the project name; the guard needs literal paths.

## Read current state

| What | Source |
|---|---|
| All projects | GET `/accounts/{account_id}/pages/projects`, or `wrangler pages project list` |
| One project: `subdomain`, `domains`, `production_branch`, `build_config` (`build_caching`, `build_command`, `destination_dir`, `root_dir`), `source` (absent for Direct Upload), `canonical_deployment`, `latest_deployment` | GET `/accounts/{account_id}/pages/projects/{project_name}` |
| Git settings: `source.config.production_branch`, `production_deployments_enabled`, `preview_deployment_setting` (`all`, `none`, `custom`), `preview_branch_includes`, `preview_branch_excludes` | same read, under `source.config` |
| Build image version (`build_image_major_version`) | same read, under `deployment_configs.production` and `deployment_configs.preview` |
| Deployments, optionally one environment (`environment`, `id`, `url`, `latest_stage`) | GET `/accounts/{account_id}/pages/projects/{project_name}/deployments` with `env: "production"` or `env: "preview"`, or `wrangler pages deployment list --project-name <p>` |
| Custom domains (`name`, `status`) | GET `/accounts/{account_id}/pages/projects/{project_name}/domains` |
| Access apps that may protect previews (`domain`) | GET `/accounts/{account_id}/access/apps` |

MCP `execute`:

```js
async () => {
  const project = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/pages/projects/PROJECT" });
  const production = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/pages/projects/PROJECT/deployments", query: { env: "production" } });
  const domains = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/pages/projects/PROJECT/domains" });
  const access = await cloudflare.request({ method: "GET", path: "/accounts/ACCOUNT_ID/access/apps" });
  return { project: project.result, production: production.result, domains: domains.result, access: access.result };
}
```

Fallback: `claudeflare get /accounts/ACCOUNT_ID/pages/projects/PROJECT` and `claudeflare get /accounts/ACCOUNT_ID/pages/projects/PROJECT/deployments --query env=production`. Reading Access apps needs an Access read permission on the token; if the read fails, report the preview check as unread.

A project with `source` is Git-connected (Cloudflare builds it). A project without `source` is Direct Upload (built elsewhere, uploaded with `pages deploy`); it cannot be switched to Git later.

## Checks

| finding id | condition | severity | recommended | plan tier |
|---|---|---|---|---|
| `pages.production_branch.unprotected` | Git-connected project with `production_deployments_enabled: true`, and the production branch has no branch protection at the Git provider (for GitHub, `gh api repos/<owner>/<repo>/branches/<branch>/protection` returns 404). Every push to that branch goes live without review. | medium | Branch protection with required review at the Git provider, or production deploys only through a reviewed claudeflare plan | free |
| `pages.build.no_cache` | Git-connected project with `build_config.build_caching` `false` or missing. Needs build image V2 or later (`build_image_major_version` 2 or higher). | low | Build cache on (dashboard: Settings > Build > Build cache) | free |
| `pages.preview.public` | Previews are created (`preview_deployment_setting` is `all` or `custom`, or the project is Direct Upload and preview deployments exist), and no Access app has a `domain` covering `*.<project>.pages.dev`. Every preview URL is then public, including unreleased work. | medium | Access policy for previews (dashboard: Settings > General > Enable access policy), or `preview_deployment_setting: "none"` if previews are unused | free |
| `pages.custom_domain.missing` | `domains` holds only `<project>.pages.dev`, or a custom domain's `status` is not `active`, for a project that serves production traffic. | low | A custom domain added in the Pages project (zone on Cloudflare for an apex domain), status `active` | free |

Notes for findings:

- `pages.production_branch.unprotected`: Direct Upload projects have no Git trigger; production changes only when someone runs `pages deploy` for the production branch. Do not raise the finding for them. The fix is on the Git provider side, so `fix: []`.
- `pages.build.no_cache`: the cache is project wide, holds up to 10 GB and is purged 7 days after its last read. `fix: []` (dashboard setting; there is no allowlisted op for it). Not relevant for Direct Upload projects.
- `pages.preview.public`: the Pages access policy covers preview deployments only, not `<project>.pages.dev` or custom domains. Protecting `*.pages.dev` as well takes extra Access steps (see Traps). `fix: []`.
- `pages.custom_domain.missing`: adding a domain is a dashboard step (no allowlisted op). A subdomain outside Cloudflare also needs a CNAME at the user's DNS provider pointing to `<project>.pages.dev`; an apex domain must be a zone in the same account. `fix: []`.

## Applying changes

Use the change protocol from cf-core: draft, `claudeflare preflight --file draft.json`, `claudeflare plan new --file draft.json`, user approval, `claudeflare apply <id>`. Never put `--yes`, `-y`, `--message`, `--dry-run` or `--outdir` in ops.

Deploy a built directory (reversible: the snapshot keeps the current production deployment, rollback restores it). The directory must be inside `project_dir`; build it before preflight:

```json
{
  "kind": "wrangler",
  "args": ["pages", "deploy", "dist", "--project-name", "web", "--branch", "main"],
  "health_check": { "url": "https://www.example.com/", "expect_status": 200 },
  "on_failed_check": "rollback"
}
```

`--branch` decides the environment: the production branch deploys to production; any other branch creates a preview at `<hash>.<project>.pages.dev` with the alias `<branch>.<project>.pages.dev`. Inside a Git work tree wrangler takes the branch from Git when `--branch` is missing; set it explicitly so the plan states the target.

Roll production back to an earlier deployment (the only account REST write op; reversible). Take `DEPLOYMENT_ID` from the production deployments read; only successful production deployments are valid targets, previews are not:

```json
{ "method": "POST", "path": "/accounts/ACCOUNT_ID/pages/projects/PROJECT/deployments/DEPLOYMENT_ID/rollback" }
```

Replace `ACCOUNT_ID`, `PROJECT` and `DEPLOYMENT_ID` with real values; plan creation rejects placeholders. The change is instant. `claudeflare rollback <plan id>` returns to the deployment recorded in the snapshot.

Health check and `on_failed_check` behave as in cf-workers: GET to the https URL, 3 tries 5 seconds apart, no redirects followed, `expect_status` default 200; on failure with `"on_failed_check": "rollback"` the snapshot deployment is restored (status `rolled_back_auto`). Point the check at a URL that answers 200 directly, not one that redirects.

After apply, verify with `wrangler pages deployment list --project-name <p>`: the new deployment is the production one.

## Traps

- A CNAME to `<project>.pages.dev` without first adding the domain in the Pages project fails with error 522.
- A custom domain cannot be added while an Access policy is already on that domain, and it does not verify unless `/.well-known/acme-challenge/*` is reachable (not blocked by Access or a Worker).
- Advanced Certificates cannot be used with Pages custom domains.
- Protecting `*.pages.dev` with Access and not the custom domain shows an Access login that does not work for custom domain visitors; add an Access app for the custom domain too.
- Direct Upload cannot be switched to Git integration later; a Git build needs a new project.
- Limits: 20,000 files per site on Free (100,000 on paid plans with `PAGES_WRANGLER_MAJOR_VERSION=4` set in the project), 25 MiB per file, builds time out after 20 minutes, 500 builds per month on Free.
- Pages rollback switches the production deployment only; data behind bindings (KV, D1, R2) is not rolled back.
- Direct `wrangler pages deploy` is denied by the guard; always plan it.

## Sources

- https://developers.cloudflare.com/pages/configuration/build-caching/
- https://developers.cloudflare.com/pages/configuration/preview-deployments/
- https://developers.cloudflare.com/pages/configuration/rollbacks/
- https://developers.cloudflare.com/pages/configuration/custom-domains/
- https://developers.cloudflare.com/pages/configuration/git-integration/
- https://developers.cloudflare.com/pages/get-started/direct-upload/
- https://developers.cloudflare.com/pages/platform/limits/
- https://developers.cloudflare.com/pages/platform/known-issues/
- https://developers.cloudflare.com/workers/wrangler/commands/pages/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/methods/get/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/list/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/rollback/
- https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/domains/methods/list/
- https://developers.cloudflare.com/api/resources/zero_trust/subresources/access/subresources/applications/methods/list/
