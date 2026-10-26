import { join } from 'node:path';
import { CfError } from './errors.mjs';

const ZONE_PATTERN = /^[a-z0-9.-]+$/i;
const HAS_ALNUM = /[a-z0-9]/i;

// Zone names become directory names, so "." and ".." style names are refused.
export function assertZoneName(zoneName) {
  const valid = typeof zoneName === 'string' && ZONE_PATTERN.test(zoneName) &&
    !zoneName.includes('..') && HAS_ALNUM.test(zoneName);
  if (!valid) {
    throw new CfError('invalid_zone', `Invalid zone name: ${JSON.stringify(zoneName)}`);
  }
  return zoneName;
}

export function paths(cwd) {
  const root = join(cwd, '.claudeflare');
  return {
    root,
    plans: join(root, 'plans'),
    approvals: join(root, 'approvals'),
    secrets: join(root, 'secrets'),
    secretFilesIndex: join(root, 'secret-files.json'),
    snapshots: (zoneName) => join(root, 'snapshots', assertZoneName(zoneName)),
    reports: (zoneName) => join(root, 'reports', assertZoneName(zoneName)),
  };
}
