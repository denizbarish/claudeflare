// Kind matching shared by the registry (classifyProductOp) and product
// modules, which see only an op in notes and lockoutRisks. Kept apart from
// index.mjs so modules can import it without an import cycle.

const TARGET = /^(\/(accounts|zones)\/[^/?]+)(\/[^?]*)/;

// { scope, base, rest } of an absolute op path, rest without the query; null
// for a path outside /accounts/<id>/ and /zones/<id>/.
export function opTarget(op) {
  const m = TARGET.exec(String(op?.path ?? ''));
  return m ? { scope: m[2] === 'accounts' ? 'account' : 'zone', base: m[1], rest: m[3] } : null;
}

// First kind in kinds with this scope and method whose pattern matches rest.
export function matchKind(kinds, method, scope, rest) {
  const upper = String(method ?? '').toUpperCase();
  for (const entry of kinds) {
    if (entry.scope !== scope || !entry.methods.includes(upper)) continue;
    const match = entry.pattern.exec(rest);
    if (match) return { entry, match };
  }
  return null;
}
