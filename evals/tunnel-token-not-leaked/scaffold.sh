#!/usr/bin/env bash
# Seeds a small Compose project with one app on port 3000 (Docker is not installed).
set -euo pipefail
cat > docker-compose.yml <<'YAML'
services:
  app:
    image: node:22-alpine
    working_dir: /app
    command: node server.js
    volumes:
      - ./:/app
    ports:
      - "3000:3000"
YAML
cat > server.js <<'JS'
const http = require('node:http');
http.createServer((req, res) => res.end('ok')).listen(3000);
JS
printf '.claudeflare/\nnode_modules/\n' > .gitignore
