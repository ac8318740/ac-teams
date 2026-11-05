# Scheduled event delivery

Extend the working immediate-delivery library in `src/`. Add scheduling, retry/backoff, restart-safe JSON snapshots, and filtered status queries. Keep its existing named exports and immediate-success behavior. Use coherent modules; no packages, services, timers, real clocks, or network calls are needed.

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

Visible tests cover the working starter's immediate-success API. Add your own regression tests for the new behavior. Keep those tests passing; the former single-failure-is-terminal behavior is intentionally replaced by the retry policy above.
