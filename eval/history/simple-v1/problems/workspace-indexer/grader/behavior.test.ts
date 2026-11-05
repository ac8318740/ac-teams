import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';

const workspace = process.env.EVAL_WORKSPACE;
if (!workspace || !workspace.startsWith('/')) throw new Error('EVAL_WORKSPACE must be an absolute target directory');
const api = await import(pathToFileURL(`${workspace}/src/index.ts`).href);
const docs = [
  { path: 'src/a.ts', content: 'Red quick, brown fox and 42 under_score' },
  { path: 'src/b.ts', content: 'blue quick fox brown' },
  { path: 'vendor/c.ts', content: 'red green brown fox' },
  { path: 'EMPTY', content: '' },
];
const fresh = () => api.createIndex(docs);

test('token boundaries, ASCII case, uniqueness, and fresh result arrays', () => {
  const index = api.createIndex([
    { path: 'z', content: 'RED red reddish under_score 42 İ' },
    { path: 'A', content: 'red' }, { path: 'a', content: 'red' },
  ]);
  const result = index.search('rEd');
  assert.deepEqual(result, ['A', 'a', 'z']);
  result.pop();
  assert.deepEqual(index.search('red'), ['A', 'a', 'z']);
  assert.deepEqual(index.search('under'), []);
  assert.deepEqual(index.search('under_score 42'), ['z']);
  assert.deepEqual(index.search('i'), []);
  assert.deepEqual(index.search('   '), []);
});

test('OR, explicit/implicit AND, and NOT precedence', () => {
  const index = fresh();
  assert.deepEqual(index.search('red OR blue AND NOT brown'), ['src/a.ts', 'vendor/c.ts']);
  assert.deepEqual(index.search('red brown'), ['src/a.ts', 'vendor/c.ts']);
  assert.deepEqual(index.search('red NOT green'), ['src/a.ts']);
  assert.deepEqual(index.search('NOT NOT red'), ['src/a.ts', 'vendor/c.ts']);
  assert.deepEqual(index.search('NOT red'), ['EMPTY', 'src/b.ts']);
});

