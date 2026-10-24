import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classify, validatePlanOps } from '../scripts/lib/resources.mjs';
import { captureSnapshot, inverseFor, buildRollbackOps } from '../scripts/lib/snapshot.mjs';
import { CfError } from '../scripts/lib/errors.mjs';

const Z = '0123456789abcdef0123456789abcdef';
const RS = 'aaaa1111bbbb2222cccc3333dddd4444';
const REC = 'ffff0000eeee1111dddd2222cccc3333';

function fakeClient(routes) {
  const calls = [];
  return {
    calls,
    async request(method, path, opts) {
      calls.push({ method, path, opts });
      const handler = routes[`${method} ${path}`];
      if (!handler) throw new Error(`unexpected request ${method} ${path}`);
      return typeof handler === 'function' ? handler() : handler;
    },
  };
}

function planWith(ops) {
  return { id: 'examplecom-20261024-143000-test', zone_id: Z, zone_name: 'example.com', ops };
}

async function snapshotOne(op, routes) {
  const client = fakeClient(routes);
  const snap = await captureSnapshot(client, planWith([op]));
  return { client, snap, entry: snap.entries[0] };
}

const SAMPLE_RULE = {
  id: 'r1',
  expression: 'http.host eq "a.example.com"',
  action: 'block',
  action_parameters: { response: { status_code: 403 } },
  description: 'Block a',
  enabled: true,
  version: '3',
  last_updated: '2026-10-01T00:00:00Z',
};

test('zone_setting: snapshot reads the setting and inverse restores its value', async () => {
  const op = { method: 'PATCH', path: `/zones/${Z}/settings/always_use_https`, body: { value: 'on' } };
  assert.deepEqual(classify(op), {
    kind: 'zone_setting',
    invertible: true,
    readPath: `/zones/${Z}/settings/always_use_https`,
  });
  const { client, snap, entry } = await snapshotOne(op, {
    [`GET /zones/${Z}/settings/always_use_https`]: { id: 'always_use_https', value: 'off', editable: true },
  });
  assert.equal(client.calls.length, 1);
  assert.equal(snap.plan_id, 'examplecom-20261024-143000-test');
  assert.ok(!Number.isNaN(Date.parse(snap.taken_at)));
  assert.equal(entry.op_index, 0);
  assert.equal(entry.kind, 'zone_setting');
  assert.equal(entry.invertible, true);
  assert.deepEqual(inverseFor(entry, { id: 'always_use_https', value: 'on' }), [
    { method: 'PATCH', path: `/zones/${Z}/settings/always_use_https`, body: { value: 'off' } },
  ]);
});

test('zone_settings_bulk: snapshot reads each item and inverse patches original items', async () => {
  const op = {
    method: 'PATCH',
    path: `/zones/${Z}/settings`,
    body: { items: [{ id: 'ssl', value: 'strict' }, { id: 'min_tls_version', value: '1.2' }] },
  };
  assert.equal(classify(op).kind, 'zone_settings_bulk');
  assert.equal(classify(op).invertible, true);
  const { client, entry } = await snapshotOne(op, {
    [`GET /zones/${Z}/settings/ssl`]: { id: 'ssl', value: 'flexible' },
    [`GET /zones/${Z}/settings/min_tls_version`]: { id: 'min_tls_version', value: '1.0' },
  });
  assert.deepEqual(
    client.calls.map((c) => c.path),
    [`/zones/${Z}/settings/ssl`, `/zones/${Z}/settings/min_tls_version`],
  );
  assert.deepEqual(inverseFor(entry, []), [
    {
      method: 'PATCH',
      path: `/zones/${Z}/settings`,
      body: { items: [{ id: 'ssl', value: 'flexible' }, { id: 'min_tls_version', value: '1.0' }] },
    },
  ]);
});

