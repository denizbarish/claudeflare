// Cloudflare endpoints that return a connector token in clear: the tunnel
// token (cfd_tunnel, legacy tunnels) and the WARP connector token. Only
// `claudeflare tunnel-token` reads one, straight into an env file. The CLI's
// `get` and the guard's MCP allowlist refuse them after normalizing the path,
// so quoting, encoding or dot segments cannot reach them. No imports: the
// guard hooks load this file.

export const TUNNEL_TOKEN_REASON =
  'Tunnel tokens are never read into the conversation. Run "claudeflare tunnel-token --account <id> --tunnel <id> --env-path <path>" to write the token into an env file without showing it.';

// Resources whose /<id>/token endpoint returns a token.
export const TOKEN_RESOURCES = ['cfd_tunnel', 'warp_connector', 'tunnels'];

const TOKEN_PATH = new RegExp(`^/accounts/[^/]+/(?:${TOKEN_RESOURCES.join('|')})/[^/]+/token$`);
// Same bound as canonicalRest: enough for triple encoding, cannot loop.
const DECODE_ROUNDS = 3;

const decodeEscapes = (text) => text.replace(/%[0-9a-f]{2}/gi, (hex) => String.fromCharCode(parseInt(hex.slice(1), 16)));

// Resolves . and .. segments the way a URL parser does.
function removeDotSegments(path) {
  const out = [];
  for (const segment of path.split('/').slice(1)) {
    if (segment === '..') out.pop();
    else if (segment !== '.') out.push(segment);
  }
  return `/${out.join('/')}`;
}

// The path an API request would reach: query and fragment dropped, percent
// escapes decoded (bounded rounds), backslashes as slashes, repeated and
// trailing slashes collapsed, dot segments resolved, lowercased, without the
// /client/v4 prefix.
export function normalizeApiPath(path) {
  let text = String(path);
  for (let round = 0; round < DECODE_ROUNDS; round++) {
    const next = decodeEscapes(text);
    if (next === text) break;
    text = next;
  }
  text = text.split(/[?#]/)[0].replace(/\\/g, '/').toLowerCase();
  const collapsed = `/${text}`.replace(/\/{2,}/g, '/');
  return removeDotSegments(collapsed).replace(/^\/client\/v4(?=\/|$)/, '').replace(/\/+$/, '') || '/';
}

export function isTokenEndpoint(path) {
  return typeof path === 'string' && TOKEN_PATH.test(normalizeApiPath(path));
}
