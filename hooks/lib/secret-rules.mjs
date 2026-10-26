// Secret files and tunnel tokens: claudeflare writes credentials to disk
// (.claudeflare/secrets/*, env files from `claudeflare tunnel-token`) and lists
// them in .claudeflare/secret-files.json. These rules keep the agent from
// reading them back and from putting a literal tunnel token on a cloudflared
// command line. Same threat model as the rest of the guard: string checks
// catch model mistakes, not deliberate evasion.
import { readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve } from 'node:path';
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
const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk', 'cp', 'mv', 'base64', 'xxd', 'od', 'strings', 'source', '.']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash']);
// Words that run the next word as the command.
const PREFIX_HEADS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const INPUT_REDIRECT = /^\d*<$/;
const INPUT_REDIRECT_PATH = /^\d*<([^<(&].*)$/;
const TOKEN_ASSIGNMENT = /^TUNNEL_TOKEN=(.*)$/;
const TOKEN_FLAG = /^--?token$/;
const TOKEN_FLAG_VALUE = /^--?token=(.*)$/;
const CLOUDFLARED = /(?:^|\/)cloudflared(?::[^/\s]*)?$/;
const MAX_NESTING = 3;

// Secret files

function readIndex(root) {
  try {
    const index = JSON.parse(readFileSync(join(root, STATE_DIR, INDEX_FILE), 'utf8'));
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

// Secret files of the session cwd and of the projects that own cwd and each
// target (nearest ancestor holding .claudeflare): the index plus whatever
// sits in the secrets folder. Missing or invalid files count as empty.
export function secretFilesFor(cwd, targets = []) {
  const roots = new Set([resolve(cwd)]);
  for (const start of [cwd, ...targets]) {
    const root = claudeflareRoot(start);
    if (root) roots.add(root);
  }
  return [...new Set([...roots].flatMap((root) => [...readIndex(root), ...secretsDirFiles(root)]))];
}

// True only for a positive glob the guard fully models (literal characters,
// `*`, `?`, leading directory parts) whose last segment cannot match name.
// Anything else (`!`, braces, classes, `**` in the last segment) can match.
export function globExcludes(glob, name) {
  if (typeof glob !== 'string' || glob === '' || glob.startsWith('!') || /[{}[\]\\]/.test(glob)) return false;
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

// Each command with the directory it runs in, following `cd`.
function commandsWithDir(command, cwd) {
  let dir = resolve(cwd);
  const out = [];
  for (const tokens of allCommands(command)) {
    if (tokens[0] === 'cd') dir = resolve(dir, expandHome(tokens[1] ?? homedir()));
    else out.push({ tokens, dir });
  }
  return out;
}

function headIndex(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || PREFIX_HEADS.has(tokens[i]) || tokens[i].startsWith('-'))) i++;
  return i;
}

// Path candidates in a word: --opt=file gives both forms.
function wordPaths(word) {
  const eq = word.indexOf('=');
  return eq >= 0 ? [word, word.slice(eq + 1)] : [word];
}

// Files read through `< file`, `2<file` and `$(<file)`.
function redirectedPaths(tokens) {
  const out = [];
  tokens.forEach((token, i) => {
    if (INPUT_REDIRECT.test(token) && tokens[i + 1] !== undefined) out.push(tokens[i + 1]);
    const attached = INPUT_REDIRECT_PATH.exec(token);
    if (attached) out.push(attached[1]);
  });
  return out;
}

// Every path a command mentions, resolved: the guard reads the index of the
// project that owns each one.
export function bashPaths(command, cwd) {
  return commandsWithDir(command, cwd).flatMap(({ tokens, dir }) => tokens
    .flatMap(wordPaths)
    .map((word) => word.replace(/^\d*[<>]+/, ''))
    .filter((word) => word !== '' && !word.startsWith('-') && !word.startsWith('$'))
    .map((word) => resolve(dir, expandHome(word))));
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
const FIND_NEGATION = new Set(['!', '-not']);

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
  while (i < args.length && !args[i].startsWith('-') && args[i] !== '(' && !FIND_NEGATION.has(args[i])) roots.push(resolve(dir, expandHome(args[i++])));
  const negated = args.some((a) => FIND_NEGATION.has(a));
  const globs = negated ? [] : args.flatMap((a, j) => (a === '-name' || a === '-iname' ? [args[j + 1] ?? ''] : []));
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

// files: canonical absolute paths. canonical and isInside: the guard's path
// helpers. A secret path is denied under a read verb or an input redirection
// (a program handed the file, such as docker --env-file or git add, may use
// it); a recursive search is denied when its root holds a secret file.
export function bashReadsSecret(command, cwd, files, { canonical, isInside }) {
  const text = CASE_INSENSITIVE_FS ? command.toLowerCase() : command;
  if (text.includes(SECRETS_TEXT)) return true;
  if (!files.length) return false;
  // Names compare case-insensitively: when unsure, match (deny).
  const names = new Set(files.map((file) => basename(file).toLowerCase()));
  for (const { tokens, dir } of commandsWithDir(command, cwd)) {
    const head = tokens[headIndex(tokens)];
    const verb = head !== undefined && READ_VERBS.has(basename(head));
    const candidates = verb ? tokens.flatMap(wordPaths) : redirectedPaths(tokens);
    for (const candidate of candidates) {
      if (candidate === '' || candidate.startsWith('$')) continue;
      if (files.includes(canonical(resolve(dir, expandHome(candidate))))) return true;
      if (verb && names.has(basename(candidate).toLowerCase())) return true;
    }
    const search = searchOf(tokens, dir);
    if (search && searchReaches(search, files, isInside)) return true;
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
