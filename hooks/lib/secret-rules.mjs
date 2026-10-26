// Secret files and tunnel tokens: claudeflare writes credentials to disk
// (.claudeflare/secrets/*, env files from `claudeflare tunnel-token`) and lists
// them in .claudeflare/secret-files.json and in the per-user index next to
// the approval key. These rules keep the agent from reading them back and
// from putting a literal tunnel token on a cloudflared command line. Same
// threat model as the rest of the guard: string checks catch model mistakes,
// not deliberate evasion.
import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { keyDir } from '../../scripts/lib/approval-key.mjs';
import { STATE_DIR, claudeflareRoot } from '../../scripts/lib/project-root.mjs';
import { TOKEN_RESOURCES, TUNNEL_TOKEN_REASON } from '../../scripts/lib/token-endpoint.mjs';
import { parseShell } from './wrangler-rules.mjs';

export { TUNNEL_TOKEN_REASON };

export const SECRET_REASON =
  'This file holds a credential written by claudeflare and must not be read into the conversation. Let the program that needs it read it (for example cloudflared reading TUNNEL_TOKEN from the environment).';
export const CLOUDFLARED_REASON =
  'A literal tunnel token on a cloudflared command line ends up in the transcript and shell history. Write it with "claudeflare tunnel-token" and let cloudflared read TUNNEL_TOKEN from the environment, or run cloudflared with --token-file yourself.';

const INDEX_FILE = 'secret-files.json';
const SECRETS_TEXT = '.claudeflare/secrets';
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
// Commands that print a file: with one of these as the head, a secret file's
// bare name is enough to deny (the guard cannot follow every cd).
const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'nl', 'grep', 'rg', 'sed', 'awk', 'cp', 'mv', 'base64', 'xxd', 'od', 'strings', 'source', '.']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// Words that run the next word as the command, with their options that take
// a value. With any of them in front, a command is never a consumer.
const PREFIX_VALUE_OPTIONS = {
  env: ['-u', '--unset', '-C', '--chdir', '-S', '--split-string'],
  sudo: ['-u', '--user', '-g', '--group', '-h', '--host', '-p', '--prompt', '-C', '--close-from', '-D', '--chdir', '-r', '--role', '-t', '--type', '-U', '--other-user', '-T', '--command-timeout'],
  doas: ['-u', '-C'],
  xargs: ['-I', '-n', '--max-args', '-L', '--max-lines', '-P', '--max-procs', '-s', '--max-chars', '-d', '--delimiter', '-E', '-a', '--arg-file'],
  time: ['-o', '--output', '-f', '--format'],
  nice: ['-n', '--adjustment'],
  nohup: [],
  timeout: ['-s', '--signal', '-k', '--kill-after'],
  command: [],
  exec: ['-a'],
  builtin: [],
  stdbuf: ['-i', '-o', '-e', '--input', '--output', '--error'],
  ionice: ['-c', '--class', '-n', '--classdata', '-p', '--pid', '-P', '--pgid', '-u', '--uid'],
};
const PREFIX_HEADS = new Set(Object.keys(PREFIX_VALUE_OPTIONS));
// Ruling 14: exact consumer shapes. Each exempts single arguments only.
const PLAIN_CONSUMERS = new Set(['chmod', 'chown', 'ls', 'stat', 'test', '[', 'rm']);
const GIT_PATH_COMMANDS = new Set(['add', 'rm']);
const GIT_SAFE_FLAGS = new Set(['-f', '--force', '-q', '--quiet', '-r', '--cached', '-n', '--dry-run', '-v', '--verbose', '-A', '--all', '-u', '--update', '--ignore-errors']);
const COMPOSE_SUBCOMMANDS = new Set(['down', 'restart', 'stop', 'pull']);
const RUN_VALUE_OPTIONS = new Set(['--name', '--restart', '-p', '--publish', '--network', '-v', '--volume', '-e', '--env']);
const RUN_VALUE_INLINE = /^--(?:name|restart|publish|network|volume|env)=/;
const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_PREFIX = /^\d*[<>]+&?/;
const TOKEN_ASSIGNMENT = /^TUNNEL_TOKEN=(.*)$/;
const TOKEN_FLAG = /^--?token$/;
const TOKEN_FLAG_VALUE = /^--?token=(.*)$/;
const CLOUDFLARED = /(?:^|\/)cloudflared(?::[^/\s]*)?$/;
const MAX_NESTING = 3;
const NONE = new Set();

