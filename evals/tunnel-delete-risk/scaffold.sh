#!/usr/bin/env bash
# Seeds an empty project folder; the tunnel lives in the account, not here.
set -euo pipefail
printf '# ops notes\n' > README.md
printf '.claudeflare/\n' > .gitignore