test('nested grouping and adjacency next to parentheses', () => {
  const index = fresh();
  assert.deepEqual(index.search('(red OR blue) AND NOT (green OR missing)'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(index.search('red(quick OR green)'), ['src/a.ts', 'vendor/c.ts']);
  assert.deepEqual(index.search('(red)(quick)'), ['src/a.ts']);
});

test('phrases use contiguous normalized tokens, not substrings', () => {
  const index = fresh();
  assert.deepEqual(index.search('"QUICK, brown"'), ['src/a.ts']);
  assert.deepEqual(index.search('"brown fox"'), ['src/a.ts', 'vendor/c.ts']);
  assert.deepEqual(index.search('"quick fox"'), ['src/b.ts']);
  assert.deepEqual(index.search('"and"'), ['src/a.ts']);
  assert.deepEqual(index.search('and'), ['src/a.ts']);
  assert.deepEqual(index.search('"rown"'), []);
});

test('path prefixes are literal and case-sensitive and compose with operators', () => {
  const index = fresh();
  assert.deepEqual(index.search('path:src/ AND (red OR blue)'), ['src/a.ts', 'src/b.ts']);
  assert.deepEqual(index.search('red NOT path:vendor/'), ['src/a.ts']);
  assert.deepEqual(index.search('path:SRC/'), []);
  assert.deepEqual(index.search('path:src/*.ts'), []);
  assert.deepEqual(index.search('path:EMPTY'), ['EMPTY']);
  assert.deepEqual(index.search('path:src/a.ts(red)'), ['src/a.ts']);
});

test('malformed syntax fails even on empty indexes or short-circuit branches', () => {
  const invalid = ['(', ')', '()', 'red OR', 'AND red', 'NOT', 'red AND OR blue', 'red)', '"red', '""', '"!!!"', 'path:', 'red-blue', '*', 'red OR ()', 'NOT (red'];
  for (const index of [fresh(), api.createIndex()]) {
    for (const query of invalid) assert.throws(() => index.search(query), SyntaxError, query);
    assert.throws(() => index.search(null), TypeError);
  }
});

test('updates and removals eliminate stale terms, phrases, and negation results', () => {
  const index = fresh();
  index.upsert({ path: 'src/a.ts', content: 'yellow quick fox' });
  assert.deepEqual(index.search('red'), ['vendor/c.ts']);
  assert.deepEqual(index.search('"quick brown"'), []);
  assert.deepEqual(index.search('yellow NOT red'), ['src/a.ts']);
  assert.equal(index.remove('vendor/c.ts'), true);
  assert.equal(index.remove('vendor/c.ts'), false);
  assert.deepEqual(index.search('red'), []);
});

test('batch order handles repeated paths, empty batch, and copied values', () => {
  const index = fresh();
  const operation = { type: 'upsert', path: 'new', content: 'final' };
  assert.equal(index.applyBatch([
    { type: 'upsert', path: 'new', content: 'old' }, { type: 'remove', path: 'new' },
    operation,
    { type: 'remove', path: 'missing' },
  ]), undefined);
  operation.content = 'mutated';
  assert.deepEqual(index.search('final'), ['new']);
  assert.deepEqual(index.search('old OR mutated'), []);
  assert.equal(index.applyBatch([]), undefined);
});

test('batch validation is atomic for every invalid operation kind', () => {
  const invalid = [null, [], {}, { type: 'rename', path: 'x' }, { type: 'remove', path: '' }, { type: 'upsert', path: 'x', content: 2 }];
  for (const bad of invalid) {
    const index = fresh();
    const before = index.snapshot();
    assert.throws(() => index.applyBatch([{ type: 'remove', path: 'src/a.ts' }, { type: 'upsert', path: 'new', content: 'new' }, bad]), TypeError);
    assert.equal(index.snapshot(), before);
    assert.deepEqual(index.search('"quick brown"'), ['src/a.ts']);
  }
  assert.throws(() => fresh().applyBatch({}), TypeError);
});

test('snapshots are canonical, content-preserving, and history-independent', () => {
  const documents = [{ path: 'z', content: 'RAW\nText!' }, { path: 'A', content: '' }];
  const index = api.createIndex(documents);
  const expected = JSON.stringify({ version: 1, documents: [documents[1], documents[0]] });
  assert.equal(index.snapshot(), expected);
  const other = api.createIndex([...documents].reverse());
  other.upsert({ path: 'temporary', content: 'ignored' });
  other.remove('temporary');
  assert.equal(other.snapshot(), expected);
  assert.deepEqual(index.search('raw'), ['z']);
});

test('restore rebuilds state and supports independent subsequent mutations', () => {
  const original = fresh();
  const recovered = api.restoreIndex(original.snapshot());
  assert.equal(recovered.snapshot(), original.snapshot());
  assert.deepEqual(recovered.search('"brown fox" NOT path:vendor/'), ['src/a.ts']);
  recovered.applyBatch([{ type: 'remove', path: 'src/a.ts' }, { type: 'upsert', path: 'src/new', content: 'new brown fox' }]);
  assert.deepEqual(recovered.search('"brown fox"'), ['src/new', 'vendor/c.ts']);
  assert.deepEqual(original.search('"brown fox"'), ['src/a.ts', 'vendor/c.ts']);
  const again = api.restoreIndex(recovered.snapshot());
  assert.deepEqual(again.search('new AND path:src/'), ['src/new']);
  assert.deepEqual(again.search('NOT fox'), ['EMPTY']);
});

test('restore rejects corrupt snapshots and accepts ignored extra fields', () => {
  const invalid = [null, '', '{', 'null', '[]', '{}', '{"version":2,"documents":[]}', '{"version":1,"documents":{}}',
    JSON.stringify({ version: 1, documents: [{ path: 'a', content: 'x' }, { path: 'a', content: 'y' }] }),
    JSON.stringify({ version: 1, documents: [{ path: '', content: 'x' }] }),
    JSON.stringify({ version: 1, documents: [{ path: 'a', content: null }] })];
  for (const value of invalid) assert.throws(() => api.restoreIndex(value), TypeError);
  const restored = api.restoreIndex(JSON.stringify({ version: 1, extra: true, documents: [{ path: ' a ', content: '', ignored: 3 }] }));
  assert.deepEqual(restored.search('NOT missing'), [' a ']);
  assert.equal(restored.snapshot(), JSON.stringify({ version: 1, documents: [{ path: ' a ', content: '' }] }));
});

test('runtime document validation and ownership survive persistence', () => {
  for (const bad of [null, [], {}, { path: '', content: '' }, { path: 'a', content: 4 }]) {
    assert.throws(() => api.createIndex([bad]), TypeError);
    assert.throws(() => fresh().upsert(bad), TypeError);
  }
  assert.throws(() => api.createIndex({}), TypeError);
  assert.throws(() => fresh().remove(4), TypeError);
  const document = { path: ' a ', content: 'one', extra: true };
  const index = api.createIndex([document, { path: ' a ', content: 'two' }]);
  document.path = 'elsewhere';
  assert.deepEqual(index.search('two'), [' a ']);
  assert.equal(api.restoreIndex(index.snapshot()).remove(' a '), true);
});