// Secret files

function readIndexFile(file) {
  try {
    const index = JSON.parse(readFileSync(file, 'utf8'));
    return Array.isArray(index?.files) ? index.files.filter((f) => typeof f === 'string' && isAbsolute(f)) : [];
  } catch {
    return [];
  }
}

function secretsDirFiles(root) {
  const dir = join(root, STATE_DIR, 'secrets');
  try {
    return readdirSync(dir).map((name) => join(dir, name));
  } catch {
    return [];
  }
}

// Secret files from the per-user index, the session cwd and the projects that
// own cwd and each target (nearest ancestor holding .claudeflare): indexes
// plus whatever sits in each secrets folder. Missing or invalid files count
// as empty.
export function secretFilesFor(cwd, targets = []) {
  const roots = new Set([resolve(cwd)]);
  for (const start of [cwd, ...targets]) {
    const root = claudeflareRoot(start);
    if (root) roots.add(root);
  }
  const files = [
    ...readIndexFile(join(keyDir(), INDEX_FILE)),
    ...[...roots].flatMap((root) => [...readIndexFile(join(root, STATE_DIR, INDEX_FILE)), ...secretsDirFiles(root)]),
  ];
  return [...new Set(files)];
}

// True only for a positive glob the guard fully models (literal characters,
// `*`, `?`, leading directory parts) whose last segment cannot match name.
// Anything else (`!`, braces, classes, whitespace or commas that may list
// several globs, `**` in the last segment) can match.
export function globExcludes(glob, name) {
  if (typeof glob !== 'string' || glob === '' || glob.startsWith('!') || /[{}[\]\\,\s]/.test(glob)) return false;
  const segment = glob.split('/').at(-1);
  if (segment === '' || segment.includes('**')) return false;
  const source = [...segment].map((c) => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^$()|]/g, '\\$&'))).join('');
  return !new RegExp(`^${source}$`, 'i').test(name);
}

// Shell commands

const expandHome = (path) => (path === '~' || path.startsWith('~/') ? join(homedir(), path.slice(1)) : path);

// Commands from the text and from quoted text inside it (sh -c '...').
function allCommands(command, depth = 0) {
  const { commands, nested } = parseShell(command);
  if (depth >= MAX_NESTING) return commands;
  return [...commands, ...nested.flatMap(({ text }) => allCommands(text, depth + 1))];
}

function skipQuoted(command, i) {
  const quote = command[i];
  let j = i + 1;
  while (j < command.length && command[j] !== quote) j += quote === '"' && command[j] === '\\' ? 2 : 1;
  return j;
}

// Splits at top-level list operators (&&, ||, ;, newline, |, &), outside
// quotes, backticks and parentheses. Each part keeps the operator before and after it.
function topLevelParts(command) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let before = null;
  for (let i = 0; i < command.length; i++) {
    const c = command[i];
    if (c === "'" || c === '"' || c === '`') {
      i = skipQuoted(command, i);
      continue;
    }
    if (c === '\\') {
      i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (depth > 0) continue;
    let op = null;
    if (command.startsWith('&&', i) || command.startsWith('||', i)) op = command.slice(i, i + 2);
    else if (c === '&' && /[<>]/.test(command[i - 1] ?? '')) op = null;
    else if (c === '&' && command[i + 1] === '>') op = null;
    else if (';\n|&'.includes(c)) op = c;
    if (!op) continue;
    parts.push({ text: command.slice(start, i), before, after: op });
    before = op;
    i += op.length - 1;
    start = i + 1;
  }
  parts.push({ text: command.slice(start), before, after: null });
  return parts;
}

// cd, pushd, builtin cd and popd: the argument words, or null for other commands.
function cdArgs(tokens) {
  if (tokens[0] === 'builtin' && tokens[1] === 'cd') return tokens.slice(2);
  if (tokens[0] === 'cd' || tokens[0] === 'pushd') return tokens.slice(1);
  if (tokens[0] === 'popd') return ['-'];
  return null;
}

// The directory a cd goes to, or null when it cannot be resolved ($VAR,
// `cd -`, a stack entry, ~user).
function cdTarget(args, dir) {
  let i = 0;
  while (['-P', '-L', '-e', '-@'].includes(args[i])) i++;
  if (args[i] === '--') i++;
  const arg = args[i];
  if (arg === undefined) return homedir();
  if (arg.startsWith('-') || arg.startsWith('+') || arg.includes('$') || arg.includes('`') || /^~[^/]/.test(arg)) return null;
  return resolve(dir, expandHome(arg));
}

