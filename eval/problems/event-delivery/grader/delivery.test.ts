import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const api = await import(pathToFileURL(resolve(process.env.EVAL_WORKSPACE!, 'src/index.ts')).href);
const event = (id: string, options = {}) => ({ id, topic: 'orders', payload: `body-${id}`, ...options });
const fail = () => { throw new Error('offline'); };
const key = (subscriberId: string, id: string) => ({ subscriberId, id });
const setup = () => {
  const broker = api.createBroker();
  broker.subscribe({ id: 'a', topics: ['orders'] });
  broker.subscribe({ id: 'b', topics: ['orders', 'audit'] });
  return broker;
};

test('broker routes exact topics, includes paused recipients, and deduplicates publications', async () => {
  const broker = setup();
  broker.setPaused('b', true);
  assert.deepEqual(broker.publish(event('one')).map(d => d.subscriberId), ['a', 'b']);
  assert.deepEqual(broker.publish(event('two', { topic: 'audit' })).map(d => d.subscriberId), ['b']);
  assert.deepEqual(broker.publish(event('none', { topic: 'other' })), []);
  broker.subscribe({ id: 'late', topics: ['orders', 'other'] });
  assert.deepEqual(broker.publish(event('one', { payload: 'replacement' })).map(d => d.subscriberId), ['a', 'b']);
  assert.deepEqual(broker.publish(event('none')), []);
  assert.deepEqual(await broker.drain(0, () => {}), [key('a', 'one')]);
  assert.equal(broker.get('b', 'one').attempts, 0);
  assert.deepEqual(broker.events().map(e => e.id), ['one', 'two', 'none']);
});

test('per-subscriber retries are independent and do not block later due events', async () => {
  const broker = setup();
  broker.publish(event('one', { baseDelay: 5, maxAttempts: 2 }));
  broker.publish(event('two', { notBefore: 1 }));
  assert.deepEqual(await broker.drain(0, d => { if (d.subscriberId === 'a') fail(); }), [key('a', 'one'), key('b', 'one')]);
  assert.equal(broker.get('a', 'one').nextAttemptAt, 5);
  assert.equal(broker.get('b', 'one').status, 'delivered');
  assert.deepEqual(await broker.drain(1, () => {}), [key('a', 'two'), key('b', 'two')]);
  assert.deepEqual(await broker.drain(5, fail), [key('a', 'one')]);
  assert.equal(broker.get('a', 'one').status, 'dead');
  assert.equal(broker.get('b', 'one').attempts, 1);
});

test('cancellation and unsubscribe preserve peers, terminal records, and tombstones', async () => {
  const broker = setup();
  broker.publish(event('done'));
  await broker.drain(0, () => {});
  broker.publish(event('pending', { notBefore: 10 }));
  assert.equal(broker.cancel('a', 'pending'), true);
  assert.equal(broker.cancel('a', 'pending'), false);
  assert.equal(broker.cancel('a', 'done'), false);
  assert.equal(broker.unsubscribe('a'), true);
  assert.equal(broker.unsubscribe('a'), false);
  assert.equal(broker.get('a', 'done').status, 'delivered');
  assert.equal(broker.get('a', 'pending').nextAttemptAt, null);
  assert.equal(broker.subscribe({ id: 'a', topics: ['audit'] }).active, false);
  assert.deepEqual(await broker.drain(10, () => {}), [key('b', 'pending')]);
  assert.deepEqual(broker.publish(event('future')).map(d => d.subscriberId), ['b']);
});

test('unsubscribe cancels retry state, while dead letters of removed subscribers cannot replay', async () => {
  const broker = setup();
  broker.publish(event('retry', { baseDelay: 3 }));
  broker.publish(event('dead', { maxAttempts: 1 }));
  await broker.drain(0, fail);
  broker.unsubscribe('a');
  assert.equal(broker.get('a', 'retry').status, 'cancelled');
  assert.equal(broker.get('a', 'retry').lastError, 'offline');
  assert.equal(broker.get('a', 'retry').attempts, 1);
  assert.equal(broker.replay('a', 'dead', 4), false);
  assert.equal(broker.replay('b', 'dead', 4), true);
  assert.equal(broker.get('b', 'retry').status, 'pending');
});

