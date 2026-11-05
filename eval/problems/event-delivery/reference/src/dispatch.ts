import type { Dispatch, DispatchFilter, DispatchKey, DispatchTransport } from './broker-types.ts';
import type { EventInput } from './types.ts';
import { isObject, requireName } from './broker-types.ts';
import { makeDelivery, validTime } from './queue.ts';
import { readDelivery } from './persistence.ts';

const pair = (subscriberId: string, id: string): string => JSON.stringify([subscriberId, id]);
const copy = (record: Dispatch): Dispatch => ({ ...record });

function readDispatch(record: Dispatch): Dispatch {
  if (!isObject(record)) throw new Error('Invalid dispatch');
  requireName(record.subscriberId);
  if (record.status === 'cancelled') {
    if (record.nextAttemptAt !== null) throw new Error('Invalid cancelled time');
    const delivery = readDelivery({ ...record, status: 'pending', nextAttemptAt: 0 });
    return { ...delivery, subscriberId: record.subscriberId, status: 'cancelled', nextAttemptAt: null };
  }
  // readDelivery owns retry/terminal consistency for both systems.
  const delivery = readDelivery({ ...record, status: record.status });
  return { ...delivery, subscriberId: record.subscriberId };
}

function validateFilter(filter: DispatchFilter): void {
  if (!isObject(filter)) throw new Error('Invalid filter');
  if (filter.subscriberId !== undefined) requireName(filter.subscriberId);
  if (filter.topic !== undefined) requireName(filter.topic);
  if (filter.status !== undefined && (typeof filter.status !== 'string'
    || !['pending', 'delivered', 'dead', 'cancelled'].includes(filter.status))) {
    throw new Error('Invalid dispatch status');
  }
}

export function createDispatchQueue(initial?: Dispatch[]) {
  const records = new Map<string, Dispatch>();
  let draining = false;
  const idle = () => { if (draining) throw new Error('Drain in progress'); };
  const find = (subscriberId: string, id: string) => {
    requireName(subscriberId); requireName(id);
    return records.get(pair(subscriberId, id));
  };
  if (initial !== undefined) {
    if (!Array.isArray(initial)) throw new Error('Invalid dispatches');
    for (const value of initial) {
      const record = readDispatch(value);
      const key = pair(record.subscriberId, record.id);
      if (records.has(key)) throw new Error('Duplicate dispatch');
      records.set(key, record);
    }
  }
  return {
    enqueue(subscriberId: string, input: EventInput, now = 0): Dispatch {
      idle(); requireName(subscriberId);
      const record: Dispatch = { ...makeDelivery(input, now), subscriberId };
      const key = pair(subscriberId, record.id);
      const existing = records.get(key);
      if (existing) return copy(existing);
      records.set(key, record);
      return copy(record);
    },
    get(subscriberId: string, id: string): Dispatch | undefined {
      const record = find(subscriberId, id);
      return record && copy(record);
    },
    list(filter: DispatchFilter = {}): Dispatch[] {
      validateFilter(filter);
      return [...records.values()].filter(record =>
        (filter.subscriberId === undefined || record.subscriberId === filter.subscriberId)
        && (filter.topic === undefined || record.topic === filter.topic)
        && (filter.status === undefined || record.status === filter.status)).map(copy);
    },
    cancel(subscriberId: string, id: string): boolean {
      idle();
      const record = find(subscriberId, id);
      if (record?.status !== 'pending') return false;
      record.status = 'cancelled'; record.nextAttemptAt = null;
      return true;
    },
    replay(subscriberId: string, id: string, now: number): boolean {
      idle();
      if (!validTime(now)) throw new Error('Invalid replay time');
      const record = find(subscriberId, id);
      if (record?.status !== 'dead') return false;
      record.status = 'pending'; record.attempts = 0; record.lastError = null; record.nextAttemptAt = now;
      return true;
    },
    async drain(now: number, transport: DispatchTransport, subscriberIds?: string[]): Promise<DispatchKey[]> {
      idle();
      if (!validTime(now) || typeof transport !== 'function') throw new Error('Invalid drain');
      let eligible: Set<string> | undefined;
      if (subscriberIds !== undefined) {
        if (!Array.isArray(subscriberIds)) throw new Error('Invalid eligible subscribers');
        for (const id of subscriberIds) requireName(id);
        eligible = new Set(subscriberIds);
      }
      const ready = [...records.values()].filter(record => record.status === 'pending'
        && record.nextAttemptAt! <= now && (!eligible || eligible.has(record.subscriberId)))
        .sort((a, b) => a.nextAttemptAt! - b.nextAttemptAt!);
      draining = true;
      const attempted: DispatchKey[] = [];
      try {
        for (const record of ready) {
          attempted.push({ subscriberId: record.subscriberId, id: record.id });
          record.attempts++;
          try {
            await transport(copy(record));
            record.status = 'delivered'; record.lastError = null; record.nextAttemptAt = null;
          } catch (error) {
            record.lastError = error instanceof Error ? error.message : String(error);
            if (record.attempts === record.maxAttempts) {
              record.status = 'dead'; record.nextAttemptAt = null;
            } else {
              record.nextAttemptAt = now + record.baseDelay * 2 ** (record.attempts - 1);
            }
          }
        }
        return attempted;
      } finally { draining = false; }
    },
  };
}
