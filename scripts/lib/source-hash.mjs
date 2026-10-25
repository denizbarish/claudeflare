import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { lstatSync, readFileSync, readdirSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CfError } from './errors.mjs';

const EXCLUDED = new Set(['.claudeflare', 'node_modules', '.wrangler', '.git']);
const GIT_MAX_BUFFER = 256 * 1024 * 1024;

function sha256(data) {
  return createHash('sha256').update(data).digest('hex');
}

function isExcluded(rel) {
  return rel.split('/').some((segment) => EXCLUDED.has(segment));
}

function tooLarge(maxFiles) {
  return new CfError('project_too_large', `project has more than ${maxFiles} files to hash`);
}

function isGitWorkTree(dir) {
  try {
    const out = execFileSync('git', ['-C', dir, 'rev-parse', '--is-inside-work-tree'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

function gitFiles(dir) {
  const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: dir,
    encoding: 'utf8',
    maxBuffer: GIT_MAX_BUFFER,
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  return [...new Set(out.split('\0').filter(Boolean))];
}

function walkFiles(dir, maxFiles) {
  const files = [];
  const visit = (abs, rel) => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (EXCLUDED.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        visit(join(abs, entry.name), childRel);
      } else if (entry.isFile() || entry.isSymbolicLink()) {
        files.push(childRel);
        if (files.length > maxFiles) throw tooLarge(maxFiles);
      }
    }
  };
  visit(dir, '');
  return files;
}

// Digest of one entry. Symlinks are hashed by their target string and never
// followed; entries that vanished after listing get a fixed marker.
function entryDigest(abs) {
  let stat;
  try {
    stat = lstatSync(abs);
  } catch (err) {
    if (err?.code === 'ENOENT' || err?.code === 'ENOTDIR') return 'deleted';
    throw err;
  }
  if (stat.isSymbolicLink()) return `symlink:${sha256(readlinkSync(abs))}`;
  if (stat.isDirectory()) return 'directory';
  return sha256(readFileSync(abs));
}

export function computeSourceHash(projectDir, { maxFiles = 20000 } = {}) {
  const listed = isGitWorkTree(projectDir) ? gitFiles(projectDir) : walkFiles(projectDir, maxFiles);
  const files = listed.filter((rel) => !isExcluded(rel));
  if (files.length > maxFiles) throw tooLarge(maxFiles);
  files.sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

  const hash = createHash('sha256');
  for (const rel of files) {
    hash.update(`${rel}\0${entryDigest(join(projectDir, rel))}\n`);
  }
  return `sha256:${hash.digest('hex')}`;
}
