import type { Delivery, DeliveryStatus, EventInput, Transport } from './types.ts';
import { copy, due, makeDelivery, validTime } from './queue.ts';
import { restore, serialize } from './persistence.ts';

export function createDeliveryService(snapshot?: string) {
  const records = snapshot === undefined ? new Map<string, Delivery>() : restore(snapshot);
  return {
    enqueue(input: EventInput, now = 0): Delivery {
      const record = makeDelivery(input, now);
      const existing = records.get(record.id);
      if (existing) return copy(existing);
      records.set(record.id, record);
      return copy(record);
    },
    get(id: string): Delivery | undefined {
      const record = records.get(id);
      return record && copy(record);
    },
    list(filter: { status?: DeliveryStatus; topic?: string } = {}): Delivery[] {
      return [...records.values()].filter(record =>
        (filter.status === undefined || record.status === filter.status)
        && (filter.topic === undefined || record.topic === filter.topic)).map(copy);
    },
    snapshot(): string { return serialize(records.values()); },
    async drain(now: number, transport: Transport): Promise<string[]> {
      if (!validTime(now)) throw new Error('Invalid time');
      const attempted: string[] = [];
      for (const record of due(records.values(), now)) {
        attempted.push(record.id);
        record.attempts++;
        try {
          await transport(copy(record));
          record.status = 'delivered';
          record.lastError = null;
          record.nextAttemptAt = null;
        } catch (error) {
          record.lastError = error instanceof Error ? error.message : String(error);
          if (record.attempts >= record.maxAttempts) {
            record.status = 'dead';
            record.nextAttemptAt = null;
          } else {
            record.nextAttemptAt = now + record.baseDelay * 2 ** (record.attempts - 1);
          }
        }
      }
      return attempted;
    },
  };
}