const LIST_START = new Set([null, ';', '\n', '&']);
const FOLLOW_BEFORE = new Set([null, ';', '\n', '&', '&&']);

// Each command with the directories it may run in. A cd is followed only when
// it is an unconditional top-level command joined by && or ; (not in a
// subshell, a pipeline, after ||, or backgrounded). Any other cd makes the
// directory uncertain: then every command is checked against the original
// cwd and every cd target. unresolved: some cd target is unknown.
function commandsWithDirs(command, cwd) {
  const start = resolve(cwd);
  let dir = start;
  let uncertain = false;
  let unresolved = false;
  let afterOr = false;
  const targets = [];
  const out = [];
  for (const part of topLevelParts(command)) {
    if (LIST_START.has(part.before)) afterOr = false;
    if (part.before === '||') afterOr = true;
    const commands = allCommands(part.text);
    const trimmed = part.text.trim();
    const followable = !afterOr && FOLLOW_BEFORE.has(part.before) && !['|', '&'].includes(part.after) &&
      commands.length === 1 && !trimmed.startsWith('(') && !trimmed.startsWith('{');
    for (const tokens of commands) {
      const args = cdArgs(tokens);
      if (args === null) {
        out.push({ tokens, dir });
        continue;
      }
      const target = cdTarget(args, dir);
      if (!target) {
        uncertain = true;
        unresolved = true;
      } else if (followable) {
        dir = target;
        targets.push(target);
      } else {
        uncertain = true;
        targets.push(target);
      }
    }
  }
  const union = [...new Set([start, ...targets, ...out.map((o) => o.dir)])];
  return {
    unresolved,
    commands: out.map(({ tokens, dir: at }) => ({ tokens, dirs: uncertain ? [...new Set([at, ...union])] : [at] })),
  };
}

// Index of the command word after assignments and prefix commands (with
// their options and values).
function headIndex(tokens) {
  let i = 0;
  for (;;) {
    while (i < tokens.length && ASSIGNMENT.test(tokens[i])) i++;
    const name = tokens[i] === undefined ? '' : basename(tokens[i]);
    if (!PREFIX_HEADS.has(name)) return i;
    const valued = new Set(PREFIX_VALUE_OPTIONS[name]);
    i++;
    while (i < tokens.length && tokens[i].startsWith('-')) {
      if (tokens[i] === '--') {
        i++;
        break;
      }
      i += valued.has(tokens[i]) ? 2 : 1;
    }
    if (name === 'timeout') i++;
  }
}

// Path candidates in a word: redirections (<file, 2>file) and --opt=file.
function wordPaths(word) {
  const bare = word.replace(REDIRECT_PREFIX, '');
  const eq = bare.indexOf('=');
  return (eq >= 0 ? [bare, bare.slice(eq + 1)] : [bare]).filter((p) => p !== '' && !p.startsWith('$'));
}

// Every path a command mentions, resolved in each directory it may run in:
// the guard reads the index of the project that owns each one.
export function bashPaths(command, cwd) {
  return commandsWithDirs(command, cwd).commands.flatMap(({ tokens, dirs }) => tokens
    .flatMap(wordPaths)
    .filter((word) => !word.startsWith('-'))
    .flatMap((word) => dirs.map((dir) => resolve(dir, expandHome(word)))));
}

const realOrNull = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

const OWN_CLI = new Set([join(PLUGIN_ROOT, 'bin', 'claudeflare'), join(PLUGIN_ROOT, 'scripts', 'cf.mjs')].map(realOrNull).filter(Boolean));

// This plugin's own bin/claudeflare or scripts/cf.mjs, by realpath. A bare
// `claudeflare` counts only when it resolves on PATH to one of them.
function isOwnCli(word, dir) {
  if (!word) return false;
  if (word.includes('/')) return OWN_CLI.has(realOrNull(resolve(dir, expandHome(word))));
  if (word !== 'claudeflare') return false;
  for (const entry of (process.env.PATH ?? '').split(delimiter)) {
    if (entry && existsSync(join(entry, word))) return OWN_CLI.has(realOrNull(join(entry, word)));
  }
  return false;
}

