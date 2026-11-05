import type { Delivery, EventInput } from './types.ts';

export function validTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
export function validStrings(value: EventInput): boolean {
  return !!value && typeof value.id === 'string' && !!value.id.trim()
    && typeof value.topic === 'string' && !!value.topic.trim()
    && typeof value.payload === 'string';
}
export function validBudget(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1;
}
export function makeDelivery(input: EventInput, now: number): Delivery {
  if (!validTime(now) || !validStrings(input)) throw new Error('Invalid event');
  const { notBefore = now, maxAttempts = 3, baseDelay = 10 } = input;
  if (!validTime(notBefore) || !validBudget(maxAttempts) || !validTime(baseDelay)) {
    throw new Error('Invalid event options');
  }
  return { id: input.id, topic: input.topic, payload: input.payload, status: 'pending',
    attempts: 0, lastError: null, nextAttemptAt: notBefore, maxAttempts, baseDelay };
}
export function copy(record: Delivery): Delivery {
  return { ...record };
}
export function due(records: Iterable<Delivery>, now: number): Delivery[] {
  return [...records].filter(record => record.status === 'pending' && record.nextAttemptAt! <= now)
    .sort((a, b) => a.nextAttemptAt! - b.nextAttemptAt!);
}
