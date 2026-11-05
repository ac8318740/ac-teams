import type { Delivery } from './types.ts';
import { validBudget, validStrings, validTime } from './queue.ts';

export function restore(text: string): Map<string, Delivery> {
  let data;
  try { data = JSON.parse(text); } catch { throw new Error('Invalid snapshot JSON'); }
  if (!data || data.version !== 1 || !Array.isArray(data.records)) throw new Error('Invalid snapshot');
  const records = new Map<string, Delivery>();
  for (const record of data.records) {
    if (!validStrings(record) || !validBudget(record.maxAttempts) || !validTime(record.baseDelay)
      || !Number.isInteger(record.attempts) || record.attempts < 0 || record.attempts > record.maxAttempts
      || (record.lastError !== null && typeof record.lastError !== 'string') || records.has(record.id)) {
      throw new Error('Invalid snapshot record');
    }
    const { status, attempts, maxAttempts, nextAttemptAt, lastError } = record;
    const valid = status === 'pending'
      ? validTime(nextAttemptAt) && attempts < maxAttempts
        && (attempts === 0 ? lastError === null : typeof lastError === 'string')
      : status === 'delivered'
        ? attempts >= 1 && nextAttemptAt === null && lastError === null
        : status === 'dead' && attempts === maxAttempts && nextAttemptAt === null && typeof lastError === 'string';
    if (!valid) throw new Error('Invalid snapshot state');
    records.set(record.id, { id: record.id, topic: record.topic, payload: record.payload,
      status, attempts, maxAttempts, nextAttemptAt, lastError, baseDelay: record.baseDelay });
  }
  return records;
}

export function serialize(records: Iterable<Delivery>): string {
  return JSON.stringify({ version: 1, records: [...records] });
}
