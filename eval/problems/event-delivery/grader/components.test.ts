import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
const api = await import(pathToFileURL(resolve(process.env.EVAL_WORKSPACE!, 'src/index.ts')).href);
const event = (id: string, options = {}) => ({ id, topic: 'orders', payload: id, ...options });
const fail = () => { throw 'failure'; };
const key = (subscriberId: string, id: string) => ({ subscriberId, id });

test('subscription component supports exact routing, pause, removal, and detached restore', () => {
  const registry = api.createSubscriptionRegistry();
  const topics = ['orders', 'audit'];
  registry.add({ id: 'a', topics }).topics.push('bad');
  topics.length = 0;
  registry.add({ id: 'b', topics: ['orders'] });
  registry.add({ id: 'c', topics: ['order'] });
  registry.setPaused('b', true);
  assert.deepEqual(registry.match('orders').map(s => s.id), ['a', 'b']);
  registry.remove('a');
  assert.deepEqual(registry.match('orders').map(s => s.id), ['b']);
  assert.equal(registry.add({ id: 'a', topics: ['new'] }).active, false);
  assert.equal(registry.setPaused('a', false), false);
  assert.equal(registry.remove('missing'), false);
  const records = registry.list();
  const restored = api.createSubscriptionRegistry(records);
  records[0].topics.length = 0;
  restored.get('b').topics.push('bad');
  assert.deepEqual(restored.list()[0].topics, ['orders', 'audit']);
  assert.deepEqual(restored.get('b').topics, ['orders']);
  assert.deepEqual(restored.list().map(s => s.id), ['a', 'b', 'c']);
});

test('subscription validation rejects whole malformed registries and invalid duplicate updates', () => {
  const registry = api.createSubscriptionRegistry();
  registry.add({ id: 'a', topics: ['orders'] });
  const before = registry.list();
  for (const input of [null, { id: ' ', topics: ['x'] }, { id: 'a', topics: [] },
    { id: 'a', topics: ['x', 'x'] }, { id: 'a', topics: [' '] }, { id: 'x', topics: 'x' }]) {
    assert.throws(() => registry.add(input));
  }
  assert.throws(() => registry.setPaused('a', 1));
  assert.throws(() => registry.match(''));
  assert.deepEqual(registry.list(), before);
  const good = before[0];
  for (const records of [null, {}, [good, good], [{ ...good, active: 1 }], [{ ...good, paused: null }]]) {
    assert.throws(() => api.createSubscriptionRegistry(records));
  }
  for (const field of Object.keys(good)) {
    const bad = { ...good }; delete bad[field];
    assert.throws(() => api.createSubscriptionRegistry([bad]));
  }
});

test('dispatch component isolates pair keys and applies stable global due ordering', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a:b', event('c', { notBefore: 5 }));
  queue.enqueue('a', event('b:c', { notBefore: 1 }));
  queue.enqueue('__proto__', event('__proto__', { notBefore: 1 }));
  queue.enqueue('a', event('later', { notBefore: 5 }));
  assert.equal(queue.list().length, 4);
  assert.equal(queue.enqueue('a', event('b:c', { payload: 'changed' })).payload, 'b:c');
  assert.deepEqual(await queue.drain(5, () => {}), [key('a', 'b:c'), key('__proto__', '__proto__'), key('a:b', 'c'), key('a', 'later')]);
  assert.deepEqual(queue.list({ subscriberId: 'a', status: 'delivered', topic: 'orders' }).map(d => d.id), ['b:c', 'later']);
  assert.deepEqual(queue.list({ subscriberId: 'absent' }), []);
});

test('dispatch eligibility leaves blocked retry state untouched and zero delay attempts once', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a', event('x', { baseDelay: 0, maxAttempts: 2 }));
  queue.enqueue('b', event('x', { baseDelay: 0 }));
  assert.deepEqual(await queue.drain(0, fail, []), []);
  assert.deepEqual(await queue.drain(0, fail, ['a']), [key('a', 'x')]);
  assert.equal(queue.get('a', 'x').attempts, 1);
  assert.equal(queue.get('b', 'x').attempts, 0);
  assert.deepEqual(await queue.drain(0, fail, ['a']), [key('a', 'x')]);
  assert.equal(queue.get('a', 'x').status, 'dead');
  assert.equal(queue.replay('a', 'x', 0.5), true);
  assert.deepEqual(await queue.drain(0, () => {}), [key('b', 'x')]);
  assert.deepEqual(await queue.drain(0.5, d => { d.payload = 'mutated'; }), [key('a', 'x')]);
  assert.equal(queue.get('a', 'x').payload, 'x');
});

