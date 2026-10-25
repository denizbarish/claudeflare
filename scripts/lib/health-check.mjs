// Post-deploy health check: GET only, redirects are not followed, each try is
// bounded by a timeout. A try passes when the status equals expect_status.

const DEFAULT_TRIES = 3;
const DEFAULT_INTERVAL_MS = 5000;
const DEFAULT_TIMEOUT_MS = 10000;
const DEFAULT_EXPECT_STATUS = 200;

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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
    return response.status;
  } catch {
    return null; // network error or timeout
  }
}

// Returns { ok, status, attempts }; status is the last HTTP status seen, or
// null when no try got a response.
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
  let status = null;
  for (let attempt = 1; attempt <= tries; attempt++) {
    status = await tryOnce(fetchImpl, url, timeoutMs);
    if (status === expectStatus) return { ok: true, status, attempts: attempt };
    if (attempt < tries) await sleep(intervalMs);
  }
  return { ok: false, status, attempts: tries };
}
