import type { Delivery, EventInput } from './types.ts';

export function makeDelivery(input: EventInput): Delivery {
  if (!input || typeof input.id !== 'string' || !input.id.trim()
    || typeof input.topic !== 'string' || !input.topic.trim()
    || typeof input.payload !== 'string') throw new Error('Invalid event');
  return { id: input.id, topic: input.topic, payload: input.payload,
    status: 'pending', attempts: 0, lastError: null };
}

export function copy(record: Delivery): Delivery {
  return { ...record };
}
