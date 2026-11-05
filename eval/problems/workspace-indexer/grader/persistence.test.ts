import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const api = await import(pathToFileURL(`${process.env.EVAL_WORKSPACE}/src/index.ts`).href);
const CP = 'workspace.checkpoint', LOG = 'workspace.journal';
const docs = [{ path: 'z', content: 'red red blue' }, { path: 'a', content: 'blue green' }];
function controlled(seed = {}) {
  const base = api.createMemoryStorage(seed);
  const calls = [];
  let fail;
  let observe;
  const storage = {
    read(key) { calls.push(['read', key]); if (fail === `read:${key}`) throw failure; return base.read(key); },
    write(key, value) { calls.push(['write', key, value]); observe?.(key); if (fail === `write:${key}`) throw failure; base.write(key, value); },
    remove(key) { calls.push(['remove', key]); if (fail === `remove:${key}`) throw failure; base.remove(key); },
  };
  const failure = new Error('injected storage failure');
  return { storage, base, calls, failure, setFail(value) { fail = value; }, setObserve(value) { observe = value; } };
}
const checkpoint = (documents, revision = 0) => JSON.stringify({ version: 2, revision, documents });
const entry = (revision, content = `v${revision}`) => ({ revision, operations: [{ type: 'upsert', path: 'x', content }] });
const journal = entries => JSON.stringify({ version: 2, entries });

test('memory storage copies seeds, supports opaque keys, overwrite, and idempotent remove', () => {
  const seed = { '__proto__': 'ignored', x: 'one' };
  const storage = api.createMemoryStorage(seed); seed.x = 'changed';
  assert.equal(storage.read('x'), 'one'); assert.equal(storage.read('absent'), undefined);
  storage.write('__proto__', 'safe'); assert.equal(storage.read('__proto__'), 'safe');
  storage.write('x', 'two'); storage.remove('x'); storage.remove('x'); assert.equal(storage.read('x'), undefined);
  for (const bad of [null, [], { x: 1 }]) assert.throws(() => api.createMemoryStorage(bad), TypeError);
});

test('initialization is canonical, revision zero, and refuses existing checkpoint or orphan journal', () => {
  const { storage, base } = controlled();
  const index = api.createPersistentIndex(storage, docs);
  assert.equal(index.revision, 0);
  assert.equal(base.read(CP), checkpoint([docs[1], docs[0]]));
  assert.equal(base.read(LOG), undefined);
  assert.throws(() => api.createPersistentIndex(storage), TypeError);
  assert.throws(() => api.createPersistentIndex(api.createMemoryStorage({ [LOG]: journal([]) })), TypeError);
  assert.throws(() => api.openIndex(api.createMemoryStorage()), TypeError);
});

test('each nonempty batch has one durable revision and serializes copied operations without extras', () => {
  const c = controlled(); const index = api.createPersistentIndex(c.storage, docs);
  const operation = { type: 'upsert', path: 'x', content: 'one', extra: 4 };
  index.applyBatch([operation, { type: 'remove', path: 'z' }]); operation.content = 'mutated';
  assert.equal(index.revision, 1);
  assert.equal(c.base.read(LOG), journal([{ revision: 1, operations: [{ type: 'upsert', path: 'x', content: 'one' }, { type: 'remove', path: 'z' }] }]));
  index.applyBatch([]); assert.equal(index.remove('absent'), false); assert.equal(index.revision, 1);
  index.applyBatch([{ type: 'remove', path: 'absent' }]); assert.equal(index.revision, 2);
  index.upsert({ path: 'x', content: 'one' }); assert.equal(index.revision, 3);
  assert.equal(index.remove('x'), true); assert.equal(index.revision, 4);
  assert.equal(api.openIndex(c.storage).snapshot(), index.snapshot());
});

test('validation has no storage effects and journal failures leave live and reopened state unchanged', () => {
  const c = controlled(); const index = api.createPersistentIndex(c.storage, docs);
  const before = index.snapshot(); c.calls.length = 0;
  assert.throws(() => index.applyBatch([{ type: 'remove', path: 'z' }, { type: 'upsert', path: '', content: 'bad' }]), TypeError);
  assert.deepEqual(c.calls, []);
  assert.throws(() => index.applyBatch(new Array(2)), TypeError);
  assert.deepEqual(c.calls, []);
  c.setFail(`write:${LOG}`);
  assert.throws(() => index.upsert({ path: 'x', content: 'new' }), error => error === c.failure);
  assert.equal(index.snapshot(), before); assert.equal(index.revision, 0);
  assert.equal(api.openIndex(c.storage).snapshot(), before);
  c.setFail(undefined); index.upsert({ path: 'x', content: 'new' });
  assert.equal(index.revision, 1); assert.deepEqual(api.openIndex(c.storage).search('new'), ['x']);
});

