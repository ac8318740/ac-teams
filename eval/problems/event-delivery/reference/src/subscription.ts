import type { Subscription, SubscriptionInput } from './broker-types.ts';
import { isObject, requireName } from './broker-types.ts';

function validate(input: SubscriptionInput): void {
  if (!isObject(input)) throw new Error('Invalid subscription');
  requireName(input.id);
  if (!Array.isArray(input.topics) || !input.topics.length) throw new Error('Invalid topics');
  for (const topic of input.topics) requireName(topic);
  if (new Set(input.topics).size !== input.topics.length) throw new Error('Duplicate topic');
}
const copy = (record: Subscription): Subscription => ({ ...record, topics: [...record.topics] });

export function createSubscriptionRegistry(initial?: Subscription[]) {
  const records = new Map<string, Subscription>();
  if (initial !== undefined) {
    if (!Array.isArray(initial)) throw new Error('Invalid subscriptions');
    for (const record of initial) {
      validate(record);
      if (typeof record.active !== 'boolean' || typeof record.paused !== 'boolean' || records.has(record.id)) {
        throw new Error('Invalid subscription state');
      }
      records.set(record.id, { id: record.id, topics: [...record.topics], active: record.active, paused: record.paused });
    }
  }
  return {
    add(input: SubscriptionInput): Subscription {
      validate(input);
      const existing = records.get(input.id);
      if (existing) return copy(existing);
      const record = { id: input.id, topics: [...input.topics], active: true, paused: false };
      records.set(record.id, record);
      return copy(record);
    },
    get(id: string): Subscription | undefined {
      requireName(id);
      const record = records.get(id);
      return record && copy(record);
    },
    list(): Subscription[] { return [...records.values()].map(copy); },
    match(topic: string): Subscription[] {
      requireName(topic);
      return [...records.values()].filter(record => record.active && record.topics.includes(topic)).map(copy);
    },
    setPaused(id: string, paused: boolean): boolean {
      requireName(id);
      if (typeof paused !== 'boolean') throw new Error('Invalid pause flag');
      const record = records.get(id);
      if (!record?.active) return false;
      record.paused = paused;
      return true;
    },
    remove(id: string): boolean {
      requireName(id);
      const record = records.get(id);
      if (!record?.active) return false;
      record.active = false;
      return true;
    },
  };
}
