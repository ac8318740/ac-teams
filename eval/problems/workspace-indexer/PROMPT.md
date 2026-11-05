# Build a persistent ranked workspace search system

The starter already implements Boolean queries, atomic batches, and portable snapshots. Keep that working foundation and its visible regression tests. Extend it with an incremental positional inverted index, ranked retrieval, and deterministic journal/checkpoint persistence with schema migration and recovery. These pieces must compose through one public entry point. Use Node >=22.19, ESM TypeScript, explicit type-only imports, and `.ts` import suffixes. No dependencies, filesystem scanning, watchers, network, or services are needed. Document contents are supplied as strings.

## Public API

Export these types and functions from `src/index.ts`:

```ts
export type Document = { path: string; content: string };
export type Operation =
  | { type: 'upsert'; path: string; content: string }
  | { type: 'remove'; path: string };
export interface WorkspaceIndex {
  upsert(document: Document): void;
  remove(path: string): boolean;
  applyBatch(operations: Operation[]): void;
  search(expression: string): string[];
  searchRanked(expression: string, limit?: number): SearchHit[];
  getPostings(term: string): Posting[];
  snapshot(): string;
}
export function createIndex(documents?: Document[]): WorkspaceIndex;
export function restoreIndex(snapshot: string): WorkspaceIndex;
```

Keep narrow, coherent modules for query parsing, incremental index state, ranking, storage/recovery, and snapshot serialization. Preserve the public entry point. Internal names are otherwise your choice. The contracts below define the shared boundaries; no internal module paths are graded.

## Documents and updates

- Paths are opaque, case-sensitive, nonempty strings. Do not normalize or trim them. Content may be any string, including empty.
- Reject invalid documents, paths, arrays, and operations with `TypeError`. Runtime validation matters even for callers bypassing TypeScript. Objects may have extra fields, which are ignored. Arrays are not document or operation objects.
- `createIndex()` starts empty. Initial documents are applied in order; the last duplicate path wins. Validate all initial documents.
- `upsert` adds or completely replaces one document. Old words and phrases must stop matching immediately. Copy input values; later edits to input objects must not change the index.
- `remove` returns true only when a path existed; removing an absent valid path returns false.
- `applyBatch` accepts an array of upsert/remove operations, runs in order, and returns undefined. An empty batch is valid. Validate the entire batch before changing anything. Any invalid operation, path, or content throws `TypeError` and leaves the index unchanged. A remove need not find a document. Repeated paths follow operation order.
- Instances are independent. Every search returns a fresh array of unique paths sorted ascending using JavaScript string comparison (`a < b`, not locale ordering).

## Text and query language

Text tokens are maximal ASCII `[A-Za-z0-9_]+` runs, lowercased. Punctuation separates tokens; accents and other non-ASCII characters are separators. There is no stemming or substring matching.

Expressions use these atoms:

- Bare word: one ASCII token, matched case-insensitively against content tokens.
- Quoted phrase: double-quoted text, tokenized by the same content rules. Its tokens must occur consecutively in the document token sequence. Punctuation inside a phrase is a separator. At least one token is required. Quotes have no escape syntax; backslashes are ordinary separators inside phrases.
- `path:PREFIX`: exact lowercase `path:` followed by a nonempty unquoted prefix. Prefix ends at whitespace, parentheses, or a double quote. Match `document.path.startsWith(PREFIX)`, case-sensitively. Punctuation in a prefix is literal. There is no glob syntax.

Operators are uppercase `NOT`, `AND`, and `OR` only. Lowercase `and`, `or`, and `not` are ordinary words. Precedence is `NOT` (unary, highest), then `AND`, then `OR`. Parentheses override precedence. Adjacent expressions imply `AND`, including `red blue`, `red NOT blue`, and `red(blue OR green)`. Repeated unary `NOT` is valid. Negation ranges over all current documents, including empty content. Quoted operator words are phrases, not operators.

Leading/trailing whitespace is ignored. Empty or whitespace-only expressions return `[]`. Any nonempty malformed expression throws `SyntaxError`: unmatched parentheses/quotes, empty parentheses, empty/tokenless phrases, missing operands, trailing operators, invalid bare tokens (e.g., `red-blue` or `*`), and empty `path:` prefixes. Parse the complete expression before evaluating, even when no documents exist or a Boolean branch would short-circuit. Invalid syntax must never mutate state. Non-string expressions throw `TypeError`.

Examples: `red OR blue AND NOT path:vendor/`, `"quick brown" (fox OR dog)`, `NOT (draft OR archived)`.

## Snapshots and restart recovery

`snapshot()` returns a deterministic JSON string equivalent to `JSON.stringify({version: 1, documents: [...]})`, with those property names/order, no extra properties or whitespace, and documents sorted by path using the same ordering as results. Each document is exactly `{path, content}` in that property order and preserves the original content. It includes empty documents and no derived token/index state. Identical document sets produce identical strings regardless of mutation history. Snapshotting must not change the live index.

