// Fake product module for REST executor tests. Importing it registers the
// module; the CLI tests load it with `node --import` so the child process
// knows the same kinds.

import { registerProduct } from '../../../scripts/lib/products/index.mjs';

const uuid = '([0-9a-f-]{36})';

export const SX = {
  product: 'sx',
  kinds: [
    {
      kind: 'sx_idp_create', product: 'sx', scope: 'account', methods: ['POST'], pattern: /^\/sx\/idps$/,
      resource: () => null, readOnlyFields: ['id'], inverse: 'delete_created', destructive: false,
      secretFields: ['config.client_secret'],
    },
    {
      kind: 'sx_idp_update', product: 'sx', scope: 'account', methods: ['PUT'], pattern: new RegExp(`^/sx/idps/${uuid}$`),
      resource: (m) => ({ type: 'sx_idp', id: m[1] }), readOnlyFields: ['id'], inverse: 'put_before', destructive: false,
      secretFields: ['config.client_secret'],
    },
    {
      kind: 'sx_tunnel_create', product: 'sx', scope: 'account', methods: ['POST'], pattern: /^\/sx\/tunnels$/,
      resource: () => null, readOnlyFields: ['id'], inverse: 'delete_created', destructive: false,
      redact: ['token', 'credentials_file'],
    },
    {
      kind: 'sx_token_create', product: 'sx', scope: 'account', methods: ['POST'], pattern: /^\/sx\/tokens$/,
      resource: () => null, readOnlyFields: ['id'], inverse: 'delete_created', destructive: false,
      secretSink: ['client_id', 'client_secret'],
    },
    {
      kind: 'sx_thing_delete', product: 'sx', scope: 'account', methods: ['DELETE'], pattern: new RegExp(`^/sx/things/${uuid}$`),
      resource: (m) => ({ type: 'sx_thing', id: m[1] }), readOnlyFields: ['id'], inverse: 'none', destructive: true, nameField: 'name',
    },
  ],
  probePath: (base) => `${base}/sx/idps`,
  gather: async () => ({}),
  lockoutRisks: () => [],
  verifyChecks: () => [],
};

export const unregister = registerProduct(SX);
