import type { Transport } from './types.ts';
import { copy, makeDelivery } from './queue.ts';
import type { Delivery, EventInput } from './types.ts';

export function createDeliveryService() {
  const records = new Map<string, Delivery>();
  return {
    enqueue(input: EventInput, _now = 0): Delivery {
      const record = makeDelivery(input);
      const existing = records.get(record.id);
      if (existing) return copy(existing);
      records.set(record.id, record);
      return copy(record);
    },
    get(id: string): Delivery | undefined {
      const record = records.get(id);
      return record && copy(record);
    },
    list(): Delivery[] {
      return [...records.values()].map(copy);
    },
    async drain(_now: number, transport: Transport): Promise<string[]> {
      const attempted: string[] = [];
      for (const record of records.values()) {
        if (record.status !== 'pending') continue;
        attempted.push(record.id);
        record.attempts++;
        try {
          await transport(copy(record));
          record.status = 'delivered';
          record.lastError = null;
        } catch (error) {
          record.status = 'dead';
          record.lastError = error instanceof Error ? error.message : String(error);
        }
      }
      return attempted;
    },
  };
}
