// Best-effort static reading of MCP "execute" code: finds every `request(` call
// and reads `method` and `path` from its object argument, but only when they are
// plain string literals. Anything it cannot read comes back as null, and callers
// must treat null as "unknown" (deny), never as "safe".

const QUOTES = new Set(["'", '"', '`']);
const OPENERS = '{[(';
const CLOSERS = '}])';
const CALL = /request\s*\(/g;
// `request` used any other way (alias, .call/.apply, bracket access) or a direct
// fetch() means calls can escape the scan above.
const REQUEST_NOT_CALLED = /\brequest\b(?!\s*\()/;
const FETCH_CALL = /\bfetch\s*\(/;
const PROPERTY = /^\s*(?:([A-Za-z_$][\w$]*)|'([^'\\]*)'|"([^"\\]*)")\s*:\s*([\s\S]*?)\s*$/;
const SHORTHAND = /^\s*([A-Za-z_$][\w$]*)\s*$/;
const LITERAL = /^(?:'([^'\\\n]*)'|"([^"\\\n]*)"|`([^`\\$]*)`)$/;

// Index just past the string starting at `start`, or -1 if it never closes.
function skipString(code, start) {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') {
      i++;
    } else if (c === quote) {
      return i + 1;
    } else if (quote === '`' && c === '$' && code[i + 1] === '{') {
      const end = matchingClose(code, i + 1);
      if (end < 0) return -1;
      i = end;
    }
  }
  return -1;
}

// Index just past the comment starting at `start`, `start` if there is none,
// or -1 for an unterminated block comment.
function skipComment(code, start) {
  if (code[start] !== '/') return start;
  if (code[start + 1] === '/') {
    const end = code.indexOf('\n', start);
    return end < 0 ? code.length : end;
  }
  if (code[start + 1] === '*') {
    const end = code.indexOf('*/', start + 2);
    return end < 0 ? -1 : end + 2;
  }
  return start;
}

// Walks code from `open` (a bracket), calling visit(char, index, depth) for every
// character outside strings and comments. Returns the index of the matching close
// bracket, or -1 if the brackets do not balance.
function walk(code, open, visit = () => {}) {
  let depth = 0;
  let i = open;
  while (i < code.length) {
    const c = code[i];
    if (QUOTES.has(c)) {
      i = skipString(code, i);
      if (i < 0) return -1;
      continue;
    }
    const afterComment = skipComment(code, i);
    if (afterComment < 0) return -1;
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    if (OPENERS.includes(c)) depth++;
    else if (CLOSERS.includes(c)) depth--;
    if (depth === 0) return i;
    visit(c, i, depth);
    i++;
  }
  return -1;
}

function matchingClose(code, open) {
  return walk(code, open);
}

// Top-level property segments of the object literal spanning open..close.
function topLevelSegments(code, open, close) {
  const segments = [];
  let start = open + 1;
  walk(code, open, (c, i, depth) => {
    if (c === ',' && depth === 1) {
      segments.push(code.slice(start, i));
      start = i + 1;
    }
  });
  segments.push(code.slice(start, close));
  return segments.filter((s) => s.trim() !== '');
}

function literalValue(source) {
  const m = LITERAL.exec(source);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}

// Reads `method` and `path` from an object literal. A spread, a duplicate key, a
// shorthand or a non-literal value makes that field null. `recognised` is false
// when any segment is not a plain `key: value`, shorthand or spread (computed or
// escaped keys, getters, methods), since such a segment may set the method.
function readCallObject(code, open, close) {
  const values = { method: [], path: [] };
  let hasSpread = false;
  let recognised = true;
  for (const segment of topLevelSegments(code, open, close)) {
    if (segment.trim().startsWith('...')) {
      hasSpread = true;
      continue;
    }
    const prop = PROPERTY.exec(segment);
    const key = prop ? (prop[1] ?? prop[2] ?? prop[3]) : SHORTHAND.exec(segment)?.[1];
    if (key === undefined) {
      recognised = false;
      continue;
    }
    if (Object.hasOwn(values, key)) values[key].push(prop ? literalValue(prop[4]) : null);
  }
  const pick = (list) => (!hasSpread && list.length === 1 ? list[0] : null);
  return { call: { method: pick(values.method), path: pick(values.path) }, recognised };
}

function firstArgumentStart(code, from) {
  let i = from;
  while (i < code.length) {
    if (/\s/.test(code[i])) {
      i++;
      continue;
    }
    const afterComment = skipComment(code, i);
    if (afterComment < 0) return -1;
    if (afterComment === i) return i;
    i = afterComment;
  }
  return -1;
}

export function inspectCode(source) {
  const code = String(source);
  const calls = [];
  let determinable = !REQUEST_NOT_CALLED.test(code) && !FETCH_CALL.test(code);
  for (const match of code.matchAll(CALL)) {
    const argStart = firstArgumentStart(code, match.index + match[0].length);
    const close = argStart >= 0 && code[argStart] === '{' ? matchingClose(code, argStart) : -1;
    if (close < 0) {
      calls.push({ method: null, path: null });
      determinable = false;
      continue;
    }
    const { call, recognised } = readCallObject(code, argStart, close);
    if (!recognised || call.method === null) determinable = false;
    calls.push(call);
  }
  return { calls, determinable };
}