test('dead-letter replay resets only the target and retains original tie ordering', async () => {
  const broker = setup();
  broker.publish(event('old', { maxAttempts: 1, baseDelay: 0 }));
  await broker.drain(0, fail);
  broker.publish(event('new', { notBefore: 10 }));
  broker.setPaused('a', true);
  assert.equal(broker.replay('a', 'old', 10), true);
  assert.equal(broker.replay('a', 'old', 10), false);
  assert.equal(broker.get('a', 'old').attempts, 0);
  assert.equal(broker.get('a', 'old').lastError, null);
  assert.deepEqual(await broker.drain(10, () => {}), [key('b', 'new')]);
  broker.setPaused('a', false);
  assert.deepEqual(await broker.drain(10, () => {}), [key('a', 'old'), key('a', 'new')]);
  assert.equal(broker.get('b', 'old').status, 'dead');
});

test('checkpoint recovers mixed state, then independently continues and replays', async () => {
  const first = setup();
  first.subscribe({ id: 'removed', topics: ['orders'] });
  first.publish(event('retry', { baseDelay: 2 }));
  first.publish(event('dead', { maxAttempts: 1 }));
  first.publish(event('later', { notBefore: 20 }));
  await first.drain(0, d => { if (d.subscriberId !== 'b') fail(); });
  first.setPaused('a', true);
  first.unsubscribe('removed');
  first.cancel('b', 'later');
  first.publish(event('unrouted', { topic: 'unknown' }));
  const checkpoint = first.snapshot();
  const data = JSON.parse(checkpoint);
  assert.equal(data.version, 2);
  assert.deepEqual(data.subscriptions, first.listSubscriptions());
  assert.deepEqual(data.events, first.events());
  assert.deepEqual(data.dispatches, first.list());
  const second = api.createBroker(checkpoint);
  assert.deepEqual(second.list(), first.list());
  assert.deepEqual(await second.drain(20, () => {}), []);
  second.setPaused('a', false);
  second.replay('a', 'dead', 2);
  assert.deepEqual(await second.drain(2, () => {}), [key('a', 'retry'), key('a', 'dead')]);
  const third = api.createBroker(second.snapshot());
  third.publish(event('tie', { notBefore: 20 }));
  assert.deepEqual(await third.drain(20, () => {}), [key('a', 'later'), key('a', 'tie'), key('b', 'tie')]);
  assert.equal(first.get('a', 'retry').attempts, 1);
  assert.equal(first.get('a', 'dead').status, 'dead');
  assert.deepEqual(third.publish(event('unrouted')), []);
  assert.deepEqual(third.events().map(e => e.id), ['retry', 'dead', 'later', 'unrouted', 'tie']);
});

test('broker input and output isolation includes nested subscription arrays and transport records', async () => {
  const broker = api.createBroker();
  const input = { id: '__proto__', topics: ['orders'] };
  broker.subscribe(input).topics.push('bad');
  input.topics[0] = 'mutated';
  broker.getSubscription('__proto__').topics.length = 0;
  broker.listSubscriptions()[0].active = false;
  const e = event('x');
  broker.publish(e)[0].payload = 'bad';
  e.payload = 'bad';
  broker.events()[0].payload = 'bad';
  broker.list()[0].attempts = 100;
  broker.get('__proto__', 'x').status = 'dead';
  await broker.drain(0, d => { d.subscriberId = 'bad'; d.payload = 'bad'; });
  assert.deepEqual(broker.getSubscription('__proto__').topics, ['orders']);
  assert.equal(broker.get('__proto__', 'x').payload, 'body-x');
  assert.equal(broker.get('__proto__', 'x').status, 'delivered');
  assert.equal(broker.events()[0].payload, 'body-x');
});

