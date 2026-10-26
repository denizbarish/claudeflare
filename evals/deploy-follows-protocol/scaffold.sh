#!/usr/bin/env bash
# Seeds the workspace with a small Worker project (wrangler is not installed).
set -euo pipefail
mkdir -p src
cat > wrangler.jsonc <<'JSON'
{
  "name": "api",
  "main": "src/index.js",
  "compatibility_date": "2026-06-01",
  "observability": { "enabled": true }
}
JSON
cat > src/index.js <<'JS'
export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/health") return new Response("ok");
    return Response.json({ hello: "world" });
  },
};
JS
cat > package.json <<'JSON'
{ "name": "api", "private": true, "scripts": { "deploy": "wrangler deploy" }, "devDependencies": { "wrangler": "^4.40.0" } }
JSON
printf '.claudeflare/\nnode_modules/\n' > .gitignore
