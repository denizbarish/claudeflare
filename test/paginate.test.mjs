import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../scripts/lib/api.mjs';
import { listAll, MAX_PAGES } from '../scripts/lib/paginate.mjs';

// pages(query) returns the envelope { result, result_info } for one request.
function pagedClient(pages) {
  const calls = [];
  return {
    calls,
    async request(method, path, opts = {}) {
      calls.push({ method, path, query: { ...opts.query }, envelope: opts.envelope });
      assert.equal(opts.envelope, true, 'listAll must ask for the envelope');
      return pages(opts.query ?? {});
    },
  };
}

const items = (from, count) => Array.from({ length: count }, (_, i) => ({ id: `r${from + i}` }));

test('listAll reads three pages', async () => {
  const client = pagedClient(({ page }) => ({
    result: page === 3 ? items(4, 1) : items((page - 1) * 2, 2),
    result_info: { page, per_page: 2, total_pages: 3 },
  }));
  const all = await listAll(client, '/accounts/a/rules', { query: { kind: 'x' }, perPage: 2 });
  assert.deepEqual(all.map((r) => r.id), ['r0', 'r1', 'r2', 'r3', 'r4']);
  assert.deepEqual(client.calls.map((c) => c.query), [
    { kind: 'x', page: 1, per_page: 2 },
    { kind: 'x', page: 2, per_page: 2 },
    { kind: 'x', page: 3, per_page: 2 },
  ]);
  assert.ok(client.calls.every((c) => c.method === 'GET' && c.path === '/accounts/a/rules'));
});

test('listAll stops on a short page when total_pages is missing, default perPage 50', async () => {
  const client = pagedClient(({ page }) => ({ result: page === 1 ? items(0, 50) : items(50, 3) }));
  const all = await listAll(client, '/x');
  assert.equal(all.length, 53);
  assert.equal(client.calls.length, 2);
  assert.equal(client.calls[0].query.per_page, 50);
});

test('listAll follows cursor pagination', async () => {
  const cursors = { undefined: 'c1', c1: 'c2', c2: '' };
  const client = pagedClient(({ cursor }) => ({ result: items(0, 2), result_info: { cursor: cursors[cursor] } }));
  const all = await listAll(client, '/x', { perPage: 2, cursor: true });
  assert.equal(all.length, 6);
  assert.deepEqual(client.calls.map((c) => c.query), [
    { per_page: 2 },
    { per_page: 2, cursor: 'c1' },
    { per_page: 2, cursor: 'c2' },
  ]);
});

test('listAll throws too_large beyond the page cap', async () => {
  const client = pagedClient(({ page }) => ({ result: items(page, 1), result_info: { total_pages: 500 } }));
  await assert.rejects(listAll(client, '/x', { perPage: 1 }), (err) => err.code === 'too_large' && /\/x/.test(err.message));
  assert.equal(client.calls.length, MAX_PAGES);
});

test('listAll treats a missing result as an empty page', async () => {
  const client = pagedClient(() => ({ result: null }));
  assert.deepEqual(await listAll(client, '/x'), []);
});

test('client request returns the whole envelope when asked', async () => {
  const body = { success: true, result: [1], result_info: { total_pages: 1 } };
  const client = createClient({ token: 't', fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }) });
  assert.deepEqual(await client.request('GET', '/x', { envelope: true }), body);
  assert.deepEqual(await client.request('GET', '/x'), [1]);
});
