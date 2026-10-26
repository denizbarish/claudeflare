// The MCP execute allowlist: which inspected calls the guard lets through.
import { isTokenEndpoint } from '../../scripts/lib/token-endpoint.mjs';

const GRAPHQL_PATHS = new Set(['/graphql', '/client/v4/graphql']);

// GET .../cfd_tunnel/<id>/token (and the warp_connector and legacy tunnels
// token endpoints) return a token in clear; only `claudeflare tunnel-token`
// reads one, straight into an env file. The path is normalized first
// (decoding, dot segments, repeated slashes, case).
export function isTunnelTokenRead({ path }) {
  return isTokenEndpoint(path);
}

export function isAllowedCall({ method, path }) {
  if (isTunnelTokenRead({ path })) return false;
  // Exact ASCII uppercase literals only: no case mapping ("get", "poſt" are denied).
  if (method === 'GET') return true;
  return method === 'POST' && GRAPHQL_PATHS.has(path);
}