test('dns_create inverse uses id from apply result', async () => {
  const op = {
    method: 'POST',
    path: `/zones/${Z}/dns_records`,
    body: { type: 'A', name: 'www', content: '192.0.2.1', proxied: true },
  };
  assert.deepEqual(classify(op), { kind: 'dns_create', invertible: true });
  const { client, entry } = await snapshotOne(op, {});
  assert.equal(client.calls.length, 0);
  assert.equal(entry.before, null);
  assert.deepEqual(inverseFor(entry, { id: 'new123', type: 'A' }), [
    { method: 'DELETE', path: `/zones/${Z}/dns_records/new123` },
  ]);
  assert.throws(() => inverseFor(entry, {}), (e) => e instanceof CfError && e.code === 'rollback_ambiguous');
});

for (const method of ['PUT', 'PATCH']) {
  test(`dns_update (${method}): inverse PUTs the original record fields`, async () => {
    const path = `/zones/${Z}/dns_records/${REC}`;
    const op = { method, path, body: { content: '192.0.2.99' } };
    assert.deepEqual(classify(op), { kind: 'dns_update', invertible: true, readPath: path });
    const { entry } = await snapshotOne(op, {
      [`GET ${path}`]: {
        id: REC,
        type: 'A',
        name: 'www.example.com',
        content: '192.0.2.1',
        ttl: 1,
        proxied: true,
        comment: 'web',
        tags: [],
        zone_id: Z,
        created_on: '2026-01-01T00:00:00Z',
      },
    });
    assert.deepEqual(inverseFor(entry, { id: REC }), [
      {
        method: 'PUT',
        path,
        body: { type: 'A', name: 'www.example.com', content: '192.0.2.1', ttl: 1, proxied: true, comment: 'web', tags: [] },
      },
    ]);
  });
}

test('dns_delete: inverse POSTs the original record fields', async () => {
  const path = `/zones/${Z}/dns_records/${REC}`;
  const op = { method: 'DELETE', path };
  assert.deepEqual(classify(op), { kind: 'dns_delete', invertible: true, readPath: path });
  const { entry } = await snapshotOne(op, {
    [`GET ${path}`]: { id: REC, type: 'MX', name: 'example.com', content: 'mx.example.com', ttl: 3600, proxied: false, priority: 10 },
  });
  assert.deepEqual(inverseFor(entry, { id: REC }), [
    {
      method: 'POST',
      path: `/zones/${Z}/dns_records`,
      body: { type: 'MX', name: 'example.com', content: 'mx.example.com', ttl: 3600, proxied: false, priority: 10 },
    },
  ]);
});

test('rule_create inverse finds new rule id by diffing before ids vs applyResult.rules', async () => {
  const op = {
    method: 'POST',
    path: `/zones/${Z}/rulesets/${RS}/rules`,
    body: { expression: 'true', action: 'block' },
  };
  assert.deepEqual(classify(op), { kind: 'rule_create', invertible: true, readPath: `/zones/${Z}/rulesets/${RS}` });
  const { entry } = await snapshotOne(op, {
    [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [{ id: 'r1' }, { id: 'r2' }] },
  });
  assert.deepEqual(entry.before, { rule_ids: ['r1', 'r2'] });
  const applied = { id: RS, rules: [{ id: 'r1' }, { id: 'r2' }, { id: 'r3' }] };
  assert.deepEqual(inverseFor(entry, applied), [
    { method: 'DELETE', path: `/zones/${Z}/rulesets/${RS}/rules/r3` },
  ]);
});

test('rule_create inverse throws rollback_ambiguous unless exactly one new rule id', async () => {
  const op = { method: 'POST', path: `/zones/${Z}/rulesets/${RS}/rules`, body: {} };
  const { entry } = await snapshotOne(op, {
    [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [{ id: 'r1' }] },
  });
  const isAmbiguous = (e) => e instanceof CfError && e.code === 'rollback_ambiguous';
  assert.throws(() => inverseFor(entry, { rules: [{ id: 'r1' }] }), isAmbiguous);
  assert.throws(() => inverseFor(entry, { rules: [{ id: 'r1' }, { id: 'x' }, { id: 'y' }] }), isAmbiguous);
  assert.throws(() => inverseFor(entry, null), isAmbiguous);
});

