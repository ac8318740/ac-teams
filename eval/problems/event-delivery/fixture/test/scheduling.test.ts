import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const workspace = process.env.EVAL_WORKSPACE ?? new URL('../', import.meta.url).pathname;
const { createDeliveryService } = await import(pathToFileURL(resolve(workspace, 'src/index.ts')).href);
const event = (id: string, options = {}) => ({ id, topic: 'orders', payload: `body-${id}`, ...options });
const fail = () => { throw new Error('offline'); };

// These tests consume only the candidate's public API.
test('schedule boundaries and stable due-time ordering', async () => {
  const service = createDeliveryService();
  service.enqueue(event('late', { notBefore: 30 }), 0);
  service.enqueue(event('tie-a', { notBefore: 10 }), 0);
  service.enqueue(event('early', { notBefore: 5 }), 0);
  service.enqueue(event('tie-b', { notBefore: 10 }), 0);
  assert.deepEqual(await service.drain(4, () => assert.fail('not due')), []);
  assert.deepEqual(await service.drain(10, () => {}), ['early', 'tie-a', 'tie-b']);
  assert.equal(service.get('late').status, 'pending');
  assert.deepEqual(await service.drain(30, () => {}), ['late']);
  assert.deepEqual(service.list().map(record => record.id), ['late', 'tie-a', 'early', 'tie-b']);
});

test('defaults, detached fields, and successful terminal state', async () => {
  const service = createDeliveryService();
  const input = event('__proto__');
  const record = service.enqueue(input, 4.5);
  assert.deepEqual(record, { ...input, status: 'pending', attempts: 0, lastError: null,
    nextAttemptAt: 4.5, maxAttempts: 3, baseDelay: 10 });
  input.payload = 'mutated';
  record.nextAttemptAt = 0;
  assert.deepEqual(await service.drain(4, () => assert.fail('early')), []);
  await service.drain(4.5, delivered => {
    assert.equal(delivered.attempts, 1);
    delivered.payload = 'transport mutation';
  });
  assert.deepEqual(service.get('__proto__'), { id: '__proto__', topic: 'orders', payload: 'body-__proto__',
    status: 'delivered', attempts: 1, lastError: null, nextAttemptAt: null, maxAttempts: 3, baseDelay: 10 });
});

test('retry backoff uses actual drain time and clears errors on recovery', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a', { baseDelay: 5 }), 100);
  await service.drain(102, fail);
  assert.equal(service.get('a').nextAttemptAt, 107);
  assert.equal(service.get('a').lastError, 'offline');
  assert.deepEqual(await service.drain(106, fail), []);
  await service.drain(110, () => { throw 'second'; });
  assert.equal(service.get('a').nextAttemptAt, 120);
  assert.equal(service.get('a').attempts, 2);
  assert.equal(service.get('a').lastError, 'second');
  await service.drain(120, async () => {});
  assert.equal(service.get('a').status, 'delivered');
  assert.equal(service.get('a').attempts, 3);
  assert.equal(service.get('a').lastError, null);
  assert.equal(service.get('a').nextAttemptAt, null);
});

test('retry exhaustion and one-attempt budgets are terminal', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a', { maxAttempts: 2, baseDelay: 1 }));
  service.enqueue(event('b', { maxAttempts: 1 }));
  assert.deepEqual(await service.drain(0, fail), ['a', 'b']);
  assert.equal(service.get('a').status, 'pending');
  assert.equal(service.get('b').status, 'dead');
  assert.deepEqual(await service.drain(1, fail), ['a']);
  assert.equal(service.get('a').status, 'dead');
  assert.equal(service.get('a').nextAttemptAt, null);
  assert.equal(service.get('a').attempts, 2);
  assert.deepEqual(await service.drain(1000, () => assert.fail('terminal')), []);
});

test('zero-delay retry happens once per drain and failures do not block peers', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a', { baseDelay: 0 }));
  service.enqueue(event('b'));
  assert.deepEqual(await service.drain(0, record => { if (record.id === 'a') throw 7; }), ['a', 'b']);
  assert.equal(service.get('a').attempts, 1);
  assert.equal(service.get('a').lastError, '7');
  assert.equal(service.get('b').status, 'delivered');
  assert.deepEqual(await service.drain(0, () => {}), ['a']);
});

test('awaits sequential transport and freezes drain membership', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a'));
  service.enqueue(event('b'));
  const seen: string[] = [];
  assert.deepEqual(await service.drain(0, async record => {
    seen.push(`start-${record.id}`);
    if (record.id === 'a') service.enqueue(event('new'));
    await Promise.resolve();
    seen.push(`end-${record.id}`);
  }), ['a', 'b']);
  assert.deepEqual(seen, ['start-a', 'end-a', 'start-b', 'end-b']);
  assert.deepEqual(await service.drain(0, () => {}), ['new']);
});

test('status and topic filters combine, preserve insertion order, and detach results', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a', { topic: 'x', notBefore: 20 }));
  service.enqueue(event('b', { topic: 'y' }));
  service.enqueue(event('c', { topic: 'x', maxAttempts: 1 }));
  await service.drain(0, record => { if (record.id === 'c') fail(); });
  assert.deepEqual(service.list({ status: 'pending', topic: 'x' }).map(r => r.id), ['a']);
  assert.deepEqual(service.list({ topic: 'x' }).map(r => r.id), ['a', 'c']);
  assert.deepEqual(service.list({ status: 'dead' }).map(r => r.id), ['c']);
  assert.deepEqual(service.list({ status: 'delivered', topic: 'x' }), []);
  service.list({ status: 'pending' })[0].payload = 'changed';
  service.get('a').status = 'dead';
  assert.equal(service.get('a').payload, 'body-a');
  assert.equal(service.get('a').status, 'pending');
});

