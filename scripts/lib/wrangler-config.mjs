// Reads the top-level wrangler config of a project (wrangler.jsonc,
// wrangler.json or wrangler.toml) for preflight: entry point, assets and
// the resource bindings. The TOML reader covers the subset wrangler configs
// use for these keys (tables, arrays of tables, strings, numbers, booleans,
// one-line arrays and inline tables); anything else is ignored.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';

export const CONFIG_FILES = ['wrangler.jsonc', 'wrangler.json', 'wrangler.toml'];

export function findConfigFile(projectDir) {
  return CONFIG_FILES.find((name) => existsSync(join(projectDir, name))) ?? null;
}

// Drops // and /* */ comments and trailing commas outside strings.
function stripJsonc(text) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i = text.indexOf('*/', i + 2);
      if (i === -1) break;
      i++;
    } else {
      out += c;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
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

export function parseToml(text) {
  const root = {};
  let table = root;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine).trim();
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
      continue;
    }
    m = /^\[([^\]]+)\]$/.exec(line);
    if (m) {
      table = {};
      setPath(root, tomlKey(m[1]), table);
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const value = tomlValue(line.slice(eq + 1).trim());
    if (value !== UNSUPPORTED) setPath(table, tomlKey(line.slice(0, eq)), value);
  }
  return root;
}

// Returns { file, config } or { file: null, config: {} } when there is no config.
export function readWranglerConfig(projectDir) {
  const file = findConfigFile(projectDir);
  if (!file) return { file: null, config: {} };
  const text = readFileSync(join(projectDir, file), 'utf8');
  try {
    const config = file.endsWith('.toml') ? parseToml(text) : JSON.parse(stripJsonc(text));
    if (!config || typeof config !== 'object' || Array.isArray(config)) throw new Error('not an object');
    return { file, config };
  } catch (err) {
    throw new CfError('invalid_config', `${file} could not be parsed: ${err.message}`);
  }
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
  };
}