test('rule_create snapshot handles a ruleset with no rules field', async () => {
  const op = { method: 'POST', path: `/zones/${Z}/rulesets/${RS}/rules`, body: {} };
  const { entry } = await snapshotOne(op, { [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS } });
  assert.deepEqual(entry.before, { rule_ids: [] });
});

test('rule_update: snapshot picks the rule and inverse PATCHes its original fields', async () => {
  const path = `/zones/${Z}/rulesets/${RS}/rules/r1`;
  const op = { method: 'PATCH', path, body: { enabled: false } };
  assert.deepEqual(classify(op), { kind: 'rule_update', invertible: true, readPath: `/zones/${Z}/rulesets/${RS}` });
  const { entry } = await snapshotOne(op, {
    [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [{ id: 'r0', expression: 'x' }, SAMPLE_RULE] },
  });
  assert.equal(entry.before.id, 'r1');
  assert.deepEqual(inverseFor(entry, {}), [
    {
      method: 'PATCH',
      path,
      body: {
        expression: SAMPLE_RULE.expression,
        action: 'block',
        action_parameters: { response: { status_code: 403 } },
        description: 'Block a',
        enabled: true,
      },
    },
  ]);
});

test('rule_update snapshot aborts when the rule is missing from the ruleset', async () => {
  const op = { method: 'PATCH', path: `/zones/${Z}/rulesets/${RS}/rules/gone`, body: {} };
  await assert.rejects(
    snapshotOne(op, { [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [SAMPLE_RULE] } }),
    (e) => e instanceof CfError,
  );
});

test('rule_delete: inverse POSTs the original rule fields to the rules collection', async () => {
  const op = { method: 'DELETE', path: `/zones/${Z}/rulesets/${RS}/rules/r1` };
  assert.deepEqual(classify(op), { kind: 'rule_delete', invertible: true, readPath: `/zones/${Z}/rulesets/${RS}` });
  const noDescription = { ...SAMPLE_RULE, description: undefined };
  delete noDescription.description;
  const { entry } = await snapshotOne(op, {
    [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [{ id: 'r0' }, noDescription, { id: 'r2' }] },
  });
  assert.deepEqual(entry.before, { rule: noDescription, index: 2 });
  assert.deepEqual(inverseFor(entry, { id: RS, rules: [] }), [
    {
      method: 'POST',
      path: `/zones/${Z}/rulesets/${RS}/rules`,
      body: {
        expression: SAMPLE_RULE.expression,
        action: 'block',
        action_parameters: { response: { status_code: 403 } },
        enabled: true,
        position: { index: 2 },
      },
    },
  ]);
});

