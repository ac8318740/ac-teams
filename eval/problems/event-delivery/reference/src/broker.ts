import type { EventInput } from './types.ts';
import type { Dispatch, DispatchFilter, DispatchKey, DispatchTransport, StoredEvent, SubscriptionInput } from './broker-types.ts';
import { createSubscriptionRegistry } from './subscription.ts';
import { createDispatchQueue } from './dispatch.ts';
import { normalizeEvent, restoreBroker, serializeBroker } from './state.ts';
import { requireName } from './broker-types.ts';
import { validTime } from './queue.ts';

export function createBroker(checkpoint?: string) {
  const state = checkpoint === undefined ? undefined : restoreBroker(checkpoint);
  const registry = createSubscriptionRegistry(state?.subscriptions);
  const queue = createDispatchQueue(state?.dispatches);
  const events = new Map<string, StoredEvent>(state?.events.map(event => [event.id, event]));
  let draining = false;
  const idle = () => { if (draining) throw new Error('Drain in progress'); };
  return {
    subscribe(input: SubscriptionInput) { idle(); return registry.add(input); },
    getSubscription(id: string) { return registry.get(id); },
    listSubscriptions() { return registry.list(); },
    setPaused(id: string, paused: boolean): boolean { idle(); return registry.setPaused(id, paused); },
    unsubscribe(id: string): boolean {
      idle();
      if (!registry.remove(id)) return false;
      for (const record of queue.list({ subscriberId: id, status: 'pending' })) queue.cancel(id, record.id);
      return true;
    },
    publish(input: EventInput, now = 0): Dispatch[] {
      idle();
      const event = normalizeEvent(input, now);
      if (events.has(event.id)) return queue.list().filter(record => record.id === event.id);
      const recipients = registry.match(event.topic);
      events.set(event.id, event);
      return recipients.map(subscription => queue.enqueue(subscription.id, event, now));
    },
    events(): StoredEvent[] { return [...events.values()].map(event => ({ ...event })); },
    get(subscriberId: string, id: string) { return queue.get(subscriberId, id); },
    list(filter?: DispatchFilter) { return queue.list(filter); },
    cancel(subscriberId: string, id: string): boolean { idle(); return queue.cancel(subscriberId, id); },
    replay(subscriberId: string, id: string, now: number): boolean {
      idle(); requireName(subscriberId); requireName(id);
      if (!validTime(now)) throw new Error('Invalid replay time');
      if (!registry.get(subscriberId)?.active) return false;
      return queue.replay(subscriberId, id, now);
    },
    snapshot(): string {
      idle();
      return serializeBroker({ subscriptions: registry.list(), events: [...events.values()], dispatches: queue.list() });
    },
    async drain(now: number, transport: DispatchTransport): Promise<DispatchKey[]> {
      idle();
      draining = true;
      try {
        return await queue.drain(now, transport, registry.list()
          .filter(subscription => subscription.active && !subscription.paused).map(subscription => subscription.id));
      } finally { draining = false; }
    },
  };
}