// claudeflare tunnel-token: only the --env-path value.
function cliExempt(tokens, dirs) {
  const own = (word) => dirs.every((dir) => isOwnCli(word, dir));
  const at = own(tokens[0]) ? 0 : tokens[0] === 'node' && own(tokens[1]) ? 1 : -1;
  if (at < 0 || tokens[at + 1] !== 'tunnel-token') return NONE;
  const exempt = new Set();
  tokens.forEach((token, i) => {
    if (i > at + 1 && token === '--env-path') exempt.add(i + 1);
  });
  return exempt;
}

// git add|rm [safe flags] [--] PATHS: only the pathspecs. No global options
// (the subcommand must come right after git), no -p or other flags.
function gitExempt(tokens) {
  if (!GIT_PATH_COMMANDS.has(tokens[1])) return NONE;
  const exempt = new Set();
  let paths = false;
  for (let i = 2; i < tokens.length; i++) {
    if (!paths && tokens[i] === '--') paths = true;
    else if (!paths && tokens[i].startsWith('-')) {
      if (!GIT_SAFE_FLAGS.has(tokens[i])) return NONE;
    } else exempt.add(i);
  }
  return exempt;
}

// docker|podman compose [-f F]... [-p P] --env-file P (up -d|up --detach|down|
// restart|stop|pull) [SERVICE]...: only the --env-file values.
function composeExempt(tokens) {
  const exempt = new Set();
  let i = 2;
  for (; i < tokens.length; i++) {
    const token = tokens[i];
    if (['-f', '--file', '-p', '--project-name'].includes(token)) i++;
    else if (token === '--env-file') exempt.add(++i);
    else if (token.startsWith('--env-file=')) exempt.add(i);
    else break;
  }
  let rest = tokens.slice(i + 1);
  if (tokens[i] === 'up') {
    if (!['-d', '--detach'].includes(rest[0])) return NONE;
    rest = rest.slice(1);
  } else if (!COMPOSE_SUBCOMMANDS.has(tokens[i])) return NONE;
  return rest.every((word) => !word.startsWith('-')) ? exempt : NONE;
}

// docker|podman run -d|--detach [simple options] --env-file P IMAGE, nothing
// after IMAGE: only the --env-file values.
function runExempt(tokens) {
  const exempt = new Set();
  let detached = false;
  let i = 2;
  for (; i < tokens.length && tokens[i].startsWith('-'); i++) {
    const token = tokens[i];
    if (token === '-d' || token === '--detach') detached = true;
    else if (token === '--env-file') exempt.add(++i);
    else if (token.startsWith('--env-file=')) exempt.add(i);
    else if (RUN_VALUE_OPTIONS.has(token)) i++;
    else if (token !== '--rm' && !RUN_VALUE_INLINE.test(token)) return NONE;
  }
  return detached && i === tokens.length - 1 ? exempt : NONE;
}

// Ruling 14: the token indexes a command may name without being denied.
// Exact shapes only; a prefix head or env assignment means none.
function exemptTokens(tokens, dirs) {
  const head = tokens[0];
  if (head === undefined || ASSIGNMENT.test(head) || PREFIX_HEADS.has(basename(head))) return NONE;
  if (PLAIN_CONSUMERS.has(head)) return new Set([...tokens.keys()].filter((i) => i > 0 && !tokens[i].startsWith('-')));
  if (head === 'git') return gitExempt(tokens);
  if (head === 'docker' || head === 'podman') {
    if (tokens[1] === 'compose') return composeExempt(tokens);
    if (tokens[1] === 'run') return runExempt(tokens);
    return NONE;
  }
  return cliExempt(tokens, dirs);
}

// Recursive search commands

// Splits arguments into options ({ name, value }) and positionals. shortValue
// lists the short options that take a value; longValue the long ones.
function scanArgs(args, shortValue, longValue) {
  const opts = [];
  const positionals = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      const name = eq >= 0 ? arg.slice(2, eq) : arg.slice(2);
      let value = eq >= 0 ? arg.slice(eq + 1) : null;
      if (value === null && longValue.has(name)) value = args[++i] ?? '';
      opts.push({ name, value });
    } else if (arg.startsWith('-') && arg.length > 1) {
      for (let j = 1; j < arg.length; j++) {
        if (shortValue.includes(arg[j])) {
          const rest = arg.slice(j + 1);
          opts.push({ name: arg[j], value: rest !== '' ? rest : args[++i] ?? '' });
          break;
        }
        opts.push({ name: arg[j], value: null });
      }
    } else {
      positionals.push(arg);
    }
  }
  return { opts, positionals };
}

