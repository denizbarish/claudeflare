// Guard rules for wrangler run directly through Bash. Positive allowlist (the
// v1 lesson: blocklists leak): a wrangler invocation passes only when its
// subcommand is a read or a local-only command listed here; every other
// subcommand, known or new, is denied with a pointer to the change protocol.
// String checks catch model mistakes, not deliberate evasion.

export const WRANGLER_REASON =
  'Direct wrangler writes are not allowed. Use the change protocol: claudeflare preflight, claudeflare plan new, approval, claudeflare apply (skills/cf-core). Reads such as deployments list, versions list and claudeflare tail are allowed.';

// Subcommand paths that never change remote state. Extra positionals after a
// path (database or Worker names) are fine.
const READ_PATHS = [
  ['whoami'],
  ['deployments', 'list'],
  ['deployments', 'status'],
  ['versions', 'list'],
  ['versions', 'view'],
  ['tail'],
  ['d1', 'list'],
  ['d1', 'info'],
  ['d1', 'export'],
  ['d1', 'migrations', 'list'],
  ['d1', 'migrations', 'create'],
  ['d1', 'time-travel', 'info'],
  ['r2', 'bucket', 'list'],
  ['r2', 'bucket', 'info'],
  ['r2', 'object', 'get'],
  ['kv', 'namespace', 'list'],
  ['kv', 'key', 'list'],
  ['kv', 'key', 'get'],
  ['queues', 'list'],
  ['pages', 'project', 'list'],
  ['pages', 'deployment', 'list'],
  ['secret', 'list'],
  ['dev'],
  ['pages', 'dev'],
  ['types'],
  ['build'],
];
// Local unless --remote is given (wrangler 4 defaults D1 commands to local).
const LOCAL_UNLESS_REMOTE = [
  ['d1', 'execute'],
  ['d1', 'migrations', 'apply'],
];
const HELP_FLAGS = new Set(['--help', '-h', '--version', '-v']);
// Global flags that take a value and may come before the subcommand.
const VALUE_FLAGS = new Set(['--config', '-c', '--env', '-e', '--cwd', '--env-file']);

const RUNNERS = new Set(['npx', 'bunx', 'pnpx']);
const ENV_PREFIXES = new Set(['env', 'sudo', 'time', 'command', 'exec', 'nohup']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

const isWranglerToken = (token) => /^(?:.*\/)?wrangler(?:@[^\s/]+)?$/.test(token);
const isWranglerScript = (token) => /(?:^|\/)wrangler(?:\.m?js)?$|(?:^|\/)wrangler-dist\/cli\.js$/.test(token);

// Read-only commands that never run their arguments: a wrangler word in them
// is a mention (grep wrangler package.json), not an invocation. Commands that
// can run one (git -c alias, rg --pre, less via LESSOPEN) are not listed.
const SAFE_HEADS = new Set([
  'grep', 'egrep', 'fgrep', 'cat', 'head', 'tail', 'ls', 'echo', 'printf', 'which', 'type', 'wc', 'file', 'stat', 'diff', 'jq',
]);
const MAX_NESTING = 3;

// Minimal shell word splitter: quotes and backslashes join into one word,
// unquoted ; & | newline ( ) ` $( and group braces end a command. Quoted
// texts are also returned with the head of the command they belong to, so
// `sh -c "..."` and "$(...)" get checked as commands of their own.
export function parseShell(command) {
  const commands = [];
  const nested = [];
  let words = [];
  let word = null;
  const endWord = () => {
    if (word !== null) words.push(word);
    word = null;
  };
  const endCommand = () => {
    endWord();
    if (words.length) commands.push(words);
    words = [];
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'") {
      const close = command.indexOf("'", i + 1);
      const end = close === -1 ? command.length : close;
      const text = command.slice(i + 1, end);
      nested.push({ text, head: words[0] ?? null });
      word = (word ?? '') + text;
      i = end;
    } else if (c === '"') {
      let j = i + 1;
      let text = '';
      while (j < command.length && command[j] !== '"') {
        if (command[j] === '\\' && j + 1 < command.length) {
          text += command[j + 1];
          j += 2;
        } else {
          text += command[j++];
        }
      }
      nested.push({ text, head: words[0] ?? null });
      word = (word ?? '') + text;
      i = j;
    } else if (c === '\\' && i + 1 < command.length) {
      if (command[i + 1] !== '\n') word = (word ?? '') + command[i + 1];
      i++;
    } else if (c === '$' && command[i + 1] === '(') {
      endCommand();
      i++;
    } else if (';&|\n()`'.includes(c) || ((c === '{' || c === '}') && word === null)) {
      endCommand();
    } else if (/\s/.test(c)) {
      endWord();
    } else {
      word = (word ?? '') + c;
    }
  }
  endCommand();
  return { commands, nested };
}