test('queries made inside adapter write see the complete old revision, not staged postings', () => {
  const c = controlled(); const index = api.createPersistentIndex(c.storage, docs);
  c.setObserve(key => {
    if (key !== LOG) return;
    assert.equal(index.revision, 0); assert.deepEqual(index.search('red'), ['z']);
    assert.deepEqual(index.search('new'), []); assert.equal(index.getPostings('red')[0].positions.length, 2);
  });
  index.applyBatch([{ type: 'remove', path: 'z' }, { type: 'upsert', path: 'x', content: 'new' }]);
  c.setObserve(undefined);
  assert.equal(index.revision, 1); assert.deepEqual(index.search('red OR new'), ['x']);
});

test('checkpoint compacts journal and subsequent revisions continue rather than reset', () => {
  const c = controlled(); const index = api.createPersistentIndex(c.storage, docs);
  index.upsert({ path: 'x', content: 'v1' }); index.checkpoint();
  assert.equal(c.base.read(LOG), undefined);
  assert.equal(JSON.parse(c.base.read(CP)).revision, 1);
  index.upsert({ path: 'x', content: 'v2' });
  assert.deepEqual(JSON.parse(c.base.read(LOG)).entries, [entry(2)]);
  assert.deepEqual(api.openIndex(c.storage).search('v2'), ['x']);
});

test('failed checkpoint write preserves the journal, data, and retryability', () => {
  const c = controlled(); const index = api.createPersistentIndex(c.storage, docs);
  index.upsert({ path: 'x', content: 'v1' }); const before = c.base.read(CP), log = c.base.read(LOG);
  c.setFail(`write:${CP}`);
  assert.throws(() => index.checkpoint(), error => error === c.failure);
  assert.equal(c.base.read(CP), before); assert.equal(c.base.read(LOG), log);
  assert.equal(api.openIndex(c.storage).snapshot(), index.snapshot());
  c.setFail(undefined); index.checkpoint(); assert.equal(c.base.read(LOG), undefined);
});

test('interrupted checkpoint cleanup is committed and covered entries are not replayed', () => {
  const c = controlled(); const index = api.createPersistentIndex(c.storage, docs);
  index.upsert({ path: 'x', content: 'v1' });
  c.setFail(`remove:${LOG}`); assert.throws(() => index.checkpoint(), error => error === c.failure);
  assert.equal(JSON.parse(c.base.read(CP)).revision, 1);
  assert.equal(api.openIndex(c.storage).revision, 1);
  c.setFail(undefined); index.upsert({ path: 'x', content: 'v2' });
  const reopened = api.openIndex(c.storage);
  assert.equal(reopened.revision, 2); assert.deepEqual(reopened.search('v2'), ['x']);
  reopened.checkpoint(); assert.equal(c.base.read(LOG), undefined);
});

test('recovery uses checkpoint documents over covered journal operations and replays only later entries', () => {
  const c = controlled({ [CP]: checkpoint([{ path: 'x', content: 'checkpoint' }], 2), [LOG]: journal([entry(1), entry(2), { revision: 3, operations: [{ type: 'upsert', path: 'y', content: 'new' }] }]) });
  const index = api.openIndex(c.storage);
  assert.deepEqual(index.search('checkpoint OR new'), ['x', 'y']);
  assert.equal(index.revision, 3); assert.deepEqual(c.calls.map(call => call[0]), ['read', 'read']);
});

test('v1 snapshot migration writes a v2 checkpoint and supports full search/update/reopen', () => {
  const c = controlled({ [CP]: api.createIndex(docs).snapshot() });
  const index = api.openIndex(c.storage);
  assert.equal(c.base.read(CP), checkpoint([docs[1], docs[0]]));
  assert.equal(index.revision, 0); assert.equal(index.searchRanked('red')[0].path, 'z');
  index.applyBatch([{ type: 'remove', path: 'z' }, { type: 'upsert', path: 'a', content: 'quick brown fox' }]);
  const reopened = api.openIndex(c.storage);
  assert.deepEqual(reopened.search('"quick brown" NOT path:z'), ['a']);
  assert.deepEqual(reopened.getPostings('red'), []); assert.equal(reopened.revision, 1);
});

