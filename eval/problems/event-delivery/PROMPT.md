# Subscription delivery and recovery

Extend the working scheduled-delivery library in `src/` into a subscription delivery system. Preserve `createDeliveryService` and its behavior below. Add independently usable subscription and dispatch components, then compose them into `createBroker` with fan-out, cancellation, dead-letter replay, and validated checkpoints. Keep the existing modules; add `subscription.ts`, `dispatch.ts`, and `state.ts` (and a broker module if useful). Export the new factories and types from `src/index.ts`. No packages, services, timers, real clocks, or network calls are needed.

Run visible tests with `npm test` (Node >=22.19). Use ESM, explicit `.ts` imports, `import type` for types, and syntax supported by native TypeScript stripping (no enums).

## Public API

Export `createDeliveryService(snapshot?: string)` from `src/index.ts`. With no argument, start empty; with a snapshot, restore it synchronously. Also export the types `EventInput`, `Delivery`, `DeliveryStatus`, and `Transport`.

`EventInput` contains `id`, `topic`, and `payload` strings, plus optional `notBefore`, `maxAttempts`, and `baseDelay` numbers. IDs and topics must contain a non-whitespace character (preserve the original string); payload may be empty. All times and delays are finite, nonnegative numbers. `maxAttempts` is an integer >=1. Defaults: `notBefore = now`, `maxAttempts = 3`, `baseDelay = 10`. Fractional times and zero delays are valid.

`Delivery` has exactly these fields: `id`, `topic`, `payload`, `status` (`pending`, `delivered`, or `dead`), `attempts`, `lastError`, `nextAttemptAt`, `maxAttempts`, and `baseDelay`. `attempts` starts at zero, `lastError` at null, and `nextAttemptAt` at `notBefore`. Terminal records have `nextAttemptAt: null`.

The returned service provides:

- `enqueue(input: EventInput, now = 0): Delivery`: validate input and `now`, then insert a pending record. A duplicate ID returns the original record unchanged, even after delivery, death, or restore; it does not reset attempts or replace content. Invalid duplicates still throw. IDs such as `__proto__` are valid.
- `get(id: string): Delivery | undefined`: current state or undefined if missing.
- `list(filter?: { status?: DeliveryStatus; topic?: string }): Delivery[]`: all records in insertion order, restricted by each supplied filter (AND semantics). Empty results are `[]`. Filtering does not change delivery order.
- `drain(now: number, transport: Transport): Promise<string[]>`: attempt the records pending and due (`nextAttemptAt <= now`) at the start of this call, sequentially in ascending `nextAttemptAt` order, breaking ties by insertion order. Await each transport before starting the next. Return IDs attempted in that order. Each record is attempted at most once per call, including zero-delay retries. Enqueues during transport are deferred to a later drain. A transport is `(record: Delivery) => void | Promise<void>`; it receives a detached record with the incremented attempt count. A resolved call succeeds; a thrown value or rejected promise fails. Continue with other due records after failures. Concurrent/reentrant drains are outside the task.
- `snapshot(): string`: a JSON string containing `{ "version": 1, "records": [...] }`, with the full records in insertion order, including terminal records. Call snapshot only when no drain is in progress (before the first drain or after awaiting a completed drain). In-flight snapshots and crash recovery during a transport call are outside the task. Restore must preserve all checkpoint state and ordering. Snapshots do not use a filesystem; callers can save the returned string and pass it to a new service.

All returned records and records passed to transport are detached copies. Mutating an input after enqueue, a query result, an enqueue result, or a transport argument must not mutate the service.

## Retry rules

Before calling transport, increment attempts. Success marks `delivered`, clears `lastError`, and sets `nextAttemptAt` to null. On failure, store `error.message` for an Error, otherwise `String(error)`. When attempts reaches `maxAttempts`, mark `dead` and clear `nextAttemptAt`; otherwise stay `pending` and schedule `now + baseDelay * 2 ** (attempts - 1)`. Use this drain's supplied `now`, not the prior due time or wall clock. The latest failure replaces the previous error. Delivered and dead events are never attempted again. Retry state survives snapshots. Numeric overflow in backoff calculations is outside the task.

Example: enqueue at 100 with `maxAttempts: 3, baseDelay: 5`; failures at 100 and 105 schedule 105 and 115. Success at 115 leaves attempts 3, delivered status, no error, and no next attempt.

## Validation and restore