const has = (opts, ...names) => opts.some((o) => names.includes(o.name));
const values = (opts, ...names) => opts.filter((o) => names.includes(o.name)).map((o) => o.value);

const GREP_LONG = new Set(['regexp', 'file', 'include', 'exclude', 'exclude-dir', 'exclude-from', 'max-count', 'after-context', 'before-context', 'context', 'directories', 'devices', 'label', 'binary-files', 'color', 'colour']);
const RG_LONG = new Set([
  'regexp', 'file', 'glob', 'iglob', 'type', 'type-not', 'type-add', 'type-clear', 'after-context', 'before-context', 'context', 'max-count',
  'max-depth', 'max-columns', 'max-filesize', 'threads', 'encoding', 'replace', 'sort', 'sortr', 'colors', 'context-separator',
  'field-match-separator', 'field-context-separator', 'path-separator', 'pre', 'pre-glob', 'engine', 'ignore-file', 'dfa-size-limit', 'regex-size-limit',
]);
const AG_LONG = new Set(['file-search-regex', 'ignore', 'ignore-dir', 'after', 'before', 'context', 'max-count', 'depth', 'pager']);
const ACK_LONG = new Set(['type', 'type-set', 'type-add', 'ignore-dir', 'ignore-file', 'after-context', 'before-context', 'context', 'max-count']);
const GIT_GREP_LONG = new Set(['regexp', 'file', 'after-context', 'before-context', 'context', 'max-count', 'max-depth', 'threads']);
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir']);
// find operators the guard does not model: with any of them, -name filters
// prove nothing and the expression can match every file.
const FIND_UNMODELED = new Set(['-o', '-or', ',', '-path', '-wholename', '-ipath', '-iwholename', '-regex', '-iregex', '-not', '!', '(', ')', '-prune', '-lname', '-ilname']);

// Pattern first unless given with -e/-f; the rest are roots (cwd by default).
function grepLike(args, shortValue, longValue, dir) {
  const { opts, positionals } = scanArgs(args, shortValue, longValue);
  const patternGiven = has(opts, 'e', 'f', 'regexp', 'file');
  const paths = patternGiven ? positionals : positionals.slice(1);
  return { opts, paths: paths.map((p) => resolve(dir, expandHome(p))) };
}

function withDefault(roots, dir) {
  return roots.length ? roots : [dir];
}

function findSearch(args, dir) {
  const exec = args.findIndex((a, i) => FIND_EXEC.has(a) && args[i + 1] !== undefined &&
    (READ_VERBS.has(basename(args[i + 1])) || SHELLS.has(basename(args[i + 1]))));
  if (exec < 0) return null;
  let i = 0;
  while (['-H', '-L', '-P'].includes(args[i]) || /^-O\d*$/.test(args[i] ?? '')) i++;
  const roots = [];
  while (i < args.length && !args[i].startsWith('-') && !FIND_UNMODELED.has(args[i])) roots.push(resolve(dir, expandHome(args[i++])));
  // Only the expression before -exec filters which files reach it.
  const expression = args.slice(i, exec);
  const modeled = !expression.some((a) => FIND_UNMODELED.has(a));
  const globs = modeled ? expression.flatMap((a, j) => (a === '-name' || a === '-iname' ? [expression[j + 1] ?? ''] : [])) : [];
  return { roots: withDefault(roots, dir), globs };
}

