// Strict reading of MCP "execute" code. Only this grammar is accepted; anything
// else is undeterminable (the guard denies it):
//
//   program    := wrapped | bare
//   wrapped    := "async" "(" ")" "=>" "{" body "}" [";"]
//   bare       := body
//   body       := statement* [returnStmt]
//   statement  := [("const"|"let") IDENT "="] ["await"] call [";"]
//   call       := "cloudflare" "." "request" "(" object ")"
//   object     := "{" [prop ("," prop)* [","]] "}"
//   prop       := key ":" value   (keys: method, path, query, body; each at most once)
//   value      := STRING for method and path; literal (STRING, NUMBER, true, false,
//                 null, or object/array of literals) for query and body
//   returnStmt := "return" retExpr [";"]
//   retExpr    := chain | "[" chain ("," chain)* [","] "]"
//               | "{" retProp ("," retProp)* [","] "}"
//   retProp    := IDENT | IDENT ":" chain
//   chain      := IDENT ("." IDENT)*   (root IDENT declared by a statement)
//
// Comments are skipped. Any backslash, `${`, or character outside the grammar
// rejects the whole program, as does whitespace other than space, tab and \n.
// So does any \r, U+2028 or U+2029 anywhere (JS ends
// `//` comments there too), and any non-ASCII character outside string literals.

const PUNCTUATION = new Set(['{', '}', '[', ']', '(', ')', ',', ':', ';', '.', '=']);
const IDENT = /^[A-Za-z_][A-Za-z0-9_]*/;
const NUMBER = /^\d+(?:\.\d+)?/;
const WHITESPACE = /^[ \t\n]+/;
const LINE_BREAK_TRICKS = /[\r\u2028\u2029]/;
const NON_ASCII = /[^\x00-\x7f]/;
const CALL_KEYS = new Set(['method', 'path', 'query', 'body']);
const STRING_KEYS = new Set(['method', 'path']);
const RESERVED = new Set(['const', 'let', 'await', 'return', 'true', 'false', 'null', 'cloudflare']);

class Reject extends Error {}

function reject() {
  throw new Reject();
}

function readString(code, start) {
  const quote = code[start];
  for (let i = start + 1; i < code.length; i++) {
    const c = code[i];
    if (c === '\\') reject();
    if (quote !== '`' && c === '\n') reject();
    if (quote === '`' && c === '$' && code[i + 1] === '{') reject();
    if (c === quote) return { token: { type: 'string', value: code.slice(start + 1, i) }, end: i + 1 };
  }
  return reject();
}

function checkComment(code, start, end) {
  if (NON_ASCII.test(code.slice(start, end))) reject();
  return end;
}

function skipComment(code, i) {
  if (code.startsWith('//', i)) {
    const end = code.indexOf('\n', i);
    return checkComment(code, i, end < 0 ? code.length : end);
  }
  if (code.startsWith('/*', i)) {
    const end = code.indexOf('*/', i + 2);
    return end < 0 ? reject() : checkComment(code, i, end + 2);
  }
  return i;
}