Throw an Error for invalid enqueue input/options/time, invalid drain time, or malformed snapshots. Validation must not partially change existing state. Validate drain time even for an empty service. No particular error message or Error subclass is required.

Restore accepts only version 1 with a records array. Each record must have valid strings, one of the three statuses, integer attempts >=0 and <=maxAttempts, valid maxAttempts/baseDelay, and lastError either null or a string. IDs must be unique. Pending records require a finite nonnegative nextAttemptAt and attempts < maxAttempts; pending attempts 0 require lastError null, and pending attempts >0 require a string lastError. Delivered records require attempts >=1, lastError null, and nextAttemptAt null. Dead records require attempts = maxAttempts, a string lastError, and nextAttemptAt null. Missing required fields are invalid. Unknown extra object fields may be ignored. Restoring must not call a transport or reset retry budgets.

Visible tests cover the complete scheduled-delivery foundation above. Keep them passing and add tests for the new system below. Additional grading tests are not part of the prepared project.

## New shared types and validation

Export these types (interfaces or equivalent structural types):

```ts
interface SubscriptionInput { id: string; topics: string[] }
interface Subscription extends SubscriptionInput { paused: boolean; active: boolean }
interface StoredEvent {
  id: string; topic: string; payload: string;
  notBefore: number; maxAttempts: number; baseDelay: number;
}
type DispatchStatus = DeliveryStatus | 'cancelled';
// All Delivery fields, but status uses DispatchStatus; add subscriberId: string.
type Dispatch = Omit<Delivery, 'status'> & { status: DispatchStatus; subscriberId: string };
interface DispatchKey { subscriberId: string; id: string }
interface DispatchFilter { subscriberId?: string; topic?: string; status?: DispatchStatus }
type DispatchTransport = (record: Dispatch) => void | Promise<void>;
```

All new APIs validate at runtime, including duplicates and calls on missing IDs. IDs/topics are nonblank strings, preserved verbatim; `__proto__` and arbitrary punctuation are valid. Topics arrays are nonempty with unique entries (exact string equality). Boolean arguments must be booleans. Filters must be non-null objects with valid supplied values and use AND semantics. Unknown extra object fields may be ignored. Explicit `undefined` optional arguments act like omission. Invalid input throws an Error before any mutation or transport call; asynchronous methods reject. No specific error text is required.

All input arrays, returned arrays/records (including nested topics), and transport arguments are detached. No operation may mutate a peer subscriber's dispatch through an aliased object. All times, event options, defaults, failure formatting, and retry rules are those of the foundation. Numeric backoff overflow remains outside scope.

## Subscription component

Export `createSubscriptionRegistry(records?: Subscription[])` from `subscription.ts` and the index. Omission starts empty; supplied records restore in array order after validating all fields and unique IDs. Both `paused` and `active` are required booleans on restored records.

- `add(input: SubscriptionInput): Subscription`: insert active, unpaused subscription. A duplicate ID returns its original record unchanged, even after removal. Topics cannot be updated or reactivated under the same ID.
- `get(id: string): Subscription | undefined`, `list(): Subscription[]`: detached queries in insertion order.
- `match(topic: string): Subscription[]`: active subscribers whose topics contain the exact topic, in subscription order. Paused subscriptions still match: pause affects attempts, not acceptance.
- `setPaused(id: string, paused: boolean): boolean`: update an active subscription, returning true; missing/inactive returns false.
- `remove(id: string): boolean`: mark an active subscription inactive; missing/already inactive returns false. Preserve its topics, pause flag, and insertion position.

No wildcard matching or historical backfill. Removal is retained as a tombstone so checkpoints and old dispatches remain meaningful.

## Dispatch component

Export `createDispatchQueue(records?: Dispatch[])` from `dispatch.ts` and the index. This manages all subscriber queues together, keyed by the pair `(subscriberId, id)`, without joining strings with an ambiguous delimiter. Omission starts empty. Restore validates all records and pair uniqueness before accepting any state. Use the foundation's state consistency rules for pending/delivered/dead. Cancelled records require `nextAttemptAt: null`, `attempts < maxAttempts`, and either attempts 0 with null error or attempts >0 with string error.

