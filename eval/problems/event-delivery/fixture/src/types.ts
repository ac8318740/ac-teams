export type DeliveryStatus = 'pending' | 'delivered' | 'dead';
export interface EventInput {
  id: string;
  topic: string;
  payload: string;
  notBefore?: number;
  maxAttempts?: number;
  baseDelay?: number;
}
export interface Delivery {
  id: string;
  topic: string;
  payload: string;
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
  nextAttemptAt: number | null;
  maxAttempts: number;
  baseDelay: number;
}
export type Transport = (event: Delivery) => void | Promise<void>;
