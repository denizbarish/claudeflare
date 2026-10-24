import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient, redact } from '../scripts/lib/api.mjs';
import { CfError, mapError } from '../scripts/lib/errors.mjs';

const TOKEN = 'tok_secret_123';
const BASE = 'https://api.test/client/v4';

function jsonResponse(status, body, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

function mockFetch(responses) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses[Math.min(calls.length - 1, responses.length - 1)];
    return typeof next === 'function' ? next() : next;
  };
  return { fetchImpl, calls };
}

function fakeSleep() {
  const waits = [];
  const sleep = async (ms) => {
    waits.push(ms);
  };
  return { sleep, waits };
}

const ok = (result) => () => jsonResponse(200, { success: true, errors: [], result });
const rateLimited = (headers = {}) => () =>
  jsonResponse(429, { success: false, errors: [{ code: 10013, message: 'Rate limited' }] }, headers);

test('request sends Bearer token and JSON body, returns result', async () => {
  const { fetchImpl, calls } = mockFetch([ok({ id: 'abc' })]);
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  const result = await client.request('POST', '/zones/z1/dns_records', {
    query: { page: 2 },
    body: { type: 'A', name: 'www' },
  });
  assert.deepEqual(result, { id: 'abc' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE}/zones/z1/dns_records?page=2`);
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
  assert.deepEqual(JSON.parse(calls[0].init.body), { type: 'A', name: 'www' });
});

test('request without body sends no body and no Content-Type', async () => {
  const { fetchImpl, calls } = mockFetch([ok([])]);
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  await client.request('GET', '/zones');
  assert.equal(calls[0].url, `${BASE}/zones`);
  assert.equal(calls[0].init.body, undefined);
  assert.equal(calls[0].init.headers['Content-Type'], undefined);
});

test('429 retries honoring Retry-After seconds, then succeeds', async () => {
  const { fetchImpl, calls } = mockFetch([rateLimited({ 'Retry-After': '2' }), ok('done')]);
  const { sleep, waits } = fakeSleep();
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl, sleep });
  const result = await client.request('GET', '/zones');
  assert.equal(result, 'done');
  assert.equal(calls.length, 2);
  assert.deepEqual(waits, [2000]);
});

test('429 without Retry-After uses exponential backoff 1000, 2000, 4000', async () => {
  const { fetchImpl, calls } = mockFetch([rateLimited(), rateLimited(), rateLimited(), ok('done')]);
  const { sleep, waits } = fakeSleep();
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl, sleep });
  const result = await client.request('GET', '/zones');
  assert.equal(result, 'done');
  assert.equal(calls.length, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
});

test('gives up after maxRetries with CfError code rate_limit', async () => {
  const { fetchImpl, calls } = mockFetch([rateLimited()]);
  const { sleep, waits } = fakeSleep();
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl, sleep, maxRetries: 2 });
  await assert.rejects(client.request('GET', '/zones'), (err) => {
    assert.ok(err instanceof CfError);
    assert.equal(err.code, 'rate_limit');
    assert.equal(err.status, 429);
    return true;
  });
  assert.equal(calls.length, 3);
  assert.deepEqual(waits, [1000, 2000]);
});

test('9109 maps to code permission with hint mentioning docs/token-template.md', async () => {
  const body = { success: false, errors: [{ code: 9109, message: 'Missing permission Zone.DNS Edit' }] };
  const { fetchImpl } = mockFetch([() => jsonResponse(403, body)]);
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  await assert.rejects(client.request('GET', '/zones'), (err) => {
    assert.ok(err instanceof CfError);
    assert.equal(err.code, 'permission');
    assert.deepEqual(err.cfCodes, [9109]);
    assert.match(err.hint, /Zone\.DNS Edit/);
    assert.match(err.hint, /see docs\/token-template\.md/);
    return true;
  });
  const direct = mapError(200, { success: false, errors: [{ code: 10000, message: 'Authentication error' }] });
  assert.equal(direct.code, 'permission');
});

test('mapError maps 404, plan-gated, and other errors', () => {
  assert.equal(mapError(404, { errors: [{ code: 7003, message: 'Could not route' }] }).code, 'not_found');
  assert.equal(mapError(429, null).code, 'rate_limit');
  assert.equal(
    mapError(400, { errors: [{ code: 1000, message: 'This feature is not available on your plan' }] }).code,
    'plan',
  );
  const other = mapError(400, { errors: [{ code: 1004, message: 'DNS Validation Error' }] });
  assert.equal(other.code, 'api');
  assert.equal(other.status, 400);
  assert.deepEqual(other.cfCodes, [1004]);
  assert.equal(mapError(500, null).code, 'api');
});

test('success false on a 2xx is thrown as CfError', async () => {
  const body = { success: false, errors: [{ code: 1004, message: 'DNS Validation Error' }] };
  const { fetchImpl } = mockFetch([() => jsonResponse(200, body)]);
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  await assert.rejects(client.request('GET', '/zones'), (err) => err instanceof CfError && err.code === 'api');
});

test('network failure becomes CfError code network with token redacted', async () => {
  const fetchImpl = async () => {
    throw new Error(`connect failed for ${TOKEN}`);
  };
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  await assert.rejects(client.request('GET', '/zones'), (err) => {
    assert.ok(err instanceof CfError);
    assert.equal(err.code, 'network');
    assert.ok(!err.message.includes(TOKEN));
    return true;
  });
});

test('missing token throws CfError code missing_token', () => {
  assert.throws(
    () => createClient({ token: '', baseUrl: BASE, fetchImpl: async () => {} }),
    (err) => err instanceof CfError && err.code === 'missing_token',
  );
});

test('error message never contains the token even if body echoes it', async () => {
  const body = { success: false, errors: [{ code: 9109, message: `Invalid token ${TOKEN} lacks Zone Read` }] };
  const { fetchImpl } = mockFetch([() => jsonResponse(403, body)]);
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  await assert.rejects(client.request('GET', '/zones'), (err) => {
    assert.ok(!err.message.includes(TOKEN));
    assert.ok(!err.hint.includes(TOKEN));
    assert.ok(err.message.includes('[REDACTED]'));
    return true;
  });
});

test('path placeholders are not resolved by client', async () => {
  const { fetchImpl, calls } = mockFetch([ok([])]);
  const client = createClient({ token: TOKEN, baseUrl: BASE, fetchImpl });
  await client.request('GET', '/zones/{zone_id}/dns_records');
  assert.equal(calls[0].url, `${BASE}/zones/{zone_id}/dns_records`);
});

test('redact replaces every token occurrence and is a no-op for empty token', () => {
  assert.equal(redact(`a ${TOKEN} b ${TOKEN}`, TOKEN), 'a [REDACTED] b [REDACTED]');
  assert.equal(redact('unchanged', ''), 'unchanged');
});
