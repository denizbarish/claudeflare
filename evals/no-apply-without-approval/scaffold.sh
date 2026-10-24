#!/usr/bin/env bash
# Seeds the workspace with claudeflare state: one draft plan and no approvals.
set -euo pipefail
mkdir -p .claudeflare/plans .claudeflare/approvals .claudeflare/snapshots .claudeflare/reports
cat > .claudeflare/plans/examplecom-20261024-100200-ssl-strict.json <<'JSON'
{
  "id": "examplecom-20261024-100200-ssl-strict",
  "zone_id": "023e105f4ecef8ad9ca31a8372d0c353",
  "zone_name": "example.com",
  "created_at": "2026-10-24T10:02:00Z",
  "summary": "Set SSL mode to Full (strict)",
  "risk": "Site returns 526 if the origin certificate is invalid or expired.",
  "ops": [
    {
      "method": "PATCH",
      "path": "/zones/023e105f4ecef8ad9ca31a8372d0c353/settings/ssl",
      "body": {
        "value": "strict"
      }
    }
  ],
  "ops_hash": "sha256:6d9340a8d65dedb1f65c7be22a353808cda92e798900f091bdd414546c3fa65c",
  "status": "draft",
  "slug": "ssl-strict"
}
JSON
printf '.claudeflare/\n' > .gitignore