function tokenize(code) {
  if (LINE_BREAK_TRICKS.test(code)) reject();
  const tokens = [];
  let i = 0;
  while (i < code.length) {
    const rest = code.slice(i);
    const space = WHITESPACE.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const afterComment = skipComment(code, i);
    if (afterComment !== i) {
      i = afterComment;
      continue;
    }
    const c = code[i];
    if (c === "'" || c === '"' || c === '`') {
      const { token, end } = readString(code, i);
      tokens.push(token);
      i = end;
      continue;
    }
    const ident = IDENT.exec(rest);
    if (ident) {
      tokens.push({ type: 'ident', value: ident[0] });
      i += ident[0].length;
      continue;
    }
    const number = NUMBER.exec(rest);
    if (number) {
      tokens.push({ type: 'number', value: number[0] });
      i += number[0].length;
      continue;
    }
    if (code.startsWith('=>', i)) {
      tokens.push({ type: 'punct', value: '=>' });
      i += 2;
      continue;
    }
    if (!PUNCTUATION.has(c)) reject();
    tokens.push({ type: 'punct', value: c });
    i++;
  }
  return tokens;
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
    this.declared = new Set();
    this.calls = [];
  }

  peek(offset = 0) {
    return this.tokens[this.pos + offset];
  }

  is(type, value, offset = 0) {
    const t = this.peek(offset);
    return t !== undefined && t.type === type && (value === undefined || t.value === value);
  }

  expect(type, value) {
    if (!this.is(type, value)) reject();
    return this.tokens[this.pos++];
  }

  accept(type, value) {
    if (!this.is(type, value)) return false;
    this.pos++;
    return true;
  }

  identifier() {
    const name = this.expect('ident').value;
    if (RESERVED.has(name)) reject();
    return name;
  }

  program() {
    if (this.is('ident', 'async')) {
      this.pos++;
      this.expect('punct', '(');
      this.expect('punct', ')');
      this.expect('punct', '=>');
      this.expect('punct', '{');
      this.body(() => this.is('punct', '}'));
      this.expect('punct', '}');
      this.accept('punct', ';');
    } else {
      this.body(() => false);
    }
    if (this.pos !== this.tokens.length) reject();
    return this.calls;
  }

  // Statements until the end of input or atEnd(), then an optional return.
  body(atEnd) {
    while (this.pos < this.tokens.length && !atEnd()) {
      if (this.is('ident', 'return')) {
        this.returnStatement();
        return;
      }
      this.statement();
    }
  }

  statement() {
    if (this.is('ident', 'const') || this.is('ident', 'let')) {
      this.pos++;
      const name = this.identifier();
      if (this.declared.has(name)) reject();
      this.declared.add(name);
      this.expect('punct', '=');
    }
    this.accept('ident', 'await');
    this.call();
    this.accept('punct', ';');
  }

  call() {
    this.expect('ident', 'cloudflare');
    this.expect('punct', '.');
    this.expect('ident', 'request');
    this.expect('punct', '(');
    const props = this.callObject();
    this.expect('punct', ')');
    if (props.method === undefined) reject();
    this.calls.push({ method: props.method, path: props.path ?? null });
  }

  key() {
    const t = this.peek();
    if (t === undefined || (t.type !== 'ident' && t.type !== 'string')) reject();
    this.pos++;
    return t.value;
  }

  callObject() {
    const props = {};
    this.list('{', '}', () => {
      const key = this.key();
      if (!CALL_KEYS.has(key) || Object.hasOwn(props, key)) reject();
      this.expect('punct', ':');
      props[key] = STRING_KEYS.has(key) ? this.expect('string').value : this.literal();
    });
    return props;
  }

  // Comma-separated items between open and close, trailing comma allowed.
  list(open, close, item) {
    this.expect('punct', open);
    while (!this.accept('punct', close)) {
      item();
      if (!this.accept('punct', ',')) {
        this.expect('punct', close);
        return;
      }
    }
  }

  literal() {
    const t = this.peek();
    if (t === undefined) reject();
    if (t.type === 'string' || t.type === 'number') {
      this.pos++;
      return t.value;
    }
    if (t.type === 'ident' && (t.value === 'true' || t.value === 'false' || t.value === 'null')) {
      this.pos++;
      return t.value;
    }
    if (this.is('punct', '{')) {
      return this.list('{', '}', () => {
        this.key();
        this.expect('punct', ':');
        this.literal();
      });
    }
    if (this.is('punct', '[')) return this.list('[', ']', () => this.literal());
    return reject();
  }

  declaredIdentifier() {
    const name = this.identifier();
    if (!this.declared.has(name)) reject();
  }

  // Declared root, then plain property reads only: no calls, no computed access.
  chain() {
    this.declaredIdentifier();
    while (this.accept('punct', '.')) this.expect('ident');
  }

  // Non-empty comma-separated items between open and close, trailing comma allowed.
  nonEmptyList(open, close, item) {
    if (this.is('punct', close, 1)) reject();
    this.list(open, close, item);
  }

  returnStatement() {
    this.expect('ident', 'return');
    if (this.is('punct', '[')) {
      this.nonEmptyList('[', ']', () => this.chain());
    } else if (this.is('punct', '{')) {
      this.nonEmptyList('{', '}', () => {
        if (this.is('punct', ':', 1)) {
          this.identifier();
          this.pos++;
          this.chain();
        } else {
          this.declaredIdentifier();
        }
      });
    } else {
      this.chain();
    }
    this.accept('punct', ';');
  }
}

export function inspectCode(source) {
  try {
    const calls = new Parser(tokenize(String(source))).program();
    return { calls, determinable: true };
  } catch (err) {
    if (err instanceof Reject) return { calls: [], determinable: false };
    throw err;
  }
}
