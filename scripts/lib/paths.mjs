import { join } from 'node:path';
import { CfError } from './errors.mjs';

const ZONE_PATTERN = /^[a-z0-9.-]+$/i;

function assertZoneName(zoneName) {
  if (typeof zoneName !== 'string' || !ZONE_PATTERN.test(zoneName) || zoneName.includes('..')) {
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
    snapshots: (zoneName) => join(root, 'snapshots', assertZoneName(zoneName)),
    reports: (zoneName) => join(root, 'reports', assertZoneName(zoneName)),
  };
}