test('dispatch cancellation preserves failure history; restore detaches and retains insertion positions', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a', event('retry', { baseDelay: 2 }));
  queue.enqueue('a', event('dead', { maxAttempts: 1 }));
  await queue.drain(0, fail);
  assert.equal(queue.cancel('a', 'retry'), true);
  assert.equal(queue.replay('a', 'retry', 1), false);
  assert.equal(queue.cancel('a', 'dead'), false);
  assert.deepEqual(queue.get('a', 'retry'), { subscriberId: 'a', id: 'retry', topic: 'orders', payload: 'retry',
    attempts: 1, maxAttempts: 3, baseDelay: 2, lastError: 'failure', nextAttemptAt: null, status: 'cancelled' });
  const records = queue.list();
  const restored = api.createDispatchQueue(records);
  records[0].status = 'pending';
  restored.replay('a', 'dead', 5);
  restored.enqueue('b', event('tie', { notBefore: 5 }));
  assert.deepEqual(await restored.drain(5, () => {}), [key('a', 'dead'), key('b', 'tie')]);
  assert.equal(queue.get('a', 'dead').status, 'dead');
  assert.equal(restored.get('a', 'retry').status, 'cancelled');
});

test('dispatch mutators reject during drain, queries remain detached, and transports await sequentially', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a', event('x')); queue.enqueue('b', event('x'));
  const seen: string[] = [];
  await queue.drain(0, async d => {
    seen.push(`start-${d.subscriberId}`);
    queue.get('b', 'x').payload = 'bad';
    assert.throws(() => queue.enqueue('c', event('x')));
    assert.throws(() => queue.cancel('b', 'x'));
    assert.throws(() => queue.replay('b', 'x', 0));
    await assert.rejects(queue.drain(0, () => {}));
    await Promise.resolve(); seen.push(`end-${d.subscriberId}`);
  });
  assert.deepEqual(seen, ['start-a', 'end-a', 'start-b', 'end-b']);
  assert.equal(queue.get('b', 'x').payload, 'x');
  queue.enqueue('c', event('x'));
  assert.deepEqual(await queue.drain(0, () => {}), [key('c', 'x')]);
});

test('dispatch invalid operations are atomic and rejected drains do not retain the guard', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a', event('x'));
  const before = queue.list();
  for (const call of [() => queue.enqueue(' ', event('x')), () => queue.enqueue('a', event('x', { baseDelay: -1 })),
    () => queue.cancel('', 'x'), () => queue.replay('a', 'missing', Infinity),
    () => queue.list(null), () => queue.list({ status: 'bad' }), () => queue.list({ topic: '' })]) assert.throws(call);
  for (const args of [[-1, () => {}], [0, null], [0, () => {}, ['a', ' ']], [0, () => {}, 'a']]) {
    await assert.rejects(queue.drain(...args));
  }
  assert.deepEqual(queue.list(), before);
  assert.deepEqual(await queue.drain(0, () => {}), [key('a', 'x')]);
});

test('dispatch backoff uses actual late drain time and survives restore without resetting the budget', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a', event('x', { baseDelay: 0.5, maxAttempts: 3 }), 10);
  await queue.drain(12, () => { throw new Error('first'); });
  assert.equal(queue.get('a', 'x').nextAttemptAt, 12.5);
  assert.equal(queue.get('a', 'x').lastError, 'first');
  assert.deepEqual(await queue.drain(12.4, () => assert.fail('not due')), []);
  await queue.drain(15, () => Promise.reject(42));
  assert.equal(queue.get('a', 'x').nextAttemptAt, 16);
  assert.equal(queue.get('a', 'x').lastError, '42');
  const restored = api.createDispatchQueue(queue.list());
  await restored.drain(16, record => { assert.equal(record.attempts, 3); });
  assert.equal(restored.get('a', 'x').status, 'delivered');
  assert.equal(restored.get('a', 'x').lastError, null);
  assert.equal(restored.get('a', 'x').nextAttemptAt, null);
  const exhausted = api.createDispatchQueue(queue.list());
  await exhausted.drain(16, fail);
  assert.equal(exhausted.get('a', 'x').status, 'dead');
  assert.equal(exhausted.get('a', 'x').attempts, 3);
  assert.equal(queue.get('a', 'x').attempts, 2);
});

test('dispatch restore validates required fields, state combinations, and duplicate pairs', async () => {
  const queue = api.createDispatchQueue();
  queue.enqueue('a', event('x'));
  const good = queue.list()[0];
  for (const records of [null, {}, [good, good]]) assert.throws(() => api.createDispatchQueue(records));
  for (const patch of [{ subscriberId: '' }, { status: 'cancelled' }, { attempts: 1 }, { maxAttempts: 0 },
    { status: 'delivered', nextAttemptAt: null }, { status: 'dead', attempts: 3, nextAttemptAt: null },
    { status: 'cancelled', nextAttemptAt: null, attempts: 3, lastError: 'x' },
    { status: 'cancelled', nextAttemptAt: null, attempts: 1, lastError: null }]) {
    assert.throws(() => api.createDispatchQueue([{ ...good, ...patch }]));
  }
  for (const field of Object.keys(good)) {
    const bad = { ...good }; delete bad[field];
    assert.throws(() => api.createDispatchQueue([bad]));
  }
  const cancelled = api.createDispatchQueue([{ ...good, status: 'cancelled', nextAttemptAt: null }]);
  assert.deepEqual(await cancelled.drain(100, () => assert.fail('cancelled')), []);
  const peers = api.createDispatchQueue([good, { ...good, subscriberId: 'b' }]);
  assert.equal(peers.list().length, 2);
});