test('phase_entrypoint_put: inverse PUTs the original rules', async () => {
  const path = `/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  const op = { method: 'PUT', path, body: { rules: [{ expression: 'true', action: 'block' }] } };
  assert.deepEqual(classify(op), { kind: 'phase_entrypoint_put', invertible: true, readPath: path });
  const withRef = { ...SAMPLE_RULE, ref: 'block_a', logging: { enabled: false } };
  const { entry } = await snapshotOne(op, { [`GET ${path}`]: { id: RS, version: '7', rules: [withRef] } });
  const [inverse] = inverseFor(entry, {});
  assert.deepEqual(inverse, {
    method: 'PUT',
    path,
    body: {
      rules: [
        {
          expression: SAMPLE_RULE.expression,
          action: 'block',
          action_parameters: { response: { status_code: 403 } },
          description: 'Block a',
          enabled: true,
          ref: 'block_a',
          logging: { enabled: false },
        },
      ],
    },
  });
  for (const field of ['id', 'version', 'last_updated']) {
    assert.ok(!(field in inverse.body.rules[0]), `inverse rule must not carry ${field}`);
  }
});

test('phase_entrypoint_put: a 404 before-read is recorded as empty rules', async () => {
  const path = `/zones/${Z}/rulesets/phases/http_request_dynamic_redirect/entrypoint`;
  const op = { method: 'PUT', path, body: { rules: [] } };
  const { entry } = await snapshotOne(op, {
    [`GET ${path}`]: () => {
      throw new CfError('not_found', 'HTTP 404', { status: 404 });
    },
  });
  assert.deepEqual(entry.before, { rules: [] });
  assert.deepEqual(inverseFor(entry, {}), [{ method: 'PUT', path, body: { rules: [] } }]);
});

test('purge_cache: not invertible and no before-read', async () => {
  const op = { method: 'POST', path: `/zones/${Z}/purge_cache`, body: { purge_everything: true } };
  assert.deepEqual(classify(op), { kind: 'purge_cache', invertible: false });
  const { client, entry } = await snapshotOne(op, {});
  assert.equal(client.calls.length, 0);
  assert.deepEqual(entry, { op_index: 0, kind: 'purge_cache', before: null, invertible: false, path: op.path });
  assert.deepEqual(inverseFor(entry, { id: 'p' }), []);
});

test('unknown: anything else is not invertible and not read', async () => {
  for (const op of [
    { method: 'GET', path: `/zones/${Z}/settings/ssl` },
    { method: 'DELETE', path: `/zones/${Z}/settings/ssl` },
    { method: 'POST', path: `/zones/${Z}/pagerules`, body: {} },
    { method: 'PATCH', path: `/zones/${Z}/settings/ssl/extra` },
    { method: 'PATCH', path: `/zones/{zone_id}/settings/ssl` },
  ]) {
    assert.deepEqual(classify(op), { kind: 'unknown', invertible: false }, `${op.method} ${op.path}`);
  }
  const { client, entry } = await snapshotOne({ method: 'POST', path: `/zones/${Z}/pagerules` }, {});
  assert.equal(client.calls.length, 0);
  assert.equal(entry.kind, 'unknown');
  assert.deepEqual(inverseFor(entry, {}), []);
});

test('captureSnapshot aborts (throws) if any before-read fails with non-404', async () => {
  const path = `/zones/${Z}/dns_records/${REC}`;
  const client = fakeClient({
    [`GET /zones/${Z}/settings/ssl`]: { id: 'ssl', value: 'full' },
    [`GET ${path}`]: () => {
      throw new CfError('permission', 'denied', { status: 403 });
    },
  });
  const plan = planWith([
    { method: 'PATCH', path: `/zones/${Z}/settings/ssl`, body: { value: 'strict' } },
    { method: 'DELETE', path },
  ]);
  await assert.rejects(captureSnapshot(client, plan), (e) => e instanceof CfError && e.code === 'permission');
});

test('captureSnapshot aborts on a 404 for a kind other than phase_entrypoint_put', async () => {
  const path = `/zones/${Z}/dns_records/${REC}`;
  const client = fakeClient({
    [`GET ${path}`]: () => {
      throw new CfError('not_found', 'HTTP 404', { status: 404 });
    },
  });
  await assert.rejects(
    captureSnapshot(client, planWith([{ method: 'DELETE', path }])),
    (e) => e instanceof CfError && e.code === 'not_found',
  );
});

test('buildRollbackOps skips unapplied ops and reverses order', async () => {
  const client = fakeClient({
    [`GET /zones/${Z}/settings/ssl`]: { id: 'ssl', value: 'flexible' },
    [`GET /zones/${Z}/settings/brotli`]: { id: 'brotli', value: 'off' },
  });
  const plan = planWith([
    { method: 'PATCH', path: `/zones/${Z}/settings/ssl`, body: { value: 'strict' } },
    { method: 'POST', path: `/zones/${Z}/dns_records`, body: { type: 'A' } },
    { method: 'POST', path: `/zones/${Z}/purge_cache`, body: { purge_everything: true } },
    { method: 'PATCH', path: `/zones/${Z}/settings/brotli`, body: { value: 'on' } },
  ]);
  const snap = await captureSnapshot(client, plan);
  assert.deepEqual(snap.entries.map((e) => e.op_index), [0, 1, 2, 3]);
  const results = [{ id: 'ssl', value: 'strict' }, { id: 'rec9' }, { id: 'purge' }, null];
  assert.deepEqual(buildRollbackOps(snap, results), [
    { method: 'DELETE', path: `/zones/${Z}/dns_records/rec9` },
    { method: 'PATCH', path: `/zones/${Z}/settings/ssl`, body: { value: 'flexible' } },
  ]);
  assert.deepEqual(buildRollbackOps(snap, [null, null, null, null]), []);
  assert.deepEqual(buildRollbackOps(snap, []), []);
});

test('two rule_create ops on one ruleset roll back to two DELETEs with the right ids', async () => {
  const rulesPath = `/zones/${Z}/rulesets/${RS}/rules`;
  const client = fakeClient({ [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [{ id: 'r1' }] } });
  const snap = await captureSnapshot(
    client,
    planWith([
      { method: 'POST', path: rulesPath, body: { expression: 'a', action: 'block' } },
      { method: 'POST', path: rulesPath, body: { expression: 'b', action: 'block' } },
    ]),
  );
  const results = [
    { id: RS, rules: [{ id: 'r1' }, { id: 'n1' }] },
    { id: RS, rules: [{ id: 'r1' }, { id: 'n1' }, { id: 'n2' }] },
  ];
  assert.deepEqual(buildRollbackOps(snap, results), [
    { method: 'DELETE', path: `${rulesPath}/n2` },
    { method: 'DELETE', path: `${rulesPath}/n1` },
  ]);
});

test('SRV record (data object): dns_update and dns_delete inverses copy data and settings, omit content', async () => {
  const path = `/zones/${Z}/dns_records/${REC}`;
  const srv = {
    id: REC,
    type: 'SRV',
    name: '_sip._tcp.example.com',
    content: '1 5060 sip.example.com',
    data: { priority: 10, weight: 1, port: 5060, target: 'sip.example.com' },
    priority: 10,
    ttl: 300,
    proxied: false,
    settings: { flatten_cname: false },
  };
  const expected = {
    type: 'SRV',
    name: '_sip._tcp.example.com',
    data: { priority: 10, weight: 1, port: 5060, target: 'sip.example.com' },
    ttl: 300,
    proxied: false,
    priority: 10,
    settings: { flatten_cname: false },
  };
  const update = await snapshotOne({ method: 'PATCH', path, body: { ttl: 60 } }, { [`GET ${path}`]: srv });
  assert.deepEqual(inverseFor(update.entry, { id: REC }), [{ method: 'PUT', path, body: expected }]);
  const del = await snapshotOne({ method: 'DELETE', path }, { [`GET ${path}`]: srv });
  assert.deepEqual(inverseFor(del.entry, { id: REC }), [
    { method: 'POST', path: `/zones/${Z}/dns_records`, body: expected },
  ]);
});

test('rate limiting rule delete re-create keeps ratelimit and exposed_credential_check', async () => {
  const rlRule = {
    id: 'rl1',
    expression: 'http.request.uri.path eq "/login"',
    action: 'block',
    description: 'Login limit',
    enabled: true,
    ratelimit: { characteristics: ['ip.src', 'cf.colo.id'], period: 60, requests_per_period: 10, mitigation_timeout: 600 },
    exposed_credential_check: { username_expression: 'u', password_expression: 'p' },
    version: '1',
  };
  const { entry } = await snapshotOne(
    { method: 'DELETE', path: `/zones/${Z}/rulesets/${RS}/rules/rl1` },
    { [`GET /zones/${Z}/rulesets/${RS}`]: { id: RS, rules: [rlRule] } },
  );
  const [inverse] = inverseFor(entry, { id: RS, rules: [] });
  assert.deepEqual(inverse.body.ratelimit, rlRule.ratelimit);
  assert.deepEqual(inverse.body.exposed_credential_check, rlRule.exposed_credential_check);
  assert.deepEqual(inverse.body.position, { index: 1 });
  assert.ok(!('id' in inverse.body) && !('version' in inverse.body));
});

test('validatePlanOps rejects two ops on the same DNS record', () => {
  const path = `/zones/${Z}/dns_records/${REC}`;
  assert.throws(
    () => validatePlanOps([{ method: 'PATCH', path, body: {} }, { method: 'DELETE', path }]),
    (e) => e instanceof CfError && e.code === 'plan_conflict',
  );
});

test('validatePlanOps rejects two ops on the same rule', () => {
  const path = `/zones/${Z}/rulesets/${RS}/rules/r1`;
  assert.throws(
    () => validatePlanOps([{ method: 'PATCH', path, body: {} }, { method: 'PATCH', path, body: {} }]),
    (e) => e instanceof CfError && e.code === 'plan_conflict',
  );
  assert.throws(
    () => validatePlanOps([{ method: 'PATCH', path, body: {} }, { method: 'DELETE', path }]),
    (e) => e instanceof CfError && e.code === 'plan_conflict',
  );
});

test('validatePlanOps rejects the same phase entrypoint twice', () => {
  const path = `/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint`;
  assert.throws(
    () => validatePlanOps([{ method: 'PUT', path, body: { rules: [] } }, { method: 'PUT', path, body: { rules: [] } }]),
    (e) => e instanceof CfError && e.code === 'plan_conflict',
  );
});

test('validatePlanOps accepts a valid mixed plan', () => {
  const rulesPath = `/zones/${Z}/rulesets/${RS}/rules`;
  assert.doesNotThrow(() =>
    validatePlanOps([
      { method: 'PATCH', path: `/zones/${Z}/settings/ssl`, body: { value: 'strict' } },
      { method: 'PATCH', path: `/zones/${Z}/settings/ssl`, body: { value: 'full' } },
      { method: 'POST', path: `/zones/${Z}/dns_records`, body: {} },
      { method: 'POST', path: `/zones/${Z}/dns_records`, body: {} },
      { method: 'PATCH', path: `/zones/${Z}/dns_records/${REC}`, body: {} },
      { method: 'DELETE', path: `/zones/${Z}/dns_records/abc123` },
      { method: 'POST', path: rulesPath, body: {} },
      { method: 'POST', path: rulesPath, body: {} },
      { method: 'PATCH', path: `${rulesPath}/r1`, body: {} },
      { method: 'DELETE', path: `${rulesPath}/r2` },
      { method: 'PUT', path: `/zones/${Z}/rulesets/phases/http_request_firewall_custom/entrypoint`, body: { rules: [] } },
      { method: 'PUT', path: `/zones/${Z}/rulesets/phases/http_request_dynamic_redirect/entrypoint`, body: { rules: [] } },
      { method: 'POST', path: `/zones/${Z}/purge_cache`, body: { purge_everything: true } },
    ]),
  );
});

test('validatePlanOps rejects more than one rule_delete per ruleset', () => {
  const other = 'eeee5555ffff6666aaaa7777bbbb8888';
  assert.throws(
    () =>
      validatePlanOps([
        { method: 'DELETE', path: `/zones/${Z}/rulesets/${RS}/rules/r1` },
        { method: 'DELETE', path: `/zones/${Z}/rulesets/${RS}/rules/r2` },
      ]),
    (e) => e instanceof CfError && e.code === 'plan_conflict',
  );
  assert.doesNotThrow(() =>
    validatePlanOps([
      { method: 'DELETE', path: `/zones/${Z}/rulesets/${RS}/rules/r1` },
      { method: 'DELETE', path: `/zones/${Z}/rulesets/${other}/rules/r2` },
    ]),
  );
});
