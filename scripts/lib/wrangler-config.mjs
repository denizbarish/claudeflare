// Reads the wrangler config of a project (wrangler.json, wrangler.jsonc or
// wrangler.toml, or the file given with --config) for preflight: entry point,
// assets and the resource bindings, with an --env section applied. The TOML
// reader covers the subset wrangler configs use (tables, arrays of tables,
// strings, numbers, booleans, arrays and inline tables, multi-line arrays);
// an unsupported value under a key preflight relies on is an error, never a
// silent skip.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CfError } from './errors.mjs';

// wrangler 4.152 looks for each name in turn, walking up from the working
// directory, so a wrangler.json in a parent folder wins over a wrangler.toml
// in the project. A deploy also follows .wrangler/deploy/config.json (written
// by the Cloudflare Vite plugin) the same way.
export const CONFIG_FILES = ['wrangler.json', 'wrangler.jsonc', 'wrangler.toml'];
const DEPLOY_REDIRECT = join('.wrangler', 'deploy', 'config.json');

function findUp(start, name) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(join(dir, name))) return join(dir, name);
    if (dirname(dir) === dir) return null;
  }
}

// The config wrangler would pick in projectDir, relative to it, or null.
// One it would pick from outside projectDir, or a redirected deploy config,
// is refused: preflight could not read or hash what wrangler would use.
export function findConfigFile(projectDir) {
  const redirect = findUp(projectDir, DEPLOY_REDIRECT);
  if (redirect) {
    throw new CfError('invalid_config', `wrangler would follow the redirected deploy config ${redirect}, which claudeflare does not support; pass --config to the op`);
  }
  for (const name of CONFIG_FILES) {
    const found = findUp(projectDir, name);
    if (!found) continue;
    if (found !== join(resolve(projectDir), name)) {
      throw new CfError('invalid_config', `wrangler would use ${found}, outside project_dir; set project_dir to the folder that holds it or pass --config`);
    }
    return name;
  }
  return null;
}

// Walks text outside JSON strings: onChar(i) returns what to emit for a
// non-string character and may advance past it via the returned index.
function walkOutsideStrings(text, onChar) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else {
      const [emit, next] = onChar(i);
      out += emit;
      i = next;
    }
  }
  return out;
}

// Drops // and /* */ comments, then trailing commas, outside strings.
function stripJsonc(text) {
  const noComments = walkOutsideStrings(text, (i) => {
    if (text[i] === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      return ['\n', end === -1 ? text.length : end];
    }
    if (text[i] === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      return ['', end === -1 ? text.length : end + 1];
    }
    return [text[i], i];
  });
  return walkOutsideStrings(noComments, (i) => [
    noComments[i] === ',' && /^\s*[}\]]/.test(noComments.slice(i + 1)) ? '' : noComments[i],
    i,
  ]);
}

// Splits on `sep` outside quotes and brackets.
function splitTop(text, sep) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
    else if (c === sep && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((p) => p.trim()).filter(Boolean);
}

function stripTomlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

const UNSUPPORTED = Symbol('unsupported');

function tomlValue(raw) {
  if (/^"(?:[^"\\]|\\.)*"$/.test(raw)) {
    try {
      return JSON.parse(raw);
    } catch {
      return UNSUPPORTED;
    }
  }
  if (/^'[^']*'$/.test(raw)) return raw.slice(1, -1);
  if (raw === 'true' || raw === 'false') return raw === 'true';
  if (/^[+-]?\d[\d_]*(\.\d+)?$/.test(raw)) return Number(raw.replace(/_/g, ''));
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const items = splitTop(raw.slice(1, -1), ',').map(tomlValue);
    return items.includes(UNSUPPORTED) ? UNSUPPORTED : items;
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const table = {};
    for (const pair of splitTop(raw.slice(1, -1), ',')) {
      const eq = pair.indexOf('=');
      if (eq <= 0) return UNSUPPORTED;
      const value = tomlValue(pair.slice(eq + 1).trim());
      if (value === UNSUPPORTED) return UNSUPPORTED;
      setPath(table, tomlKey(pair.slice(0, eq)), value);
    }
    return table;
  }
  return UNSUPPORTED;
}