test('snapshots preserve partial progress, retries, ordering, and duplicate identity', async () => {
  const first = createDeliveryService();
  first.enqueue(event('later', { notBefore: 30 }));
  first.enqueue(event('retry', { baseDelay: 2, maxAttempts: 2 }));
  first.enqueue(event('done'));
  first.enqueue(event('dead', { maxAttempts: 1 }));
  await first.drain(0, record => { if (record.id !== 'done') fail(); });
  const encoded = first.snapshot();
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.version, 1);
  assert.deepEqual(parsed.records, first.list());
  const second = createDeliveryService(encoded);
  assert.deepEqual(second.list(), first.list());
  for (const id of ['later', 'retry', 'done', 'dead']) {
    assert.deepEqual(second.enqueue(event(id, { payload: 'replacement' }), 999), first.get(id));
  }
  assert.deepEqual(await second.drain(2, fail), ['retry']);
  assert.equal(second.get('retry').status, 'dead');
  const third = createDeliveryService(second.snapshot());
  third.enqueue(event('tie', { notBefore: 30 }));
  assert.deepEqual(await third.drain(30, () => {}), ['later', 'tie']);
  assert.deepEqual(await third.drain(1000, () => assert.fail('duplicate')), []);
  assert.equal(first.get('later').status, 'pending');
});

test('empty snapshot and first insert after restart', async () => {
  const restored = createDeliveryService(createDeliveryService().snapshot());
  assert.deepEqual(restored.list(), []);
  restored.enqueue(event('fresh'), 9);
  assert.deepEqual(await restored.drain(8, () => assert.fail('early')), []);
  assert.deepEqual(await restored.drain(9, () => {}), ['fresh']);
});

test('invalid input and clock values reject without changing existing records', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a'));
  const before = service.list();
  for (const bad of [null, event(''), event(' ', {}), event('x', { topic: ' ' }),
    event('x', { payload: 3 }), event('x', { notBefore: -1 }), event('x', { notBefore: NaN }),
    event('x', { maxAttempts: 0 }), event('x', { maxAttempts: 1.5 }),
    event('x', { baseDelay: Infinity }), event('x', { baseDelay: -1 }),
    event('a', { maxAttempts: 0 })]) {
    assert.throws(() => service.enqueue(bad));
  }
  for (const time of [-1, NaN, Infinity, '0', null]) {
    assert.throws(() => service.enqueue(event('z'), time));
    await assert.rejects(async () => service.drain(time, () => assert.fail('invalid time')));
    await assert.rejects(async () => createDeliveryService().drain(time, () => {}));
  }
  assert.deepEqual(service.list(), before);
});

test('restore rejects malformed envelopes, duplicates, and invalid fields', () => {
  const good = { ...event('a'), status: 'pending', attempts: 0, lastError: null,
    nextAttemptAt: 0, maxAttempts: 3, baseDelay: 10 };
  for (const text of ['no json', 'null', '{}', '{"version":2,"records":[]}', '{"version":1,"records":{}}']) {
    assert.throws(() => createDeliveryService(text));
  }
  const encode = records => JSON.stringify({ version: 1, records });
  assert.throws(() => createDeliveryService(encode([good, good])));
  for (const patch of [{ id: '' }, { topic: '' }, { payload: null }, { status: 'running' },
    { attempts: -1 }, { attempts: 0.5 }, { maxAttempts: 0 }, { baseDelay: -1 },
    { nextAttemptAt: null }, { lastError: 'unexpected' }, { attempts: 3, lastError: 'bad' }]) {
    assert.throws(() => createDeliveryService(encode([{ ...good, ...patch }])));
  }
  for (const key of Object.keys(good)) {
    const missing = { ...good };
    delete missing[key];
    assert.throws(() => createDeliveryService(encode([missing])));
  }
});

test('restore validates terminal consistency and retry state independently', async () => {
  const base = { ...event('a'), status: 'pending', attempts: 1, lastError: 'retry',
    nextAttemptAt: 12.5, maxAttempts: 2, baseDelay: 0.5 };
  const encode = record => JSON.stringify({ version: 1, records: [record] });
  for (const patch of [{ lastError: null }, { status: 'delivered' },
    { status: 'dead', nextAttemptAt: null },
    { status: 'delivered', attempts: 0, lastError: null, nextAttemptAt: null },
    { status: 'dead', attempts: 2, lastError: null, nextAttemptAt: null }]) {
    assert.throws(() => createDeliveryService(encode({ ...base, ...patch })));
  }
  const service = createDeliveryService(encode(base));
  assert.deepEqual(await service.drain(12, () => assert.fail('early')), []);
  assert.deepEqual(await service.drain(12.5, () => Promise.reject(new Error('final'))), ['a']);
  assert.equal(service.get('a').status, 'dead');
  assert.equal(service.get('a').lastError, 'final');
});
