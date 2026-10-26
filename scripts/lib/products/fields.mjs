// Dot-separated field paths into request and response bodies ("config.client_secret").
// A `*` segment matches every element of an array ("rules.*.secret"). The
// writers return deep copies and never change their input.

const split = (path) => String(path).split('.');
const isContainer = (value) => value !== null && typeof value === 'object';

function clone(obj) {
  return isContainer(obj) ? structuredClone(obj) : obj;
}

// Calls visit(parent, key) for every place the path reaches whose parent
// exists. The last segment is not required to exist on the parent.
function walk(node, segments, visit, create = false) {
  if (!isContainer(node)) return;
  const [head, ...rest] = segments;
  const keys = head === '*' ? (Array.isArray(node) ? node.keys() : []) : [head];
  for (const key of keys) {
    if (rest.length === 0) {
      visit(node, key);
      continue;
    }
    if (create && head !== '*' && !isContainer(node[key])) node[key] = {};
    walk(node[key], rest, visit, create);
  }
}

// One value for a plain path; an array of values (one per element) when the
// path holds a `*`.
export function getPath(obj, path) {
  const segments = split(path);
  const found = [];
  walk(obj, segments, (parent, key) => found.push(parent[key]));
  return segments.includes('*') ? found : found[0];
}

// Missing intermediate objects are created for plain segments; a `*` over a
// missing array sets nothing.
export function setPath(obj, path, value) {
  const out = isContainer(obj) ? clone(obj) : {};
  walk(out, split(path), (parent, key) => { parent[key] = clone(value); }, true);
  return out;
}

export function omitPaths(obj, paths) {
  const out = clone(obj);
  for (const path of paths ?? []) {
    walk(out, split(path), (parent, key) => {
      if (Array.isArray(parent)) return;
      delete parent[key];
    });
  }
  return out;
}

// Only fields that are present are replaced, so a redacted copy never gains keys.
export function redactPaths(obj, paths, mark = '[redacted]') {
  const out = clone(obj);
  for (const path of paths ?? []) {
    walk(out, split(path), (parent, key) => {
      if (parent[key] !== undefined) parent[key] = mark;
    });
  }
  return out;
}