- `enqueue(subscriberId: string, input: EventInput, now = 0): Dispatch`: same event validation/defaults as the foundation. Duplicate pair returns the original unchanged, including terminal state. Different subscribers can use the same event ID independently.
- `get(subscriberId: string, id: string): Dispatch | undefined`, `list(filter?: DispatchFilter): Dispatch[]`: global insertion order, detached queries.
- `cancel(subscriberId: string, id: string): boolean`: only pending becomes cancelled, preserving attempts and error but clearing nextAttemptAt. Return true on transition; false for missing/terminal records.
- `replay(subscriberId: string, id: string, now: number): boolean`: only dead becomes pending. Reset attempts to 0, lastError to null, and nextAttemptAt to now; retain payload, retry policy, and original insertion position. Return false for missing/non-dead records; validate now even then.
- `drain(now: number, transport: DispatchTransport, subscriberIds?: string[]): Promise<DispatchKey[]>`: same sequential, once-per-call, stable due-time ordering as the foundation, across all eligible subscriber queues. Omission allows all subscribers; an empty array allows none. When supplied, validate the whole array of nonblank IDs before attempting anything. Failure in one queue does not stop peers or later events in its own queue. A blocked retry is not head-of-line blocking for later due events. Return attempted pairs in attempt order.

During a queue drain, queries are allowed but all queue mutators and a second drain reject. Validate that transport is a function even for an empty queue. Always release the drain guard after completion, including validation failures. This avoids ambiguous interleaving; no concurrent processing is required.

## Broker integration

Export `createBroker(checkpoint?: string)` from the index. Compose the components rather than putting the entire system in one module. It provides:

- `subscribe(input: SubscriptionInput): Subscription`, `getSubscription(id: string): Subscription | undefined`, `listSubscriptions(): Subscription[]`, and `setPaused(id: string, paused: boolean): boolean` with registry semantics.
- `unsubscribe(id: string): boolean`: remove the subscription and cancel all its pending dispatches atomically. Other subscribers and terminal records are unchanged. Return the registry removal result.
- `publish(input: EventInput, now = 0): Dispatch[]`: validate and remember the normalized event, then enqueue one dispatch for each currently active matching subscriber, including paused subscribers, in subscription order. A duplicate event ID returns its existing dispatches in global insertion order without replacing event content, retry policy, or adding recipients. Even an event with no recipients reserves its ID. A new subscriber receives only future first-time publications.
- `events(): StoredEvent[]`: normalized events in first-publication order, including those with no recipients.
- `get(subscriberId, id)`, `list(filter?)`, `cancel(subscriberId, id)`, and `replay(subscriberId, id, now)` with dispatch semantics. Broker replay additionally returns false for a dead dispatch belonging to an inactive subscription. Paused active subscriptions may replay but cannot attempt until resumed.
- `drain(now: number, transport: DispatchTransport): Promise<DispatchKey[]>`: attempt only active, unpaused subscribers. Pausing does not change due times or retry budgets. A resumed subscriber keeps its original ordering. Transport receives the subscriber ID alongside the event fields.
- `snapshot(): string`: synchronously encode the checkpoint below.

While a broker drain is in progress, queries are allowed; every broker mutator, another drain, and snapshot must reject without changing state. A transport may query but cannot publish, cancel, replay, or change subscriptions during that drain. This restriction applies only to the new broker/queue, not the legacy service. Call snapshots only before or between completed drains. No in-flight persistence or true concurrency is required.

## Checkpoint contract

Broker checkpoints are JSON objects `{ version: 2, subscriptions: Subscription[], events: StoredEvent[], dispatches: Dispatch[] }`. Arrays preserve their respective insertion orders. Include inactive subscriptions, all published events, and every terminal dispatch. Empty checkpoints are valid. The legacy service continues using its separate version-1 format; neither factory accepts the other's format.

Restore synchronously, without a transport, after validating the complete checkpoint. Require every declared field, correct version/arrays, unique subscription IDs, unique event IDs, and unique dispatch pairs. Stored events require valid strings, finite nonnegative notBefore/baseDelay, and integer maxAttempts >=1. Validate component states as above. Every dispatch must reference an existing subscription and event; that subscription's topics must include the event topic; dispatch topic/payload/maxAttempts/baseDelay must equal the stored event. An inactive subscriber cannot have pending dispatches. Restoring does not require that every currently matching subscription has a dispatch (subscriptions may have been added later). Unknown extra fields may be ignored. Checkpoints must be JSON-round-trippable and preserve duplicate suppression, retry budgets, pauses, tombstones, cancellation, dead letters, replay ordering, and isolation across independently restored brokers.

Keep the implementation bounded to this deterministic in-memory system. No filesystem persistence, background scheduling, unsubscribe reactivation, configurable routing language, or crash recovery during transport is required.
