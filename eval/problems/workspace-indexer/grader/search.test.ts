import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(`${process.env.EVAL_WORKSPACE}/src/index.ts`).href);
const documents = [
  { path: 'a', content: 'red blue red blue' },
  { path: 'b', content: 'red green' },
  { path: 'c', content: 'blue green green' },
  { path: 'empty', content: '' },
];

test('positional inverted postings are normalized, sorted, copied, and incremental', () => {
  const index = api.createIndex(documents);
  assert.deepEqual(index.getPostings('RED'), [{ path: 'a', positions: [0, 2] }, { path: 'b', positions: [0] }]);
  const result = index.getPostings('red');
  result[0].positions.push(99); result.pop();
  assert.equal(index.getPostings('red')[0].positions.length, 2);
  index.applyBatch([{ type: 'upsert', path: 'a', content: 'green red' }, { type: 'remove', path: 'b' }]);
  assert.deepEqual(index.getPostings('red'), [{ path: 'a', positions: [1] }]);
  assert.deepEqual(index.getPostings('blue'), [{ path: 'c', positions: [0] }]);
  assert.deepEqual(index.search('"green red" OR NOT (red OR green)'), ['a', 'empty']);
  for (const term of ['', 'red blue', '*', null, 'é']) assert.throws(() => index.getPostings(term), TypeError);
});

test('ranking uses corpus frequency, term frequency, phrase boosts, and path tie order', () => {
  const index = api.createIndex(documents);
  const weight = 1 + Math.log(5 / 3);
  assert.deepEqual(index.searchRanked('red'), [{ path: 'a', score: 2 * weight }, { path: 'b', score: weight }]);
  assert.deepEqual(index.searchRanked('red OR red'), index.searchRanked('red'));
  assert.deepEqual(index.searchRanked('"red blue"'), [{ path: 'a', score: 4 * weight + 4 }]);
  assert.deepEqual(index.searchRanked('NOT red'), [{ path: 'c', score: 0 }, { path: 'empty', score: 0 }]);
  assert.deepEqual(index.searchRanked('NOT NOT red'), index.searchRanked('red'));
  assert.deepEqual(index.searchRanked('red OR NOT green', 1), [{ path: 'a', score: 2 * weight }]);
  assert.deepEqual(index.searchRanked('path:a OR path:b'), [{ path: 'a', score: 0 }, { path: 'b', score: 0 }]);
  for (const limit of [-1, 1.5, NaN, Infinity, '1', null]) assert.throws(() => index.searchRanked('red', limit), TypeError);
  assert.throws(() => index.searchRanked('red OR', 0), SyntaxError);
  assert.deepEqual(index.searchRanked('red', 0), []);
});

test('phrase normalization, overlap, polarity, branch-independent scoring, and result ownership', () => {
  const index = api.createIndex([{ path: 'a', content: 'x x x' }, { path: 'b', content: 'x' }]);
  assert.deepEqual(index.searchRanked('"x x" OR "X,X"'), [{ path: 'a', score: 7 }]);
  assert.deepEqual(index.searchRanked('"x"'), [{ path: 'a', score: 9 }, { path: 'b', score: 3 }]);
  assert.deepEqual(index.searchRanked('path:a OR (x AND NOT path:a)'), [{ path: 'a', score: 3 }, { path: 'b', score: 1 }]);
  assert.deepEqual(index.searchRanked('NOT (NOT x OR missing)'), [{ path: 'a', score: 3 }, { path: 'b', score: 1 }]);
  const hits = index.searchRanked('x'); hits[0].score = -1; hits.pop();
  assert.deepEqual(index.searchRanked('x'), [{ path: 'a', score: 3 }, { path: 'b', score: 1 }]);
});

test('rank corpus statistics change after replace/remove and survive snapshot restoration', () => {
  const index = api.createIndex(documents);
  index.upsert({ path: 'b', content: 'blue blue' }); index.remove('empty');
  const restored = api.restoreIndex(index.snapshot());
  assert.deepEqual(restored.searchRanked('blue OR red'), index.searchRanked('blue OR red'));
  assert.equal(index.searchRanked('red')[0].score, 2 * (1 + Math.log(4 / 2)));
  assert.deepEqual(index.getPostings('red'), [{ path: 'a', positions: [0, 2] }]);
});

test('mixed Boolean sets and overlapping phrases stay consistent through a long update sequence', () => {
  const index = api.createIndex();
  const truth = new Map();
  for (let step = 0; step < 90; step++) {
    const path = `p${step % 11}`;
    const content = step % 3 ? 'a a b' : 'b c';
    if (step % 5 === 0) { index.remove(path); truth.delete(path); }
    else { index.upsert({ path, content }); truth.set(path, content); }
    const expected = [...truth].filter(([, text]) => text === 'a a b').map(([path]) => path).sort();
    assert.deepEqual(index.search('"a a" AND NOT c'), expected);
    assert.deepEqual(index.searchRanked('a').map(hit => hit.path), expected);
    assert.deepEqual(api.restoreIndex(index.snapshot()).getPostings('b'), index.getPostings('b'));
  }
});
