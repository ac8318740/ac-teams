import test from 'node:test';
import assert from 'node:assert/strict';
import { createDeliveryService } from '../src/index.ts';

const event = (id: string) => ({ id, topic: 'orders', payload: `body-${id}` });

test('delivers immediately, awaits transport, and never redelivers success', async () => {
  const service = createDeliveryService();
  service.enqueue(event('a'));
  service.enqueue(event('b'));
  const seen: string[] = [];
  assert.deepEqual(await service.drain(0, async record => { seen.push(record.id); }), ['a', 'b']);
  assert.deepEqual(seen, ['a', 'b']);
  assert.equal(service.get('a')?.status, 'delivered');
  assert.equal(service.get('a')?.attempts, 1);
  assert.deepEqual(await service.drain(100, () => assert.fail('redelivered')), []);
});

test('duplicate IDs keep the first event and callers cannot mutate state', () => {
  const service = createDeliveryService();
  const first = service.enqueue(event('a'));
  first.payload = 'changed';
  service.enqueue({ id: 'a', topic: 'different', payload: 'replacement' });
  const list = service.list();
  list[0].status = 'dead';
  assert.equal(service.get('a')?.payload, 'body-a');
  assert.equal(service.get('a')?.status, 'pending');
  assert.equal(service.list().length, 1);
  assert.equal(service.get('missing'), undefined);
});

test('validates events and isolates transport mutations', async () => {
  const service = createDeliveryService();
  assert.throws(() => service.enqueue({ id: '', topic: 'orders', payload: '' }));
  service.enqueue(event('a'));
  await service.drain(0, record => { record.payload = 'changed'; });
  assert.equal(service.get('a')?.payload, 'body-a');
});
