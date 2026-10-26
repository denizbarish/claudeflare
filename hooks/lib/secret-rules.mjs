// Secret files and tunnel tokens: claudeflare writes credentials to disk
// (.claudeflare/secrets/*, env files from `claudeflare tunnel-token`) and lists
// them in .claudeflare/secret-files.json. These rules keep the agent from
// reading them back and from putting a literal tunnel token on a cloudflared
// command line. Same threat model as the rest of the guard: string checks
// catch model mistakes, not deliberate evasion.
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { parseShell } from './wrangler-rules.mjs';

export const SECRET_REASON =
  'This file holds a credential written by claudeflare and must not be read into the conversation. Let the program that needs it read it (for example cloudflared reading TUNNEL_TOKEN from the environment).';
export const TUNNEL_TOKEN_REASON =
  'Tunnel tokens are never read into the conversation. Run "claudeflare tunnel-token --account <id> --tunnel <id> --env-file <path>" to write the token into an env file without showing it.';
export const CLOUDFLARED_REASON =
  'A literal tunnel token on a cloudflared command line ends up in the transcript and shell history. Write it with "claudeflare tunnel-token" and let cloudflared read TUNNEL_TOKEN from the environment or use --token-file.';

const INDEX_FILE = join('.claudeflare', 'secret-files.json');
const SECRETS_TEXT = '.claudeflare/secrets';
const READ_VERBS = new Set(['cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk', 'cp', 'mv', 'base64', 'xxd', 'od', 'strings', 'source', '.']);
// Words that run the next word as the command.
const PREFIX_HEADS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time', 'xargs']);
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;
const TOKEN_ASSIGNMENT = /^TUNNEL_TOKEN=(.*)$/;
const TOKEN_FLAG = /^--?token$/;
const TOKEN_FLAG_VALUE = /^--?token=(.*)$/;
const CLOUDFLARED = /(?:^|\/)cloudflared(?::[^/\s]*)?$/;
const MAX_NESTING = 3;

function readIndex(dir) {
  try {
    const index = JSON.parse(readFileSync(join(dir, INDEX_FILE), 'utf8'));
    return Array.isArray(index?.files) ? index.files.filter((f) => typeof f === 'string' && isAbsolute(f)) : [];
  } catch {
    return [];
  }
}

// Indexed files for the session cwd and for the nearest ancestor that holds a
// .claudeflare directory (a session started in a subfolder of the project).
export function readSecretIndex(cwd) {
  const start = resolve(cwd);
  const dirs = [start];
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claudeflare'))) {
      if (dir !== start) dirs.push(dir);
      break;
    }
    if (dirname(dir) === dir) break;
  }
  return [...new Set(dirs.flatMap(readIndex))];
}

// Last segment of a ripgrep style glob as a regular expression. `*` matches a
// leading dot, as in ripgrep. Case-insensitive: when unsure, match (deny).
function globSegmentRegExp(glob) {
  const segment = glob.split('/').at(-1);
  if (segment === '' || segment === '**') return /^/;
  let out = '';
  let braces = 0;
  for (const c of segment) {
    if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{') { out += '(?:'; braces++; }
    else if (c === '}' && braces > 0) { out += ')'; braces--; }
    else if (c === ',' && braces > 0) out += '|';
    else if (c === '[' || c === ']') out += c;
    else out += c.replace(/[.+^$()|\\]/g, '\\$&');
  }
  try {
    return new RegExp(`^${out}${')'.repeat(braces)}$`, 'i');
  } catch {
    return /^/;
  }
}

export function globMatchesName(glob, name) {
  return globSegmentRegExp(glob).test(name);
}

// Commands from the text and from quoted text inside it (sh -c '...').
function allCommands(command, depth = 0) {
  const { commands, nested } = parseShell(command);
  if (depth >= MAX_NESTING) return commands;
  return [...commands, ...nested.flatMap(({ text }) => allCommands(text, depth + 1))];
}

function headIndex(tokens) {
  let i = 0;
  while (i < tokens.length && (ASSIGNMENT.test(tokens[i]) || PREFIX_HEADS.has(tokens[i]) || tokens[i].startsWith('-'))) i++;
  return i;
}

// Path candidates in a word: redirections (<file, 2>file) and --opt=file.
function wordPaths(word) {
  const bare = word.replace(/^\d*[<>]+&?/, '');
  const eq = bare.indexOf('=');
  return eq >= 0 ? [bare, bare.slice(eq + 1)] : [bare];
}

// files: canonical absolute paths; canonical: the guard's canonicalPath.
export function bashReadsSecret(command, cwd, files, canonical) {
  if (command.includes(SECRETS_TEXT)) return true;
  if (!files.length) return false;
  if (files.some((file) => command.includes(file))) return true;
  // Names compare case-insensitively: when unsure, match (deny).
  const names = new Set(files.map((file) => basename(file).toLowerCase()));
  for (const tokens of allCommands(command)) {
    const head = tokens[headIndex(tokens)];
    const verb = head !== undefined && READ_VERBS.has(basename(head));
    for (const word of tokens) {
      for (const candidate of wordPaths(word)) {
        if (candidate === '' || candidate.startsWith('$')) continue;
        if (files.includes(canonical(resolve(cwd, candidate)))) return true;
        if (verb && names.has(basename(candidate).toLowerCase())) return true;
      }
    }
  }
  return false;
}

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
