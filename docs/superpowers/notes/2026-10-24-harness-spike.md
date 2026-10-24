# Harness spike results (Task 0)

Date: 2026-10-24. Claude Code `2.1.306` on macOS (Darwin 25.5.0).

The scratch plugin lived outside the repo (session scratchpad, `spike-plugin/`) and was loaded per session with `--plugin-dir`. Nothing was installed. User settings and installed plugins were not changed. One side effect: the interactive runs accepted the folder-trust dialog for the scratch working directory, which adds a trust entry for that temporary path to `~/.claude.json`.

Plugin layout:

- `.claude-plugin/plugin.json`: `{"name":"spike"}`
- `hooks/hooks.json`: `PreToolUse` (matcher `Bash`) -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/pre.mjs"`; `UserPromptSubmit` -> `node "${CLAUDE_PLUGIN_ROOT}/hooks/ups.mjs"`
- `hooks/pre.mjs`: logs stdin. For a Bash command starting with `echo spike`, prints `{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"ask","permissionDecisionReason":"spike"}}`
- `hooks/ups.mjs`: appends stdin JSON to a log file
- `commands/approve.md`: body `CLAUDEFLARE_APPROVE $ARGUMENTS` and `Plugin root is: ${CLAUDE_PLUGIN_ROOT}`
- `bin/spike-bin`: `#!/bin/sh` + `echo bin-ok`, chmod +x

`<S>` below is the scratchpad directory.

## Step 1: hook `ask` under `--dangerously-skip-permissions`

### 1a. Interactive TUI (driven with `expect`), bypass on

Command:

```
claude --plugin-dir <S>/spike-plugin --dangerously-skip-permissions \
  "Run this exact Bash command once, do not retry, then stop: echo spike-ran > <S>/ran.txt"
```

Observed (terminal output, ANSI stripped):

```
Bash command  Write marker text to file
  echo spike-ran > <S>/ran.txt
Hook PreToolUse:Bash requires confirmation for this command:
  spike  [plugin:spike]  ... plugin hooks.json to update hooks
Do you want to proceed?
> 1. Yes
```

The script then pressed Esc. `<S>/ran.txt` was not created. Hook stdin had `"permission_mode":"bypassPermissions"`.

Conclusion: **in interactive mode, a hook `ask` shows the native permission prompt even in `bypassPermissions` mode.** The hook's `permissionDecisionReason` is shown in the prompt.

### 1b. Headless `-p`, bypass on

Command:

```
claude -p "Run this exact Bash command once, do not retry, then stop: echo spike-ran > <S>/ran.txt" \
  --plugin-dir <S>/spike-plugin --dangerously-skip-permissions --max-turns 3 \
  --output-format stream-json --verbose
```

Observed: tool_result content `"spike"`, `is_error: true`; the `result` event lists the Bash call in `permission_denials`; `ran.txt` not created. Hook stdin: `"permission_mode":"bypassPermissions"`.

### 1c. Headless `-p`, `--permission-mode default` (comparison)

Same command with `--permission-mode default` instead of the bypass flag. Observed: identical (tool_result `"spike"`, `is_error: true`, listed in `permission_denials`, no file). Hook stdin: `"permission_mode":"default"`.

### 1d. Control, headless bypass, command not matched by the hook

Prompt `echo control > <S>/ctl.txt`. Observed: tool_result `"(Bash completed with no output)"`, `is_error: false`, file created with `control`. This confirms the denials above came from the hook's `ask`, not from bypass or user rules.

Conclusion: **in headless `-p` mode there is nobody to answer, so a hook `ask` acts as a deny** (the model sees the reason text as an error), in both bypass and default modes. It is never auto-allowed.

## Step 2: `UserPromptSubmit` `prompt` field for a plugin command

Headless command:

```
claude -p "/spike:approve abc" --plugin-dir <S>/spike-plugin --dangerously-skip-permissions \
  --max-turns 2 --output-format stream-json --verbose
```

