// Post-deploy health check: GET only, redirects are not followed, each try is
// bounded by a timeout. A try passes when the status equals expect_status.
// A redirect's target is reported without its query string or fragment.

const DEFAULT_TRIES = 3;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_EXPECT_STATUS = 200;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function redirectTarget(response, url) {
  const location = response.headers?.get?.('location');
  if (!location) return null;
  try {
    const target = new URL(location, url);
    return `${target.origin}${target.pathname}`;
  } catch {
    return null;
  }
}

async function tryOnce(fetchImpl, url, timeoutMs) {
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    try {
      await response.body?.cancel?.();
    } catch {
      // The status is all that matters; a body that cannot be cancelled is ignored.
    }
    const location = response.status >= 300 && response.status < 400 ? redirectTarget(response, url) : null;
    return { status: response.status, location };
  } catch {
    return { status: null, location: null }; // network error or timeout
  }
}

// Returns { ok, status, attempts, location? }; status is the last HTTP status
// seen, or null when no try got a response; location is the last redirect target.
export async function runHealthCheck(
  { url, expect_status: expectStatus = DEFAULT_EXPECT_STATUS },
  {
    fetchImpl = globalThis.fetch,
    sleep = defaultSleep,
    tries = DEFAULT_TRIES,
    intervalMs = DEFAULT_INTERVAL_MS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = {},
) {
  let last = { status: null, location: null };
  for (let attempt = 1; attempt <= tries; attempt++) {
    last = await tryOnce(fetchImpl, url, timeoutMs);
    if (last.status === expectStatus) return { ok: true, status: last.status, attempts: attempt };
    if (attempt < tries) await sleep(intervalMs);
  }
  const out = { ok: false, status: last.status, attempts: tries };
  if (last.location) out.location = last.location;
  return out;
}
