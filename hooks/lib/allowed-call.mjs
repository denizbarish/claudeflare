// The MCP execute allowlist: which inspected calls the guard lets through.
const GRAPHQL_PATHS = new Set(['/graphql', '/client/v4/graphql']);

export function isAllowedCall({ method, path }) {
  // Exact ASCII uppercase literals only: no case mapping ("get", "poſt" are denied).
  if (method === 'GET') return true;
  return method === 'POST' && GRAPHQL_PATHS.has(path);
}