function tomlKey(raw) {
  return raw.split('.').map((k) => k.trim().replace(/^["']|["']$/g, ''));
}

function setPath(obj, keys, value) {
  let node = obj;
  for (const key of keys.slice(0, -1)) {
    if (typeof node[key] !== 'object' || node[key] === null) node[key] = {};
    node = Array.isArray(node[key]) ? node[key].at(-1) : node[key];
  }
  node[keys.at(-1)] = value;
}

// Keys preflight relies on; an unsupported value under them is an error.
const RELIED_KEYS = new Set([
  'main', 'assets', 'site', 'pages_build_output_dir', 'env',
  'kv_namespaces', 'r2_buckets', 'd1_databases', 'queues', 'durable_objects', 'services', 'vectorize', 'hyperdrive',
]);

const bracketDepth = (text) => {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === '\\' && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') depth--;
  }
  return depth;
};

export function parseToml(text) {
  const root = {};
  let table = root;
  let tablePath = [];
  const lines = text.split(/\r?\n/);
  for (let n = 0; n < lines.length; n++) {
    let line = stripTomlComment(lines[n]).trim();
    if (!line) continue;
    let m = /^\[\[([^\]]+)\]\]$/.exec(line);
    if (m) {
      const keys = tomlKey(m[1]);
      let parent = root;
      for (const key of keys.slice(0, -1)) {
        if (typeof parent[key] !== 'object' || parent[key] === null) parent[key] = {};
        parent = Array.isArray(parent[key]) ? parent[key].at(-1) : parent[key];
      }
      const last = keys.at(-1);
      if (!Array.isArray(parent[last])) parent[last] = [];
      table = {};
      parent[last].push(table);
      tablePath = keys;
      continue;
    }
    m = /^\[([^\]]+)\]$/.exec(line);
    if (m) {
      table = {};
      tablePath = tomlKey(m[1]);
      setPath(root, tablePath, table);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = tomlKey(line.slice(0, eq));
    let raw = line.slice(eq + 1).trim();
    const path = [...tablePath, ...key];
    // env.<name>.main is relied on like main; env.<name>.vars is not.
    const relied = (path[0] === 'env' ? path.slice(2) : path).some((k) => RELIED_KEYS.has(k));
    const delim = raw.startsWith('"""') ? '"""' : raw.startsWith("'''") ? "'''" : null;
    if (delim) {
      // Multi-line string: skipped (never under a relied key).
      if (relied) throw new Error(`multi-line string under ${key.join('.')} is not supported`);
      if (raw.length < 6 || !raw.endsWith(delim)) {
        while (n + 1 < lines.length && !lines[++n].includes(delim));
      }
      continue;
    }
    while (bracketDepth(raw) > 0 && n + 1 < lines.length) raw += ` ${stripTomlComment(lines[++n]).trim()}`;
    raw = raw.replace(/,\s*([\]}])/g, '$1');
    const value = tomlValue(raw);
    if (value !== UNSUPPORTED) setPath(table, key, value);
    else if (relied) throw new Error(`unsupported value for ${[...tablePath, ...key].join('.')}`);
  }
  return root;
}

// Returns { file, config }, or { file: null, config: {} } when there is no
// config. `file` is the --config path (relative to projectDir) when given.
export function readWranglerConfig(projectDir, configPath) {
  const file = configPath ?? findConfigFile(projectDir);
  if (!file) return { file: null, config: {} };
  let text;
  try {
    text = readFileSync(join(projectDir, file), 'utf8');
  } catch (err) {
    throw new CfError('invalid_config', `${file} could not be read: ${err.code || err.message}`);
  }
  try {
    const config = file.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object');
    return { file, config };
  } catch (err) {
    throw new CfError('invalid_config', `${file} could not be parsed: ${err.message}`);
  }
}

// Bindings are not inherited by environments in wrangler; entry point and
// asset settings are.
const NON_INHERITED = ['kv_namespaces', 'r2_buckets', 'd1_databases', 'queues', 'durable_objects', 'services', 'vectorize', 'hyperdrive'];

export function applyEnv(config, envName, file) {
  if (envName === undefined) return config;
  const section = config.env?.[envName];
  if (!section || typeof section !== 'object' || Array.isArray(section)) {
    throw new CfError('invalid_config', `${file ?? 'wrangler config'} has no env.${envName} section`);
  }
  const merged = { ...config };
  for (const key of NON_INHERITED) delete merged[key];
  delete merged.env;
  return { ...merged, ...section };
}

const list = (value) => (Array.isArray(value) ? value.filter((v) => v && typeof v === 'object') : []);
const str = (value) => (typeof value === 'string' && value ? value : undefined);

// Resource bindings referenced at the top level of the config.
export function configBindings(config) {
  return {
    kv: list(config.kv_namespaces).map((b) => ({ binding: str(b.binding), id: str(b.id) })),
    r2: list(config.r2_buckets).map((b) => ({ binding: str(b.binding), name: str(b.bucket_name) })),
    d1: list(config.d1_databases).map((b) => ({
      binding: str(b.binding),
      name: str(b.database_name),
      id: str(b.database_id),
      migrations_dir: str(b.migrations_dir),
    })),
    queue: list(config.queues?.producers).map((b) => ({ binding: str(b.binding), name: str(b.queue) })),
    service: list(config.services).map((b) => ({ binding: str(b.binding), name: str(b.service) })),
    durable: list(config.durable_objects?.bindings).map((b) => ({ binding: str(b.name), script: str(b.script_name) })),
    vectorize: list(config.vectorize).map((b) => ({ binding: str(b.binding), name: str(b.index_name) })),
    hyperdrive: list(config.hyperdrive).map((b) => ({ binding: str(b.binding), id: str(b.id) })),
  };
}
