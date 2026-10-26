// Fake product module for product preflight tests. Every answer comes from
// the client, so in-process fake clients and the CLI stub server drive it the
// same way. Importing it registers the module.

import { registerProduct } from '../../../scripts/lib/products/index.mjs';
import { listAll } from '../../../scripts/lib/paginate.mjs';

const uuid = '([0-9a-f-]{36})';
const lastSegment = (op) => String(op.path).split('?')[0].split('/').pop();

export const PF = {
  product: 'pf',
  permission: { read: 'Pf Apps Read', edit: 'Pf Apps Edit' },
  kinds: [
    {
      kind: 'pf_app_update', product: 'pf', scope: 'account', methods: ['PUT'], pattern: new RegExp(`^/pf/apps/${uuid}$`),
      resource: (m) => ({ type: 'pf_app', id: m[1] }), read: (m, base) => `${base}/pf/apps/${m[1]}`,
      readOnlyFields: ['id'], inverse: 'put_before', destructive: false,
      notes: (ctx) => ctx.notes ?? [],
    },
    {
      kind: 'pf_app_delete', product: 'pf', scope: 'account', methods: ['DELETE'], pattern: new RegExp(`^/pf/apps/${uuid}$`),
      resource: (m) => ({ type: 'pf_app', id: m[1] }), read: (m, base) => `${base}/pf/apps/${m[1]}`,
      readOnlyFields: ['id'], inverse: 'none', destructive: true, nameField: 'meta.name',
    },
    {
      kind: 'pf_zone_rule_update', product: 'pf', scope: 'zone', methods: ['PATCH'], pattern: /^\/pf\/rule$/,
      resource: () => ({ type: 'pf_zone_rule', id: 'rule' }), read: (m, base) => `${base}/pf/rule`,
      readOnlyFields: [], inverse: 'patch_before', destructive: false,
    },
  ],
  entitlement: async (client, base) => {
    const org = await client.request('GET', `${base}/pf/org`);
    return org?.entitled ? { ok: true, detail: 'organization exists' } : { ok: false, detail: 'no organization on this account' };
  },
  probePath: (base) => `${base}/pf/apps`,
  gather: async (client, base) => ({
    rules: await listAll(client, `${base}/pf/rules`, { perPage: 2 }),
    ...(await client.request('GET', `${base}/pf/state`)),
  }),
  dependencies: (ctx, op) => {
    if (String(op.method).toUpperCase() !== 'DELETE') return [];
    const id = lastSegment(op);
    return ctx.rules.filter((r) => r.app === id).map((r) => `rule ${r.name} uses app ${id}`);
  },
  lockoutRisks: (ctx) => ctx.lockout ?? [],
  verifyChecks: () => [],
};

export const unregister = registerProduct(PF);
