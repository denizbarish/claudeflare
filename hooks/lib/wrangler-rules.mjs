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

// Splits on shell separators and quotes, so commands inside `sh -c "..."` or
// $(...) are checked as commands of their own.
function segments(command) {
  return command
    .split(/&&|\|\||[;&|\n()`"'{}]|\$\(/)
    .map((segment) => segment.trim().split(/\s+/).filter(Boolean))
    .filter((tokens) => tokens.length);
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
  if (words.length === 0) return true;
  if ([...flags].some((f) => HELP_FLAGS.has(f))) return true;
  if (READ_PATHS.some((path) => startsWith(words, path))) return true;
  return LOCAL_UNLESS_REMOTE.some((path) => startsWith(words, path)) && !flags.has('--remote');
}

// Returns the deny reason, or null when no wrangler write is found.
export function decideWrangler(command) {
  if (typeof command !== 'string' || !command.includes('wrangler')) return null;
  for (const tokens of segments(command)) {
    const start = wranglerArgsStart(tokens);
    if (start === -1) continue;
    if (!allowed(parseInvocation(tokens.slice(start)))) return WRANGLER_REASON;
  }
  return null;
}
