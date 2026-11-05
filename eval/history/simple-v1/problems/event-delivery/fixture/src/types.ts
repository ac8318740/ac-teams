export type DeliveryStatus = 'pending' | 'delivered' | 'dead';

export interface EventInput {
  id: string;
  topic: string;
  payload: string;
}

export interface Delivery extends EventInput {
  status: DeliveryStatus;
  attempts: number;
  lastError: string | null;
}

export type Transport = (event: Delivery) => void | Promise<void>;
