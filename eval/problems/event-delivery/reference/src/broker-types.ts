import type { Delivery, DeliveryStatus } from './types.ts';

export interface SubscriptionInput { id: string; topics: string[] }
export interface Subscription extends SubscriptionInput { paused: boolean; active: boolean }
export interface StoredEvent {
  id: string;
  topic: string;
  payload: string;
  notBefore: number;
  maxAttempts: number;
  baseDelay: number;
}
export type DispatchStatus = DeliveryStatus | 'cancelled';
export type Dispatch = Omit<Delivery, 'status'> & { status: DispatchStatus; subscriberId: string };
export interface DispatchKey { subscriberId: string; id: string }
export interface DispatchFilter { subscriberId?: string; topic?: string; status?: DispatchStatus }
export type DispatchTransport = (record: Dispatch) => void | Promise<void>;

export function requireName(value: unknown): asserts value is string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Expected nonblank string');
}
export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
