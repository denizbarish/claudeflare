// Secret files and tunnel tokens: claudeflare writes credentials to disk
// (.claudeflare/secrets/*, env files from `claudeflare tunnel-token`) and lists
// them in .claudeflare/secret-files.json and in the per-user index next to
// the approval key. These rules keep the agent from reading them back and
// from putting a literal tunnel token on a cloudflared command line. Same
// threat model as the rest of the guard: string checks catch model mistakes,
// not deliberate evasion.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { keyDir } from '../../scripts/lib/approval-key.mjs';
import { STATE_DIR, claudeflareRoot } from '../../scripts/lib/project-root.mjs';
import { parseShell } from './wrangler-rules.mjs';

export const SECRET_REASON =
  'This file holds a credential written by claudeflare and must not be read into the conversation. Let the program that needs it read it (for example cloudflared reading TUNNEL_TOKEN from the environment).';
export const TUNNEL_TOKEN_REASON =
  'Tunnel tokens are never read into the conversation. Run "claudeflare tunnel-token --account <id> --tunnel <id> --env-path <path>" to write the token into an env file without showing it.';
export const CLOUDFLARED_REASON =
  'A literal tunnel token on a cloudflared command line ends up in the transcript and shell history. Write it with "claudeflare tunnel-token" and let cloudflared read TUNNEL_TOKEN from the environment or use --token-file.';

const INDEX_FILE = 'secret-files.json';
const SECRETS_TEXT = '.claudeflare/secrets';
const CASE_INSENSITIVE_FS = process.platform === 'darwin' || process.platform === 'win32';
// Commands that print a file: with one of these as the head, a secret file's
// bare name is enough to deny (the guard cannot follow every cd).
const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk', 'cp', 'mv', 'base64', 'xxd', 'od', 'strings', 'source', '.']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// Programs that consume a secret file without printing it. Everything else
// that names a secret path is denied.
const CONSUMERS = new Set(['cloudflared', 'systemctl', 'chmod', 'chown', 'ls', 'stat', 'test', '[', 'rm']);
const GIT_CONSUMERS = new Set(['add', 'rm', 'status', 'check-ignore', 'ls-files']);
const CONTAINER_TOOLS = new Set(['docker', 'docker-compose', 'podman']);
// Words that run the next word as the command.
const PREFIX_HEADS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const REDIRECT_PREFIX = /^\d*[<>]+&?/;
const TOKEN_ASSIGNMENT = /^TUNNEL_TOKEN=(.*)$/;
const TOKEN_FLAG = /^--?token$/;
const TOKEN_FLAG_VALUE = /^--?token=(.*)$/;
const CLOUDFLARED = /(?:^|\/)cloudflared(?::[^/\s]*)?$/;
const MAX_NESTING = 3;

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

function cdTarget(tokens, dir) {
  const arg = tokens[1];
  if (arg === undefined) return homedir();
  if (arg.startsWith('-') || arg.includes('$') || arg.includes('`')) return null;
  return resolve(dir, expandHome(arg));
}

const LIST_START = new Set([null, ';', '\n', '&']);
const FOLLOW_BEFORE = new Set([null, ';', '\n', '&', '&&']);

// Each command with the directories it may run in. A cd is followed only when
// it is an unconditional top-level command joined by && or ; (not in a
// subshell, a pipeline, after ||, or backgrounded). Any other cd makes the
// directory uncertain: then every command is checked against the original
// cwd and every cd target.
function commandsWithDirs(command, cwd) {
  const start = resolve(cwd);
  let dir = start;
  let uncertain = false;
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
      if (tokens[0] !== 'cd') {
        out.push({ tokens, dir });
        continue;
      }
      const target = cdTarget(tokens, dir);
      if (followable && target) {
        dir = target;
        targets.push(target);
      } else {
        uncertain = true;
        if (target) targets.push(target);
      }
    }
  }
  const union = [...new Set([start, ...targets, ...out.map((o) => o.dir)])];
  return out.map(({ tokens, dir: at }) => ({ tokens, dirs: uncertain ? [...new Set([at, ...union])] : [at] }));
}

