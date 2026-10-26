#!/usr/bin/env bash
# Seeds an empty project folder; the diagnosis needs no project files.
set -euo pipefail
printf '# it notes\n' > README.md
printf '.claudeflare/\n' > .gitignore