test('failed migration or initial write is retryable and propagates the original error', () => {
  for (const legacy of [false, true]) {
    const old = api.createIndex(docs).snapshot();
    const c = controlled(legacy ? { [CP]: old } : {}); c.setFail(`write:${CP}`);
    assert.throws(() => legacy ? api.openIndex(c.storage) : api.createPersistentIndex(c.storage, docs), error => error === c.failure);
    assert.equal(c.base.read(CP), legacy ? old : undefined); assert.equal(c.base.read(LOG), undefined);
    c.setFail(undefined);
    assert.deepEqual((legacy ? api.openIndex(c.storage) : api.createPersistentIndex(c.storage, docs)).search('red'), ['z']);
  }
});

test('safe revision overflow rejects mutations without writes and permits queries/checkpoint', () => {
  const c = controlled({ [CP]: checkpoint(docs, Number.MAX_SAFE_INTEGER) });
  const index = api.openIndex(c.storage); c.calls.length = 0;
  assert.throws(() => index.upsert({ path: 'x', content: 'new' }), TypeError);
  assert.deepEqual(c.calls, []); assert.deepEqual(index.search('red'), ['z']);
  assert.equal(index.revision, Number.MAX_SAFE_INTEGER); index.checkpoint();
  assert.equal(api.openIndex(c.storage).revision, Number.MAX_SAFE_INTEGER);
});

test('storage read errors propagate without repair writes', () => {
  for (const key of [CP, LOG]) {
    const c = controlled({ [CP]: checkpoint(docs) }); c.setFail(`read:${key}`);
    assert.throws(() => api.openIndex(c.storage), error => error === c.failure);
    assert.equal(c.calls.some(call => call[0] !== 'read'), false);
  }
});

for (const [label, seed] of [
  ['bad JSON', { [CP]: '{' }],
  ['unsupported schema', { [CP]: JSON.stringify({ version: 3, revision: 0, documents: [] }) }],
  ['negative revision', { [CP]: checkpoint([], -1) }],
  ['fractional revision', { [CP]: checkpoint([], 0.5) }],
  ['duplicate documents', { [CP]: checkpoint([docs[0], docs[0]]) }],
  ['legacy plus journal', { [CP]: JSON.stringify({ version: 1, documents: [] }), [LOG]: journal([]) }],
  ['journal gap', { [CP]: checkpoint([]), [LOG]: journal([entry(2)]) }],
  ['reordered entries', { [CP]: checkpoint([], 2), [LOG]: journal([entry(2), entry(1)]) }],
  ['covered entry invalid', { [CP]: checkpoint([], 2), [LOG]: journal([{ revision: 1, operations: [{ type: 'remove', path: '' }] }]) }],
  ['empty entry', { [CP]: checkpoint([]), [LOG]: journal([{ revision: 1, operations: [] }]) }],
  ['invalid operation', { [CP]: checkpoint([]), [LOG]: journal([{ revision: 1, operations: [{ type: 'rename', path: 'x' }] }]) }],
  ['orphan journal', { [LOG]: journal([entry(1)]) }],
]) {
  test(`corruption is rejected without writes: ${label}`, () => {
    const c = controlled(seed);
    assert.throws(() => api.openIndex(c.storage), TypeError);
    assert.equal(c.calls.some(call => call[0] !== 'read'), false);
    for (const [key, value] of Object.entries(seed)) assert.equal(c.base.read(key), value);
  });
}

test('end-to-end migrate, mutate, fail, recover, rank, compact, and reopen repeatedly', () => {
  const c = controlled({ [CP]: api.createIndex(docs).snapshot() });
  let index = api.openIndex(c.storage);
  const expected = api.createIndex(docs);
  for (let step = 0; step < 36; step++) {
    const operations = [{ type: 'remove', path: `d${(step + 2) % 7}` }, { type: 'upsert', path: `d${step % 7}`, content: step % 2 ? 'red red quick brown' : 'blue quick fox' }];
    if (step % 4 === 0) {
      c.setFail(`write:${LOG}`); assert.throws(() => index.applyBatch(operations), error => error === c.failure);
      c.setFail(undefined); assert.equal(api.openIndex(c.storage).snapshot(), expected.snapshot());
    }
    index.applyBatch(operations); expected.applyBatch(operations);
    if (step % 5 === 0) index.checkpoint();
    index = api.openIndex(c.storage);
    assert.equal(index.revision, step + 1);
    assert.equal(index.snapshot(), expected.snapshot());
    for (const query of ['red OR blue', '"quick brown" NOT path:z', 'NOT green', '(red OR green) AND NOT fox']) {
      assert.deepEqual(index.search(query), expected.search(query));
      assert.deepEqual(index.searchRanked(query, 3), expected.searchRanked(query, 3));
    }
    assert.deepEqual(index.getPostings('red'), expected.getPostings('red'));
  }
});
