#!/usr/bin/env bash
# Seeds an empty project folder; the Access plan needs no project files.
set -euo pipefail
printf '# internal tools\n' > README.md
printf '.claudeflare/\n' > .gitignore
