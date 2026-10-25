import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CfError } from './errors.mjs';

const EXCLUDED_DIRS = new Set(['.claudeflare', 'node_modules', '.wrangler', '.git']);
const SECRET_NAMES = new Set(['.dev.vars', '.env']);
const SECRET_PREFIXES = ['.dev.vars.', '.env.'];
const GIT_MAX_BUFFER = 256 * 1024 * 1024;
const SLASH = 0x2f;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function tooLarge(maxFiles) {
  return new CfError('project_too_large', `project has more than ${maxFiles} files to hash`);
}

function isSecretName(name) {
  return SECRET_NAMES.has(name) || SECRET_PREFIXES.some((p) => name.startsWith(p));
}

// Paths are kept as raw byte Buffers (POSIX separators) so non-UTF-8 names
// are neither lost nor merged; segments are decoded only for name checks.
function segments(rel) {
  const out = [];
  let start = 0;
  for (let i = 0; i <= rel.length; i += 1) {
    if (i === rel.length || rel[i] === SLASH) {
      if (i > start) out.push(rel.subarray(start, i).toString('utf8'));
      start = i + 1;
    }
  }
  return out;
}

function isExcluded(rel) {
  const parts = segments(rel);
  return parts.some((s) => EXCLUDED_DIRS.has(s)) || isSecretName(parts[parts.length - 1] ?? '');
}

function joinRel(base, name) {
  return base.length ? Buffer.concat([base, Buffer.from('/'), name]) : Buffer.from(name);
}

function gitStatus(dir, args) {
  try {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' });
    return 0;
  } catch (err) {
    return typeof err?.status === 'number' ? err.status : -1;
  }
}

// Git mode only for a work tree whose project dir is not itself ignored by an
// enclosing repo (ignored dirs would list nothing and hash a constant).
function useGit(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    if (out.trim() !== 'true') return false;
  } catch {
    return false;
  }
  return gitStatus(dir, ['check-ignore', '-q', '.']) === 1;
}

function gitList(dir, maxFiles, maxBuffer) {
  let out;
  try {
    out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
      cwd: dir,
      maxBuffer,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch (err) {
    if (err?.code === 'ENOBUFS') throw tooLarge(maxFiles);
    throw err;
  }
  const paths = [];
  let start = 0;
  for (let i = 0; i < out.length; i += 1) {
    if (out[i] !== 0) continue;
    let end = i;
    while (end > start && out[end - 1] === SLASH) end -= 1;
    if (end > start) paths.push(Buffer.from(out.subarray(start, end)));
    start = i + 1;
  }
  return paths;
}

class Collector {
  constructor(root, maxFiles) {
    this.root = root;
    this.rootBuf = Buffer.from(root);
    this.maxFiles = maxFiles;
    this.entries = new Map();
  }

  abs(rel) {
    return rel.length ? Buffer.concat([this.rootBuf, Buffer.from(sep), rel]) : this.rootBuf;
  }

  add(rel) {
    if (isExcluded(rel)) return;
    const key = rel.toString('latin1');
    if (this.entries.has(key)) return;
    this.entries.set(key, rel);
    if (this.entries.size > this.maxFiles) throw tooLarge(this.maxFiles);
  }

  // Adds a listed path: real directories are walked (nested repos, submodules,
  // extra paths), everything else becomes one entry.
  addPath(rel) {
    if (rel.length && isExcluded(rel)) return;
    let stat = null;
    try {
      stat = lstatSync(this.abs(rel));
    } catch (err) {
      if (err?.code !== 'ENOENT' && err?.code !== 'ENOTDIR') throw err;
    }
    if (stat?.isDirectory()) this.walk(rel);
    else this.add(rel);
  }

  // Extra paths are lexical; a symlinked ancestor is hashed as a link entry
  // so the walk never follows it outside the project.
  addExtra(rel) {
    const parts = rel.length ? rel.toString('latin1').split('/') : [];
    for (let i = 1; i < parts.length; i += 1) {
      const ancestor = Buffer.from(parts.slice(0, i).join('/'), 'latin1');
      let stat = null;
      try {
        stat = lstatSync(this.abs(ancestor));
      } catch {
        break;
      }
      if (!stat.isDirectory()) {
        this.add(ancestor);
        return;
      }
    }
    this.addPath(rel);
  }

  walk(rel) {
    for (const entry of readdirSync(this.abs(rel), { withFileTypes: true, encoding: 'buffer' })) {
      const name = entry.name.toString('utf8');
      if (EXCLUDED_DIRS.has(name) || isSecretName(name)) continue;
      const child = joinRel(rel, entry.name);
      if (entry.isDirectory()) this.walk(child);
      else if (entry.isFile() || entry.isSymbolicLink()) this.add(child);
    }
  }

  // Digest of one entry. Symlinks are hashed by their target string and never
  // followed; entries that vanished after listing get a fixed marker.
  digest(rel) {
    const abs = this.abs(rel);
    let stat;
    try {
      stat = lstatSync(abs);
    } catch (err) {
      if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'deleted';
      throw err;
    }
    if (stat.isSymbolicLink()) return `symlink:${sha256(readlinkSync(abs, { encoding: 'buffer' }))}`;
    return sha256(readFileSync(abs));
  }
}

function extraRel(root, extra) {
  if (typeof extra !== 'string' || !extra) {
    throw new CfError('invalid_input', 'extraPaths entries must be non-empty strings');
  }
  const rel = relative(root, resolve(root, extra));
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new CfError('invalid_input', `extra path is outside the project directory: ${extra}`);
  }
  return Buffer.from(rel.split(sep).join('/'));
}

export function computeSourceHash(
  projectDir,
  { maxFiles = 20000, extraPaths = [], gitMaxBuffer = GIT_MAX_BUFFER } = {},
) {
  const root = resolve(projectDir);
  const extras = extraPaths.map((p) => extraRel(root, p));
  const files = new Collector(root, maxFiles);

  if (useGit(root)) {
    for (const rel of gitList(root, maxFiles, gitMaxBuffer)) files.addPath(rel);
  } else {
    files.walk(Buffer.alloc(0));
  }
  for (const rel of extras) files.addExtra(rel);

  const sorted = [...files.entries.values()].sort(Buffer.compare);
  if (!sorted.length) throw new CfError('empty_project', 'project has no files to hash');

  const hash = createHash('sha256');
  for (const rel of sorted) {
    hash.update(rel);
    hash.update(`\0${files.digest(rel)}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}