`restoreIndex(snapshot)` accepts a string containing JSON with `version: 1` and a `documents` array. Validate every document using the same rules and reject duplicate paths. Extra object fields are ignored (including at the top level). Reject malformed JSON, unsupported versions, wrong shapes/types, invalid documents, duplicates, and non-string inputs with `TypeError`. Return a new independent, fully functional index with rebuilt searchable state. Restoring must not depend on an earlier process or index instance. Subsequent updates, batches, searches, and snapshots work normally; failed restoration cannot affect any existing index.

## Incremental inverted index and ranking

Add these exports to `src/index.ts`:

```ts
export type Posting = { path: string; positions: number[] };
export type SearchHit = { path: string; score: number };
```

Maintain positional postings keyed by normalized content token, with a posting list per document and zero-based token positions. Update only the changed documents' postings on mutations; do not retokenize or rebuild unrelated documents on each update or query. Word and phrase evaluation must use postings, Boolean evaluation must compose matching path sets, and negation must include empty documents. Path prefix evaluation may scan paths. Rebuild derived state when restoring or opening storage. No machine-speed thresholds are required.

`getPostings(term)` accepts exactly one ASCII token, case-insensitively. Other values (including a string containing whitespace or punctuation) throw `TypeError`. Missing terms return `[]`. Return fresh objects and fresh ascending position arrays, one entry per matching document, ordered by path. Mutating returned values must not change subsequent queries or postings.

`searchRanked(expression, limit?)` uses the exact same parser and matching set as `search`. Score each matching document as follows:

1. Walk the parsed expression. A content word or phrase is positive when it occurs under an even number of `NOT` operators. Collect distinct normalized positive words, including words inside positive phrases. Collect distinct normalized positive phrase token sequences separately. Repeated query words and phrases do not add weight. Path atoms add no weight. All positive atoms contribute to scoring even if their Boolean branch did not determine the match.
2. Let `N` be the number of all current documents (including empty content), `df(term)` the number containing that term, and `tf(term, document)` its occurrence count. For each positive term add `tf * (1 + Math.log((N + 1) / (df + 1)))`. Sum terms in ascending normalized token order.
3. For each distinct positive phrase add `2 * occurrenceCount`. Count contiguous occurrences, including overlapping occurrences and one-token phrases. Sum phrases in ascending order of their normalized words joined with a single space, after summing terms.
4. Sort by descending numeric score, then ascending path. A path-only or negative-only match scores zero. Apply `limit` after sorting. Omitted or `undefined` means all results; otherwise require a nonnegative safe integer (`TypeError` on invalid values). A zero limit returns `[]`, but still validates the complete query. Return fresh hit objects and arrays.

Corpus counts, term frequencies, phrases, and scores must reflect replacements, removals, batches, migration, and recovery, with no stale postings. `snapshot()` retains the v1 portable format above; persistence uses a separate v2 format below.

## Storage API

Add these exports from the same `src/index.ts`:

```ts
export interface StorageAdapter {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  remove(key: string): void;
}
export interface PersistentIndex extends WorkspaceIndex {
  readonly revision: number;
  checkpoint(): void;
}
export function createMemoryStorage(seed?: Record<string, string>): StorageAdapter;
export function createPersistentIndex(storage: StorageAdapter, documents?: Document[]): PersistentIndex;
export function openIndex(storage: StorageAdapter): PersistentIndex;
```

All methods are synchronous. Adapters are injected; no actual filesystem, process setup, network, clock, random IDs, or dependencies are needed. `createMemoryStorage` copies its optional string-valued record seed, supports arbitrary string keys (including `__proto__`), returns `undefined` for absence, overwrites on write, and removes absent keys harmlessly. Reject null, arrays, and non-string seed values with `TypeError`. Adapter arguments and read return values otherwise obey the interface. Reject missing/non-callable adapter methods with `TypeError`.

A custom adapter may throw any error from a read, write, or remove. Propagate that same error object. A successful write atomically replaces that key; a throwing write or remove has **no effect**. This is the adapter's contract, not a disk durability guarantee. Tests inject errors before effects. Writes that take effect and then throw, torn strings, and cross-process writers are outside scope.

There is one logical owner of a store at a time. After reopening, use only the new instance. Never mutate storage externally while an index owns it. No locks, concurrent writers, asynchronous methods, or automatic refresh are required. Adapter callbacks may synchronously query the current instance, but must not call its mutations, checkpoint, or open/create recursively. Such read-only callbacks during a journal write see the complete old revision; queries after the call succeeds see the complete new revision. No partially staged postings may leak.

## Durable format and commit points

Use exactly two keys: `workspace.checkpoint` and `workspace.journal`. Do not touch unrelated keys. All written JSON is compact and deterministic. Property order and shapes are:

