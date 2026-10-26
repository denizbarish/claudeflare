// Reads every page of a Cloudflare list endpoint. Dependency scans and
// lockout analysis use it so an in-use resource on a later page is never
// mistaken for unused.

import { CfError } from './errors.mjs';

export const MAX_PAGES = 200;

// A reply without an array `result` would make a scan look empty, so an
// in-use resource would pass as unused: refuse it.
function pageItems(envelope, path) {
  if (!Array.isArray(envelope?.result)) {
    throw new CfError('api', `${path} did not return a list envelope ({ result: [...] }); refusing to scan`);
  }
  return envelope.result;
}

function tooLarge(path) {
  return new CfError('too_large', `${path} has more than ${MAX_PAGES} pages; refusing to scan a partial list`);
}

// Identity of a page by its first row: the id, or the whole row when it has
// none (Gateway list items).
function firstKey(items) {
  if (!items.length) return null;
  const first = items[0];
  return first !== null && typeof first === 'object' && first.id !== undefined ? `id:${first.id}` : `row:${JSON.stringify(first)}`;
}

// Page mode stops at result_info.total_pages or at a page shorter than
// perPage; cursor mode follows result_info.cursor until it is empty. An
// endpoint that ignores paging (Ruling 23) ends the scan too: a page without
// result_info and with more rows than perPage is the whole list, and a page
// that starts with the previous page's first row is a repeat, not new rows
// (page mode only).
// Genuinely long lists still stop at MAX_PAGES with too_large.
export async function listAll(client, path, { query = {}, perPage = 50, cursor = false } = {}) {
  const all = [];
  let next;
  let previous = null;
  for (let page = 1; ; page++) {
    if (page > MAX_PAGES) throw tooLarge(path);
    const pageQuery = cursor
      ? { ...query, per_page: perPage, ...(next ? { cursor: next } : {}) }
      : { ...query, page, per_page: perPage };
    const envelope = await client.request('GET', path, { query: pageQuery, envelope: true });
    const items = pageItems(envelope, path);
    const key = firstKey(items);
    // A cursor moves on by itself; only page mode can repeat a page.
    if (!cursor && page > 1 && key !== null && key === previous) return all;
    previous = key;
    all.push(...items);
    const info = envelope?.result_info;
    if (cursor) {
      next = typeof info?.cursor === 'string' ? info.cursor : '';
      if (!next) return all;
      continue;
    }
    if (!info && items.length !== perPage) return all;
    const total = Number(info?.total_pages);
    if (Number.isFinite(total) && total > 0 ? page >= total : items.length < perPage) return all;
  }
}