function headIndex(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || PREFIX_HEADS.has(tokens[i]) || tokens[i].startsWith('-'))) i++;
  return i;
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
  return commandsWithDirs(command, cwd).flatMap(({ tokens, dirs }) => tokens
    .flatMap(wordPaths)
    .filter((word) => !word.startsWith('-'))
    .flatMap((word) => dirs.map((dir) => resolve(dir, expandHome(word)))));
}

function isClaudeflare(word) {
  return word !== undefined && (basename(word) === 'claudeflare' || word.endsWith('cf.mjs'));
}

// Which tokens of a command a consumer program takes without printing:
// 'all', a set of token indexes (docker --env-file values) or none.
function consumedTokens(tokens) {
  const at = headIndex(tokens);
  const head = tokens[at];
  if (head === undefined) return new Set();
  const name = basename(head);
  if (CONSUMERS.has(name) || CLOUDFLARED.test(head)) return 'all';
  const args = tokens.slice(at + 1);
  if (name === 'git') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c'].includes(args[i]) ? 2 : 1;
    return GIT_CONSUMERS.has(args[i]) ? 'all' : new Set();
  }
  const cli = isClaudeflare(head) ? 0 : name === 'node' && isClaudeflare(args[0]) ? 1 : -1;
  if (cli >= 0) return args[cli] === 'tunnel-token' ? 'all' : new Set();
  if (CONTAINER_TOOLS.has(name)) {
    const allowed = new Set();
    tokens.forEach((token, i) => {
      if (token === '--env-file') allowed.add(i + 1);
      if (token.startsWith('--env-file=')) allowed.add(i);
    });
    return allowed;
  }
  return new Set();
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

// Deny by default: a command that names a secret file or the secrets folder
// (as an argument, a redirection, inside $(...), backticks or sh -c) is
// denied unless its program only consumes the file (CONSUMERS, git add/rm/
// status/check-ignore/ls-files, docker/podman --env-file, claudeflare
// tunnel-token). files: canonical absolute paths; rawFiles: as indexed.
// canonical and isInside: the guard's path helpers.
export function bashReadsSecret(command, cwd, { files, rawFiles = [] }, { canonical, isInside }) {
  const fold = (text) => (CASE_INSENSITIVE_FS ? text.toLowerCase() : text);
  const absolutes = [...new Set([...files, ...rawFiles.map(fold)])];
  // Names compare case-insensitively: when unsure, match (deny).
  const names = new Set(files.map((file) => basename(file).toLowerCase()));
  for (const { tokens, dirs } of commandsWithDirs(command, cwd)) {
    const consumed = consumedTokens(tokens);
    if (consumed !== 'all') {
      const text = fold(tokens.filter((_, i) => !consumed.has(i)).join(' '));
      if (text.includes(SECRETS_TEXT) || absolutes.some((file) => text.includes(file))) return true;
      const head = tokens[headIndex(tokens)];
      const verb = head !== undefined && READ_VERBS.has(basename(head));
      for (const [i, word] of tokens.entries()) {
        if (consumed.has(i)) continue;
        for (const candidate of wordPaths(word)) {
          if (verb && names.has(basename(candidate).toLowerCase())) return true;
          for (const dir of dirs) {
            const path = canonical(resolve(dir, expandHome(candidate)));
            if (files.includes(path) || inSecretsDir(path)) return true;
          }
        }
      }
    }
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

// Returns the deny reason, or null.
export function decideCloudflared(command) {
  if (!command.includes('cloudflared') && !command.includes('TUNNEL_TOKEN')) return null;
  return allCommands(command).some(cloudflaredLiteral) ? CLOUDFLARED_REASON : null;
}
