# Wrangler spike (Task 0), 2026-10-25

Goal: record wrangler 4 behavior that Tasks 2, 5 and 6 depend on, without any
write to Cloudflare and without credentials.

## Setup

- Scratch dir outside the repo, Node v24.22.1, npm 11.19.1, macOS.
- `npm init -y && npm i -D wrangler@4` resolved **wrangler 4.152.0**. npm blocked
  the `workerd` postinstall script (install-scripts policy); dry-run builds
  still worked, they only need esbuild.
- Hand-written project:

```jsonc
// wrangler.jsonc
{ "name": "spike-worker", "main": "src/index.js", "compatibility_date": "2026-10-01" }
```

```js
// src/index.js
export default { async fetch(request) { return new Response("hello from spike"); } };
```

- Every command ran through a wrapper that did
  `unset CLOUDFLARE_API_TOKEN CLOUDFLARE_ACCOUNT_ID CLOUDFLARE_API_KEY CLOUDFLARE_EMAIL`,
  set `WRANGLER_SEND_METRICS=false CI=1`, then `exec npx wrangler "$@"`.
  No `wrangler login` state existed. No command contacted the Cloudflare API
  with credentials. `whoami`, `deployments`, `versions`, `rollback` and
  `d1 time-travel` were only run with `--help`.

## 1. Version output format

```
$ npx wrangler --version
4.152.0
exit=0
```

Bytes: `4.152.0\n` on stdout. Bare semver, no `wrangler` prefix, no banner.
Parse with `/^(\d+)\.(\d+)\.(\d+)/` on the trimmed stdout.

## 2. Dry run without credentials

```
$ npx wrangler deploy --dry-run --outdir out1
(stdout)
 <cloud emoji> wrangler 4.152.0
<line of U+2500 box characters>
Total Upload: 0.18 KiB / gzip: 0.16 KiB
No bindings found.
--dry-run: exiting now.
exit=0
```

`--dry-run` works with no token, no account id and no login. Stdout of two runs
was identical.

## 3. Determinism of `--outdir`

Files written: `index.js` (188 B), `index.js.map` (323 B), `README.md` (113 B).

| File | out1 vs out2 | Why |
|---|---|---|
| `index.js` | identical (sha1 `091b6bac...`) | bundle is deterministic |
| `index.js.map` | differs | `"sourceRoot"` is the `--outdir` value as given (`"out1"` vs `"out2"`; absolute outdirs give the full absolute path) |
| `README.md` | differs | contains a generation timestamp: `This folder contains the built output assets for the worker "spike-worker" generated at 2026-10-25T12:37:55.609Z.` |

Two runs into different absolute temp dirs gave the same result: `index.js`
identical, map and README different. The bundle itself is byte-identical; the
outdir as a whole is not. This matches the spec decision that approval binds
to the source hash, not to the build output.

## 4. ND-JSON from a dry run

```
$ WRANGLER_OUTPUT_FILE_PATH=$PWD/out.ndjson npx wrangler deploy --dry-run --outdir out3
exit=0
$ cat out.ndjson
{"type":"wrangler-session","version":1,"wrangler_version":"4.152.0","command_line_args":["deploy","--dry-run","--outdir","out3"],"log_file_path":"/Users/<user>/Library/Preferences/.wrangler/logs/wrangler-2026-10-25_12-39-50_642.log","timestamp":"2026-10-25T12:39:51.643Z"}
{"type":"deploy","version":1,"worker_name":"spike-worker","worker_tag":null,"version_id":null,"worker_name_overridden":false,"bundle_size":{"raw_bytes":188,"gzip_bytes":160},"timestamp":"2026-10-25T12:39:52.700Z"}
```

- A dry run writes two entries: `wrangler-session` (always first) and `deploy`
  with `version_id: null`, `worker_tag: null` and `bundle_size` in bytes.
- A real deploy's `deploy` entry (with a non-null `version_id` and `targets`)
  is not verified here; deferred to the live test (Task 12).
- The file must be given as an absolute path (the runner creates it in a temp
  dir anyway).

## 5. Broken build (syntax error in `src/index.js`)

```
$ WRANGLER_OUTPUT_FILE_PATH=$PWD/broken.ndjson npx wrangler deploy --dry-run --outdir out4
exit=1
--stdout
 <cloud emoji> wrangler 4.152.0
<line of U+2500 box characters>
--stderr (ANSI codes shown stripped)
X [ERROR] Build failed with 1 error:

  X [ERROR] Expected ")" but found ";"

      src/index.js:3:27:
        3 |     return new Response("x";
          |                            ^
          '                            )

<log emoji>  Logs were written to "/Users/<user>/Library/Preferences/.wrangler/logs/wrangler-2026-10-25_12-40-49_316.log"
--ndjson
{"type":"wrangler-session",...,"command_line_args":["deploy","--dry-run","--outdir","out4"],...}
{"type":"command-failed","version":1,"message":"Build failed with 1 error:\nsrc/index.js:3:27: ERROR: Expected \")\" but found \";\"","timestamp":"2026-10-25T12:40:55.100Z"}
```

- Exit code 1. The outdir is not created.
- stderr contains ANSI color escapes (5 ESC sequences) even with `CI=1`,
  stdout not a TTY, `NO_COLOR=1` or `FORCE_COLOR=0`. Each was tried; the count
  stayed 5.
- The ND-JSON file gets a `command-failed` entry with a plain-text `message`
  (no ANSI). This is the cleanest failure detail.