// Returns { roots, globs } for a command that reads file contents under a
// directory tree, or null. globs are include filters; only filters the guard
// fully models can exclude a file.
function searchOf(tokens, dir) {
  const at = headIndex(tokens);
  const head = tokens[at] === undefined ? '' : basename(tokens[at]);
  const args = tokens.slice(at + 1);
  if (['grep', 'egrep', 'fgrep'].includes(head)) {
    const { opts, paths } = grepLike(args, 'efmABCdD', GREP_LONG, dir);
    const recursive = has(opts, 'r', 'R', 'recursive', 'dereference-recursive') ||
      opts.some((o) => ['d', 'directories'].includes(o.name) && o.value === 'recurse');
    return recursive ? { roots: withDefault(paths, dir), globs: values(opts, 'include') } : null;
  }
  if (head === 'rg') {
    const { opts, paths } = grepLike(args, 'efgtTABCmMjEdr', RG_LONG, dir);
    return { roots: withDefault(paths, dir), globs: values(opts, 'g', 'glob', 'iglob') };
  }
  if (head === 'ag') return { roots: withDefault(grepLike(args, 'ABCGgm', AG_LONG, dir).paths, dir), globs: [] };
  if (head === 'ack') return { roots: withDefault(grepLike(args, 'ABCm', ACK_LONG, dir).paths, dir), globs: [] };
  if (head === 'git' && args[0] === 'grep') {
    const { opts, positionals } = scanArgs(args.slice(1), 'efABCm', GIT_GREP_LONG);
    const specs = has(opts, 'e', 'f', 'regexp', 'file') ? positionals : positionals.slice(1);
    // Pathspec magic (:!x, :(glob)x) is not modeled: it can match anything.
    const globs = specs.filter((s) => /[*?[]/.test(s) || s.startsWith(':')).map((s) => (s.startsWith(':') ? '!' : s));
    const roots = specs.filter((s) => !/[*?[]/.test(s) && !s.startsWith(':')).map((s) => resolve(dir, expandHome(s)));
    return { roots: withDefault(roots, dir), globs };
  }
  if (head === 'find') return findSearch(args, dir);
  return null;
}

function searchReaches(search, files, isInside) {
  return files.some((file) => search.roots.some((root) => isInside(root, file)) &&
    !(search.globs.length && search.globs.every((glob) => globExcludes(glob, basename(file)))));
}

function inSecretsDir(canonicalPath) {
  const parts = canonicalPath.split(sep);
  return parts.some((part, i) => part === '.claudeflare' && parts[i + 1] === 'secrets');
}

const namesSecret = (word, names) => wordPaths(word).some((path) => names.has(basename(path).toLowerCase()));

// Glob words: the shell expands them before the command sees them, so the
// guard tests the pattern itself against the indexed files (never the disk).
// `*` and `?` stay inside one path segment (dot files included: fail
// closed), `**` crosses segments, a class is any one character and a brace
// list ({a,b}, {1..3}) anything. A segment with an extglob or alternation
// character (`(`, `|`, `^`, `~`) is not modeled: it matches any name.
const GLOB_WORD = /[*?[(|^~]|\{[^}]*(?:,|\.\.)[^}]*\}/;
const UNMODELED_SEGMENT = /[(|^~]/;

function globSource(pattern) {
  if (pattern.includes('/')) return pattern.split('/').map(globSource).join('/');
  if (UNMODELED_SEGMENT.test(pattern)) return '[^/]*';
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        out += '.*';
        i++;
      } else out += '[^/]*';
    } else if (c === '?') out += '[^/]';
    else if (c === '[' && pattern.indexOf(']', i + 2) >= 0) {
      out += '[^/]';
      i = pattern.indexOf(']', i + 2);
    } else if (c === '{' && /^\{[^}]*(?:,|\.\.)[^}]*\}/.test(pattern.slice(i))) {
      out += '.*';
      i = pattern.indexOf('}', i);
    } else out += c.replace(/[.+^$()|\\[\]{}]/g, '\\$&');
  }
  return out;
}

// True when the glob path, resolved in dir, can name one of files. Only the
// static directory part is canonicalized (it may not exist yet for the rest).
function globReaches(candidate, dir, files, canonical) {
  const parts = resolve(dir, expandHome(candidate)).split(sep);
  const first = parts.findIndex((part) => GLOB_WORD.test(part));
  if (first < 0) return false;
  const prefix = canonical(parts.slice(0, first).join(sep) || sep);
  const source = `${prefix === sep ? '' : prefix.replace(/[.+^$()|\\[\]{}*?]/g, '\\$&')}/${globSource(parts.slice(first).join('/'))}`;
  const pattern = new RegExp(`^${source}$`, CASE_INSENSITIVE_FS ? 'i' : '');
  return files.some((file) => pattern.test(file));
}

// git show <rev>:<path> and git cat-file <type> <rev>:<path> print a file from
// the object store, which may hold a committed secret: the path part of each
// <rev>:<path> word, or [] for other commands.
const GIT_OBJECT_COMMANDS = new Set(['show', 'cat-file']);
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace']);

function gitObjectPaths(tokens) {
  const at = headIndex(tokens);
  if (basename(tokens[at] ?? '') !== 'git') return [];
  let i = at + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i += GIT_VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
  if (!GIT_OBJECT_COMMANDS.has(tokens[i])) return [];
  return tokens.slice(i + 1).filter((w) => !w.startsWith('-') && w.includes(':')).map((w) => w.slice(w.indexOf(':') + 1)).filter(Boolean);
}

