import { join } from 'node:path';

export function paths(cwd) {
  const root = join(cwd, '.claudeflare');
  return {
    root,
    plans: join(root, 'plans'),
    approvals: join(root, 'approvals'),
    snapshots: (zoneName) => join(root, 'snapshots', zoneName),
    reports: (zoneName) => join(root, 'reports', zoneName),
  };
}
