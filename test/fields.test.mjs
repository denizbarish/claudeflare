import { test } from 'node:test';
import assert from 'node:assert/strict';
import { getPath, setPath, omitPaths, redactPaths } from '../scripts/lib/products/fields.mjs';

test('getPath reads nested values and returns undefined for missing ones', () => {
  const obj = { a: { b: 1, c: null }, list: [{ x: 1 }, { y: 2 }, { x: 3 }] };
  assert.equal(getPath(obj, 'a.b'), 1);
  assert.equal(getPath(obj, 'a.c'), null);
  assert.equal(getPath(obj, 'a.z'), undefined);
  assert.equal(getPath(obj, 'a.b.deeper'), undefined);
  assert.equal(getPath(undefined, 'a'), undefined);
  assert.deepEqual(getPath(obj, 'list.*.x'), [1, undefined, 3]);
  assert.deepEqual(getPath(obj, 'missing.*.x'), []);
});

test('setPath returns a copy and leaves the input unchanged', () => {
  const obj = { a: { b: 1 }, keep: { k: true } };
  const out = setPath(obj, 'a.b', 2);
  assert.deepEqual(out, { a: { b: 2 }, keep: { k: true } });
  assert.deepEqual(obj, { a: { b: 1 }, keep: { k: true } });
  assert.notEqual(out.a, obj.a);
  assert.deepEqual(setPath({}, 'x.y.z', 'v'), { x: { y: { z: 'v' } } });
  const listed = setPath({ rules: [{ secret: 'a' }, { secret: 'b' }] }, 'rules.*.secret', 'S');
  assert.deepEqual(listed, { rules: [{ secret: 'S' }, { secret: 'S' }] });
});

test('omitPaths removes config.client_secret from a copy', () => {
  const obj = { name: 'okta', config: { client_id: 'id', client_secret: 's3cret' } };
  const out = omitPaths(obj, ['config.client_secret', 'missing.path']);
  assert.deepEqual(out, { name: 'okta', config: { client_id: 'id' } });
  assert.equal(obj.config.client_secret, 's3cret');
});

test('redactPaths marks rules.*.secret in a copy and skips absent fields', () => {
  const obj = { rules: [{ name: 'a', secret: 'one' }, { name: 'b' }, { name: 'c', secret: 'three' }] };
  const out = redactPaths(obj, ['rules.*.secret']);
  assert.deepEqual(out, { rules: [{ name: 'a', secret: '[redacted]' }, { name: 'b' }, { name: 'c', secret: '[redacted]' }] });
  assert.equal(obj.rules[0].secret, 'one');
  assert.deepEqual(redactPaths({ token: 't' }, ['token'], '***'), { token: '***' });
  assert.equal(redactPaths(null, ['a']), null);
});