// Words glued to a parenthesis (extglob `@(x)`, `!(x)`, alternation
// `dir/(a|b)`), not `$(`, `<(` or `>(`.
function parenWords(command) {
  return [...command.matchAll(/([^\s;&|()<>$'"`]+)\(([^()]*)\)([^\s;&|()]*)/g)].map((m) => `${m[1]}(${m[2]})${m[3]}`);
}

// git cat-file --batch* reads object names from stdin, git archive packs a
// whole tree: either can print a committed secret file.
function gitDumpsObjects(tokens) {
  const at = headIndex(tokens);
  if (basename(tokens[at] ?? '') !== 'git') return false;
  let i = at + 1;
  while (i < tokens.length && tokens[i].startsWith('-')) i += GIT_VALUE_OPTIONS.has(tokens[i]) ? 2 : 1;
  if (tokens[i] === 'archive') return true;
  return tokens[i] === 'cat-file' && tokens.slice(i + 1).some((w) => w.startsWith('--batch'));
}

// docker|podman compose config prints the interpolated .env compose reads
// implicitly; docker|podman inspect prints a container's environment.
function dumpsContainerEnv(tokens) {
  const at = headIndex(tokens);
  const head = basename(tokens[at] ?? '');
  const args = tokens.slice(at + 1);
  if (head === 'docker-compose' || head === 'podman-compose') return args.includes('config');
  if (head !== 'docker' && head !== 'podman') return false;
  return (args.includes('compose') && args.includes('config')) || args.includes('inspect');
}

// The project a command runs in holds indexed secret files.
function projectHasSecrets(dirs, files, isInside) {
  return dirs.some((dir) => {
    const root = claudeflareRoot(dir) ?? dir;
    return files.some((file) => isInside(root, file));
  });
}

// Deny by default: a command that names a secret file or the secrets folder
// (as an argument, a redirection, inside $(...), backticks or sh -c) is
// denied unless the argument is exempt under one of the exact consumer shapes
// (exemptTokens). files: canonical absolute paths; rawFiles: as indexed.
// canonical and isInside: the guard's path helpers.
export function bashReadsSecret(command, cwd, { files, rawFiles = [] }, { canonical, isInside }) {
  const fold = (text) => (CASE_INSENSITIVE_FS ? text.toLowerCase() : text);
  const absolutes = [...new Set([...files, ...rawFiles.map(fold)])];
  // Names compare case-insensitively: when unsure, match (deny).
  const names = new Set(files.map((file) => basename(file).toLowerCase()));
  const { commands, unresolved } = commandsWithDirs(command, cwd);
  // The shell parser reads `dir/@(...)` and `dir/(a|b)` as a word plus a
  // subshell; rebuild those words from the text and test them as globs.
  const allDirs = [...new Set([resolve(cwd), ...commands.flatMap((c) => c.dirs)])];
  if (parenWords(command).some((word) => allDirs.some((dir) => globReaches(word, dir, absolutes, canonical)))) return true;
  // An unknown cd target: any word naming a secret file by its name is denied.
  if (unresolved && names.size && commands.some(({ tokens }) => tokens.some((word) => namesSecret(word, names)))) return true;
  for (const { tokens, dirs } of commands) {
    const exempt = exemptTokens(tokens, dirs);
    const text = fold(tokens.filter((_, i) => !exempt.has(i)).join(' '));
    if (text.includes(SECRETS_TEXT) || absolutes.some((file) => text.includes(file))) return true;
    const head = tokens[headIndex(tokens)];
    const verb = head !== undefined && READ_VERBS.has(basename(head));
    for (const [i, word] of tokens.entries()) {
      if (exempt.has(i)) continue;
      if (verb && namesSecret(word, names)) return true;
      for (const candidate of wordPaths(word)) {
        for (const dir of dirs) {
          const path = canonical(resolve(dir, expandHome(candidate)));
          if (files.includes(path) || inSecretsDir(path)) return true;
          if (GLOB_WORD.test(candidate) && globReaches(candidate, dir, absolutes, canonical)) return true;
        }
      }
    }
    // A <rev>:<path> word counts by its name, like a read verb's argument.
    if (gitObjectPaths(tokens).some((path) => namesSecret(path, names) || dirs.some((dir) => files.includes(canonical(resolve(dir, path)))))) return true;
    if ((dumpsContainerEnv(tokens) || gitDumpsObjects(tokens)) && projectHasSecrets(dirs, files, isInside)) return true;
    for (const dir of dirs) {
      const search = searchOf(tokens, dir);
      if (search && searchReaches(search, files, isInside)) return true;
    }
  }
  return false;
}

// cloudflared

const isLiteral = (value) => typeof value === 'string' && value !== '' && !value.startsWith('$');

function cloudflaredLiteral(tokens) {
  const at = tokens.findIndex((t) => CLOUDFLARED.test(t));
  if (at < 0) {
    // export TUNNEL_TOKEN=eyJ... before a later cloudflared run.
    return tokens[0] === 'export' && tokens.some((t) => isLiteral(TOKEN_ASSIGNMENT.exec(t)?.[1]));
  }
  // TUNNEL_TOKEN=eyJ... cloudflared ..., docker run -e TUNNEL_TOKEN=eyJ... cloudflare/cloudflared
  if (tokens.slice(0, at).some((t) => isLiteral(TOKEN_ASSIGNMENT.exec(t)?.[1]))) return true;
  const args = tokens.slice(at + 1);
  for (let i = 0; i < args.length; i++) {
    if (TOKEN_FLAG.test(args[i]) && isLiteral(args[i + 1])) return true;
    if (isLiteral(TOKEN_FLAG_VALUE.exec(args[i])?.[1])) return true;
  }
  const service = args.indexOf('service');
  if (service >= 0 && args[service + 1] === 'install') {
    return args.slice(service + 2).some((a) => !a.startsWith('-') && isLiteral(a));
  }
  return false;
}

// cloudflared tunnel [options] token <name> prints the token; --cred-file
// can name /dev/stdout or a file the model reads next, so it is denied too.
// `claudeflare tunnel-token` is the way to get a token.
function cloudflaredPrintsToken(tokens) {
  const at = tokens.findIndex((t) => CLOUDFLARED.test(t));
  if (at < 0) return false;
  const args = tokens.slice(at + 1);
  const tunnel = args.indexOf('tunnel');
  if (tunnel < 0) return false;
  return args.slice(tunnel + 1).includes('token');
}

// Token endpoint reads in a shell command, after the shell would have removed
// quotes and backslashes: a token resource and a /token segment anywhere in
// the command, a Cloudflare API read whose path ends in /token after a
// variable ($P/token: fail closed), or cloudflared printing a token.
const TOKEN_RESOURCE_TEXT = new RegExp(TOKEN_RESOURCES.map((r) => (r === 'tunnels' ? '/tunnels\\b' : r)).join('|'));
const TOKEN_SEGMENT_TEXT = /\/token(?![\w-])/;
const CF_API_READ_TEXT = /api\.cloudflare\.com|(?:^|[\s/;&|(])(?:claudeflare|cf\.mjs)\s+get\b/;
const VARIABLE_TOKEN_TEXT = /[$`)}][^\s;&|]*\/token(?![\w-])/;
const RUNTIME_BUILT_TEXT = /\$\(|`|\{[^}\s]*,[^}\s]*\}/;
const DECODE_ROUNDS = 3;

function shellText(command) {
  let text = command.replace(/['"\\]/g, '');
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = text.replace(/%[0-9a-f]{2}/gi, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16))).replace(/[\t\n\r]/g, '');
    if (next === text) break;
    text = next;
  }
  return text.toLowerCase().replace(/\/{2,}/g, '/');
}

export function readsTunnelToken(command) {
  const text = shellText(command);
  if (TOKEN_RESOURCE_TEXT.test(text) && TOKEN_SEGMENT_TEXT.test(text)) return true;
  if (CF_API_READ_TEXT.test(text) && VARIABLE_TOKEN_TEXT.test(text)) return true;
  // A token resource read whose path is built at run time ($(...), backticks, {a,b}).
  if (CF_API_READ_TEXT.test(text) && TOKEN_RESOURCE_TEXT.test(text) && RUNTIME_BUILT_TEXT.test(text)) return true;
  if (!text.includes('cloudflared')) return false;
  return allCommands(command).some(cloudflaredPrintsToken);
}

// Returns the deny reason, or null.
export function decideCloudflared(command) {
  if (!command.includes('cloudflared') && !command.includes('TUNNEL_TOKEN')) return null;
  return allCommands(command).some(cloudflaredLiteral) ? CLOUDFLARED_REASON : null;
}
