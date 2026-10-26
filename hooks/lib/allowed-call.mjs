// The MCP execute allowlist: which inspected calls the guard lets through.
const GRAPHQL_PATHS = new Set(['/graphql', '/client/v4/graphql']);
// GET /accounts/<id>/cfd_tunnel/<id>/token returns the tunnel token in clear;
// only `claudeflare tunnel-token` reads it, straight into an env file.
const TUNNEL_TOKEN_PATH = /^\/(?:client\/v4\/)?accounts\/[^/]+\/cfd_tunnel\/[^/]+\/token\/?(?:[?#]|$)/i;

export function isTunnelTokenRead({ path }) {
  return typeof path === 'string' && TUNNEL_TOKEN_PATH.test(path);
}

export function isAllowedCall({ method, path }) {
  if (isTunnelTokenRead({ path })) return false;
  // Exact ASCII uppercase literals only: no case mapping ("get", "poſt" are denied).
  if (method === 'GET') return true;
  return method === 'POST' && GRAPHQL_PATHS.has(path);
}