- Running `deploy --dry-run` in a directory without a wrangler config also exits
  1 (`Could not detect a directory containing static files ...`).

## 6. Side effects outside the project

Every run writes a debug log to `~/Library/Preferences/.wrangler/logs/` (macOS)
and creates `.wrangler/tmp/` in the project dir. The log path also appears in
the `wrangler-session` entry and in stderr on failure.

## 7. Help output of read and restore commands (no real calls)

```
wrangler whoami
  --account  Show membership information for the given account (id or name).  [string]
  --json     Return user information as JSON. Exits with a non-zero status if not authenticated.  [boolean] [default: false]

wrangler deployments list      --name <worker>  --json
wrangler deployments status    --name <worker>  --json
wrangler versions list         --name <worker>  --json

wrangler rollback [version-id]
  --durable-objects-code-update-mode  immediate | deferred <delay>  [string]
  --name                              The name of your Worker  [string]
  -m, --message                       The reason for this rollback  [string]
  -y, --yes                           Automatically accept defaults to prompts  [boolean] [default: false]

wrangler d1 time-travel info <database>
  --timestamp  Unix seconds or RFC3339  [string]
  --json       Return output as JSON  [boolean] [default: false]
  "This command acts on remote D1 Databases."

wrangler d1 time-travel restore <database>
  --bookmark   Bookmark to use for time travel  [string]
  --timestamp  Unix seconds or RFC3339 (within the last 30 days)  [string]
  --json       Return output as JSON  [boolean] [default: false]

wrangler d1 migrations apply <database>
  --local | --remote | --preview | --persist-to
  "When running the apply command in a CI/CD environment or another
  non-interactive command line, the confirmation step will be skipped, but the
  backup will still be captured."
```

- `whoami --json` exists. Its JSON shape (account id field names) was not
  observed because that needs authentication; Task 12 or a fixture from the
  owner must confirm it.
- `d1 time-travel restore` has no `--yes` flag. Whether it skips its
  confirmation under `CI=1` with stdin closed is not verified (needs a real
  DB); deferred to Task 12.
- `d1 migrations apply` has no `--json`.
- New global flag in 4.152.0: `--install-skills` (default false). Global flags
  also include `-c/--config`, `--cwd`, `-e/--env`, `--env-file`.

## 8. npx resolution

In an empty dir with no local wrangler, `npx --no-install wrangler --version`
printed `4.152.0` with exit 0, because a copy exists in the npx cache
(`~/.npm/_npx`). `npx` without `--no-install` in a non-TTY would download the
latest wrangler. A spawn failure of `npx` is therefore not a reliable "wrangler
missing" signal; only a non-zero exit or unparsable version is.

## Implications for Tasks 2, 5, 6

Task 2 (runner, fake wrangler):
- `assertWranglerVersion`: run `--version`, trim stdout, match
  `^(\d+)\.\d+\.\d+`; major != 4 -> `wrangler_version`; spawn error (ENOENT),
  non-zero exit or no semver match -> `wrangler_missing`.
- Consider passing `--no-install` to npx (`prefixArgs: ['--no-install', 'wrangler']`)
  so a project without wrangler fails instead of silently downloading the
  latest version. Suggestion only; the plan interface says `['wrangler']`.
- `events`: parse each non-empty line of the output file as JSON; tolerate a
  missing file (wrangler may die before writing). Always expect a leading
  `wrangler-session` entry.
- Failure detail: prefer the `command-failed` event `message` over stderr. If
  stderr is surfaced, strip ANSI escapes (`/\x1b\[[0-9;]*m/g`) after redaction;
  `NO_COLOR`/`FORCE_COLOR` do not help.
- Fake canned outputs: version stdout `4.152.0\n`; dry-run events
  `wrangler-session` + `deploy` with `version_id: null` and `bundle_size`;
  broken build exit 1 with `command-failed`.
- `whoamiAccounts`: use `whoami --json` (non-zero exit when not
  authenticated). The account field names are unverified; keep the parser in one
  function and confirm the shape in Task 12.
- Preflight (Task 7) can read the upload size from the dry-run `deploy` event
  `bundle_size` instead of parsing the `Total Upload:` text line.

Task 5 (snapshots, inverses):
- Snapshot reads have `--json`: `deployments list --name <w> --json`,
  `versions list --name <w> --json`, `d1 time-travel info <db> --json`.
- Rollback inverse flags confirmed: `rollback <version-id> --name <w> --message <m> --yes`.
  Passing `--name` avoids depending on the wrangler config in cwd.
- Time Travel inverse flags confirmed: `d1 time-travel restore <db> --bookmark <b> --json`.
  There is no `--yes`; non-interactive behavior must be checked in Task 12.
- Fake JSON shapes for `deployments list`, `versions list` and
  `time-travel info` could not be captured without credentials; fixtures will be
  modeled on docs and confirmed in Task 12.

Task 6 (apply):
- New version id comes from the `deploy` event `version_id`. On a dry run it is
  `null`, so apply must treat a null or missing `version_id` after a real deploy
  as a failure to record the result, not as success.
- Exit code 1 is the build/command failure signal -> `wrangler_failed`, with the
  `command-failed` message (redacted) as detail.
- `d1 migrations apply --remote` has no `--json`; its result is the exit code
  plus events only.
- wrangler writes a log file under the user's home on every run; the runner
  cannot prevent it, but the token never appears in argv (env only), so the
  `command_line_args` in the log and in `wrangler-session` stay token-free.
  Secret values go via stdin, also not in argv.