Logged stdin (full):

```json
{"session_id":"94c39d49-4514-4668-8c5b-2c9d2ba69a3d","transcript_path":"/Users/deniz/.claude/projects/-private-tmp-...-scratchpad-work/94c39d49-4514-4668-8c5b-2c9d2ba69a3d.jsonl","cwd":"<S>/work","prompt_id":"2db93523-7a29-4738-977a-4641993a4982","permission_mode":"bypassPermissions","hook_event_name":"UserPromptSubmit","prompt":"/spike:approve abc"}
```

Interactive run (`claude --plugin-dir <S>/spike-plugin --dangerously-skip-permissions "/spike:approve abc"` via `expect`) logged the same field: `"prompt":"/spike:approve abc"`.

Conclusion: **the hook receives the raw slash text** `/spike:approve abc`, not the expanded command body. The regex `/^\s*\/claudeflare:approve\s+([a-z0-9-]+)\s*$/` in Task 6 works as written; no `CLAUDEFLARE_APPROVE` body marker is needed.

## Step 3: plugin `bin/` executable by bare name

Command:

```
claude -p "Run exactly these two Bash commands, one at a time, do not retry or search for anything: 1) spike-bin  2) echo \"\$PATH\" | tr ':' '\n' | grep spike-plugin" \
  --plugin-dir <S>/spike-plugin --dangerously-skip-permissions --max-turns 4 \
  --output-format stream-json --verbose
```

Observed:

```
TOOL_USE: "spike-bin"            TOOL_RESULT: "bin-ok"                (is_error false)
TOOL_USE: "echo $PATH | ... "    TOOL_RESULT: "<S>/spike-plugin/bin"  (is_error false)
```

Outside Claude Code, `which spike-bin` fails (not found), so the PATH entry comes from the plugin.

Conclusion: **the plugin's `bin/` directory is prepended to PATH for the Bash tool; executables there run by bare name.**

Extra observation (not required, since Step 3 passed): in Step 2 the model's reply was `CLAUDEFLARE_APPROVE abc` and `Plugin root is: <S>/spike-plugin`, so `$ARGUMENTS` and `${CLAUDE_PLUGIN_ROOT}` are both expanded inside a command `.md` body.

## Implications for Tasks 5 to 7

- **Task 5 (CLI):** keep `bin/claudeflare`. Skills and commands can call `claudeflare <subcommand>` by bare name; the `node "${CLAUDE_PLUGIN_ROOT}/scripts/cf.mjs"` fallback is not needed.
- **Task 6 (approve.mjs):** keep matching the raw `prompt` against `/^\s*\/claudeflare:approve\s+([a-z0-9-]+)\s*$/`. Drop the "Task 0 alternative" wording.
- **Task 6 (guard.mjs), needs a decision:** returning `ask` for a valid `claudeflare apply` shows the native prompt in interactive sessions, including bypass mode, so the second confirmation works there. In headless `-p` (and any non-interactive run without a permission prompt handler), the same `ask` is a deny, so `claudeflare apply` can never run headless even with a valid approval. If headless apply must work (for example evals that run apply), the guard would need `allow` for valid approvals in non-interactive runs, but this spike found no field in the hook stdin that marks a run as headless (`permission_mode` is the same). Owner decision needed: accept "apply is interactive only", or change the valid-approval row to `allow`.
- **Task 7 (commands, skills):** command bodies may use `${CLAUDE_PLUGIN_ROOT}` and `$ARGUMENTS`; both expand. `/claudeflare:approve <id>` reaches the hook as typed, so the command body only needs to tell the model what to do after approval.
- **Spec 2 / README:** the "Unverified" item in spec section 2 and the README note in spec "Spike before implementation" can now say: hook `ask` prompts in `bypassPermissions` mode (interactive), and acts as a deny in headless mode.