test('broker rejects mutators and snapshots throughout an awaited drain and releases guard', async () => {
  const broker = setup();
  broker.publish(event('x'));
  const seen: string[] = [];
  await broker.drain(0, async d => {
    seen.push(`start-${d.subscriberId}`);
    assert.equal(broker.list().length, 2);
    for (const mutate of [() => broker.subscribe({ id: 'c', topics: ['orders'] }),
      () => broker.publish(event('new')), () => broker.unsubscribe('a'), () => broker.setPaused('a', true),
      () => broker.cancel('b', 'x'), () => broker.replay('b', 'x', 0), () => broker.snapshot()]) {
      assert.throws(mutate);
    }
    await assert.rejects(broker.drain(0, () => {}));
    await Promise.resolve();
    seen.push(`end-${d.subscriberId}`);
  });
  assert.deepEqual(seen, ['start-a', 'end-a', 'start-b', 'end-b']);
  broker.publish(event('new'));
  assert.deepEqual(await broker.drain(0, () => {}), [key('a', 'new'), key('b', 'new')]);
});

test('broker rejects malformed calls atomically, including duplicates and empty drains', async () => {
  const broker = setup();
  broker.publish(event('x'));
  const before = broker.snapshot();
  for (const mutate of [() => broker.publish(event('x', { maxAttempts: 0 })),
    () => broker.publish(event('z', { notBefore: -1 })),
    () => broker.subscribe({ id: 'a', topics: [] }), () => broker.setPaused('a', 'yes'),
    () => broker.unsubscribe(' '), () => broker.cancel('a', ''), () => broker.replay('missing', 'x', NaN),
    () => broker.list(null), () => broker.list({ status: 'unknown' })]) assert.throws(mutate);
  await assert.rejects(broker.drain(-1, () => {}));
  await assert.rejects(broker.drain(0, null));
  await assert.rejects(api.createBroker().drain(NaN, () => {}));
  await assert.rejects(api.createBroker().drain(0, null));
  assert.equal(broker.snapshot(), before);
  assert.equal((await broker.drain(0, () => {})).length, 2);
});

test('checkpoint validates cross-component references, matching content, and inactive pending state', () => {
  const broker = setup();
  broker.publish(event('x'));
  const original = JSON.parse(broker.snapshot());
  const mutations = [
    d => { d.version = 1; }, d => { delete d.events; }, d => { d.events = {}; },
    d => { d.events.push(d.events[0]); }, d => { d.subscriptions.push(d.subscriptions[0]); },
    d => { d.dispatches.push(d.dispatches[0]); }, d => { d.dispatches[0].subscriberId = 'missing'; },
    d => { d.dispatches[0].id = 'missing'; }, d => { d.subscriptions[0].topics = ['other']; },
    d => { d.subscriptions[0].active = false; }, d => { d.dispatches[0].payload = 'wrong'; },
    d => { d.dispatches[0].topic = 'wrong'; }, d => { d.dispatches[0].baseDelay = 11; },
    d => { d.dispatches[0].maxAttempts = 4; }, d => { delete d.events[0].notBefore; },
    d => { d.events[0].notBefore = -1; }, d => { d.events[0].payload = 7; },
  ];
  for (const change of mutations) {
    const data = structuredClone(original);
    change(data);
    assert.throws(() => api.createBroker(JSON.stringify(data)));
  }
  for (const bad of ['null', '{}', 'bad', '{"version":2,"subscriptions":[],"events":[]}']) {
    assert.throws(() => api.createBroker(bad));
  }
  assert.throws(() => api.createBroker(api.createDeliveryService().snapshot()));
  assert.throws(() => api.createDeliveryService(broker.snapshot()));
  assert.deepEqual(api.createBroker(api.createBroker().snapshot()).list(), []);
  assert.equal(broker.snapshot(), JSON.stringify(original));
});
