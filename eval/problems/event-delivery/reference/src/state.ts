import type { EventInput } from './types.ts';
import type { Dispatch, StoredEvent, Subscription } from './broker-types.ts';
import { isObject } from './broker-types.ts';
import { makeDelivery, validBudget, validTime } from './queue.ts';
import { createSubscriptionRegistry } from './subscription.ts';
import { createDispatchQueue } from './dispatch.ts';

export interface BrokerState {
  subscriptions: Subscription[];
  events: StoredEvent[];
  dispatches: Dispatch[];
}

export function normalizeEvent(input: EventInput, now: number): StoredEvent {
  const record = makeDelivery(input, now);
  return { id: record.id, topic: record.topic, payload: record.payload,
    notBefore: record.nextAttemptAt!, maxAttempts: record.maxAttempts, baseDelay: record.baseDelay };
}

export function restoreBroker(text: string): BrokerState {
  if (typeof text !== 'string') throw new Error('Invalid checkpoint');
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid checkpoint JSON'); }
  if (!isObject(data) || data.version !== 2 || !Array.isArray(data.subscriptions)
    || !Array.isArray(data.events) || !Array.isArray(data.dispatches)) throw new Error('Invalid checkpoint');
  const registry = createSubscriptionRegistry(data.subscriptions);
  const queue = createDispatchQueue(data.dispatches);
  const events = new Map<string, StoredEvent>();
  for (const input of data.events) {
    if (!isObject(input) || typeof input.id !== 'string' || typeof input.topic !== 'string'
      || typeof input.payload !== 'string' || !validTime(input.notBefore) || !validTime(input.baseDelay)
      || !validBudget(input.maxAttempts)) throw new Error('Invalid checkpoint event');
    const event = normalizeEvent({ id: input.id, topic: input.topic, payload: input.payload,
      notBefore: input.notBefore, maxAttempts: input.maxAttempts, baseDelay: input.baseDelay }, 0);
    if (events.has(event.id)) throw new Error('Duplicate checkpoint event');
    events.set(event.id, event);
  }
  for (const dispatch of queue.list()) {
    const subscription = registry.get(dispatch.subscriberId);
    const event = events.get(dispatch.id);
    if (!subscription || !event || !subscription.topics.includes(event.topic)
      || (!subscription.active && dispatch.status === 'pending')
      || dispatch.topic !== event.topic || dispatch.payload !== event.payload
      || dispatch.maxAttempts !== event.maxAttempts || dispatch.baseDelay !== event.baseDelay) {
      throw new Error('Inconsistent checkpoint dispatch');
    }
  }
  return { subscriptions: registry.list(), events: [...events.values()], dispatches: queue.list() };
}

export function serializeBroker(state: BrokerState): string {
  return JSON.stringify({ version: 2, ...state });
}