function skipFlags(tokens, i) {
  while (i < tokens.length && tokens[i].startsWith('-')) i++;
  return i;
}

// Index of the first argument after wrangler when the segment runs wrangler,
// else -1.
function wranglerArgsStart(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || ENV_PREFIXES.has(tokens[i]))) i = skipFlags(tokens, i + 1);
  const head = tokens[i];
  if (head === undefined) return -1;
  if (isWranglerToken(head)) return i + 1;
  let next = i + 1;
  if (RUNNERS.has(head)) {
    next = skipFlags(tokens, next);
  } else if (head === 'pnpm' || head === 'yarn') {
    next = skipFlags(tokens, next);
    if (tokens[next] === 'exec' || tokens[next] === 'dlx') next = skipFlags(tokens, next + 1);
  } else if (head === 'npm') {
    next = skipFlags(tokens, next);
    if (tokens[next] !== 'exec' && tokens[next] !== 'x') return -1;
    next = skipFlags(tokens, next + 1);
    if (tokens[next] === '--') next++;
  } else if (head === 'node' || /(?:^|\/)node$/.test(head)) {
    next = skipFlags(tokens, next);
    return tokens[next] !== undefined && isWranglerScript(tokens[next]) ? next + 1 : -1;
  } else {
    return -1;
  }
  return tokens[next] !== undefined && isWranglerToken(tokens[next]) ? next + 1 : -1;
}

// Subcommand words (before the first flag) and all flags of one invocation.
function parseInvocation(args) {
  const words = [];
  const flags = new Set();
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) {
    flags.add(args[i].split('=')[0]);
    i += VALUE_FLAGS.has(args[i]) ? 2 : 1;
  }
  for (; i < args.length && !args[i].startsWith('-'); i++) words.push(args[i]);
  for (; i < args.length; i++) {
    if (args[i].startsWith('-')) flags.add(args[i].split('=')[0]);
  }
  return { words, flags };
}

const startsWith = (words, path) => path.every((word, i) => words[i] === word);

function allowed({ words, flags }) {
  if ([...flags].some((f) => HELP_FLAGS.has(f))) return true;
  // Bare `wrangler` prints help; anything else must name an allowed path.
  if (words.length === 0) return flags.size === 0;
  if (READ_PATHS.some((path) => startsWith(words, path))) return true;
  return LOCAL_UNLESS_REMOTE.some((path) => startsWith(words, path)) && !flags.has('--remote');
}

const mentionsWrangler = (token) => isWranglerToken(token) || isWranglerScript(token);

function deniedCommand(tokens) {
  const start = wranglerArgsStart(tokens);
  if (start !== -1) return !allowed(parseInvocation(tokens.slice(start)));
  const head = tokens[0].split('/').at(-1);
  if (SAFE_HEADS.has(head)) return false;
  // Unknown wrapper (timeout, xargs, nice, ...): judge what follows the
  // first wrangler word, failing closed.
  const k = tokens.findIndex((token, i) => i > 0 && mentionsWrangler(token));
  return k !== -1 && !allowed(parseInvocation(tokens.slice(k + 1)));
}

// Returns the deny reason, or null when no wrangler write is found.
export function decideWrangler(command, depth = 0) {
  if (typeof command !== 'string' || !command.replace(/\\\n|['"\\]/g, '').includes('wrangler')) return null;
  const { commands, nested } = parseShell(command);
  if (commands.some(deniedCommand)) return WRANGLER_REASON;
  // Deeper nesting than this is not unwrapped; fail closed.
  if (depth >= MAX_NESTING) return nested.length ? WRANGLER_REASON : null;
  for (const { text, head } of nested) {
    // Under a read-only head only command substitutions run.
    const runs = head && SAFE_HEADS.has(head.split('/').at(-1)) ? text.split(/\$\(|`/).slice(1) : [text];
    if (runs.some((part) => decideWrangler(part, depth + 1))) return WRANGLER_REASON;
  }
  return null;
}
