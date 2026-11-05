import test from 'node:test';
import assert from 'node:assert/strict';
import { createIndex } from '../src/index.ts';

test('search finds whole ASCII tokens, intersects words, and sorts paths', () => {
  const index = createIndex([
    { path: 'z.ts', content: 'RED, blue_blue 42' },
    { path: 'a.ts', content: 'red 42' },
    { path: 'b.ts', content: 'reddish blue' },
  ]);
  assert.deepEqual(index.search('ReD 42'), ['a.ts', 'z.ts']);
  assert.deepEqual(index.search('blue'), ['b.ts']);
  assert.deepEqual(index.search('blue_blue'), ['z.ts']);
  assert.deepEqual(index.search('  '), []);
});

test('upsert replaces content, removes absent paths, and copies inputs', () => {
  const doc = { path: 'a', content: 'old' };
  const index = createIndex([doc]);
  doc.content = 'changed';
  assert.deepEqual(index.search('old'), ['a']);
  index.upsert({ path: 'a', content: 'new' });
  assert.deepEqual(index.search('old'), []);
  assert.deepEqual(index.search('new'), ['a']);
  assert.equal(index.remove('a'), true);
  assert.equal(index.remove('a'), false);
});

test('duplicate initial paths use final content and inputs are validated', () => {
  const index = createIndex([{ path: 'a', content: 'one' }, { path: 'a', content: 'two' }]);
  assert.deepEqual(index.search('one'), []);
  assert.deepEqual(index.search('two'), ['a']);
  assert.throws(() => index.upsert({ path: '', content: 'x' }), TypeError);
  assert.throws(() => index.remove(''), TypeError);
  assert.throws(() => createIndex([{ path: 'a', content: 3 } as never]), TypeError);
});