```ts
// Checkpoint, sorted documents with the same path/content rules as snapshot():
{ version: 2, revision: 0, documents: [{ path: 'a', content: 'original' }] }
// Journal, ascending revisions; operations retain batch order:
{ version: 2, entries: [
  { revision: 1, operations: [{ type: 'upsert', path: 'a', content: 'new' }] },
  { revision: 2, operations: [{ type: 'remove', path: 'a' }] }
] }
```

Persist only the shown fields. Upserts have property order `type,path,content`; removes have `type,path`. Copy operation values; ignored extra input fields must not enter storage. A portable snapshot always remains version 1 and has no revision field.

- `createPersistentIndex` validates all initial documents, rejects either reserved key already existing with `TypeError` (including an orphan journal), writes a v2 checkpoint at revision zero, and returns an index over the supplied documents. Duplicate initial paths retain the last value, as in `createIndex`. It does not create a journal. A failed initial write leaves the store uninitialized and can be retried.
- Every nonempty `applyBatch` validates and copies the entire batch, then writes one replacement journal containing its existing entries plus one new entry. The new revision is current revision plus one. **Successful journal write is the update commit point.** Only then publish all document/posting/ranking changes to the live index and increment its revision. The returned result is undefined. Do not automatically checkpoint.
- A journal-write failure leaves revision, documents, postings, ranking, and stored journal unchanged. Reopen sees the previous committed revision. The live instance remains usable; retry may succeed. Validation errors perform no writes and leave all state unchanged.
- `upsert` is one single-operation committed batch, even if the content is identical. `remove` validates its path, returns false without writing or incrementing revision if absent, otherwise commits one removal and returns true. An empty batch is a no-op. A nonempty batch increments revision even if all operations have no net effect, including explicit removal of an absent path. Revisions must remain nonnegative safe integers; reject overflow with `TypeError` before writing.
- `checkpoint()` first writes a canonical v2 checkpoint of the current revision, then removes the journal key (even if already absent). It never increments revision or changes search state. Only after successful removal discard the in-memory journal entries. New commits thereafter start a journal at the next revision.
- If checkpoint write fails, do not attempt journal removal. Existing checkpoint/journal and live state remain usable. If journal removal fails, propagate the error, but the new checkpoint is already durable. Live state/revision are unchanged and usable; retain journal entries until cleanup succeeds. Reopen must skip entries already covered by the checkpoint, rather than applying them again. A subsequent commit may retain covered entries alongside its new entry.

Recovery sequence:

```text
validate checkpoint and entire journal -> rebuild checkpoint state
-> skip covered entries -> replay later entries in revision order -> expose index
```

## Open, migrate, and recover

`openIndex` reads both reserved keys and requires a checkpoint. Read errors propagate unchanged. Opening valid v2 storage does not write or clean anything. Return a fully functional independent live index at the last replayed revision, supporting all queries, postings, snapshots, mutations, and checkpointing.

- A v2 checkpoint requires `version: 2`, a nonnegative safe-integer revision, and valid duplicate-free documents. A missing journal means no pending entries. A journal, if present, requires `version: 2` and an entries array (possibly empty). Every entry requires a positive safe-integer revision and a nonempty valid operations array.
- Validate **every** journal entry, even one covered by the checkpoint. Entry revisions must be strictly contiguous in stored order (no duplicates, descending order, or internal gaps). The first stored entry may have any positive revision. Ignore entries whose revision is at most the checkpoint revision. Every replayed entry must then be exactly one greater than the current revision; reject any gap between checkpoint and replay. It is valid for all journal entries to be covered, even if the journal ends before the checkpoint revision. Never let covered entries overwrite newer checkpoint documents.
- Accept legacy checkpoints with the exact v1 portable snapshot rules above. A legacy checkpoint must have no journal key at all. Validate it, rebuild the index, and migrate by writing a canonical v2 checkpoint with revision zero before returning. Duplicate paths, invalid documents, or a legacy checkpoint plus any journal are errors. A failed migration write propagates unchanged and leaves legacy data intact for retry.
- Reject malformed JSON, unsupported versions, wrong shapes, invalid documents/operations/revisions, duplicates, and gaps with `TypeError`. Extra object fields in valid persisted data are ignored. Failed opening must not write, remove, truncate, partially repair, or change any stored values. Validate all input before migration writes. Corruption is not a request to reset data.

## Verification

Run visible tests with `npm test` (equivalently `node --experimental-strip-types --test test/*.test.ts`). The visible suite includes the previous complete indexer's regression tests; the starter must keep passing them. Add focused tests for the new behavior. External tests exercise component contracts and integrated migration/update/failure/checkpoint/reopen sequences through `src/index.ts`. Keep implementation inside the fixture project. Use native Node >=22.19 ESM TypeScript with type-only imports and `.ts` suffixes, no enums or dependencies.
