# Extend the workspace text indexer

The starter is a working in-memory text indexer. Extend it with Boolean queries, atomic batches, and portable snapshots. Preserve its existing behavior and tests. Use Node >=22.19, ESM TypeScript, explicit type-only imports, and `.ts` import suffixes. No dependencies, filesystem scanning, watchers, network, or services are needed. Document contents are supplied as strings.

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
  snapshot(): string;
}
export function createIndex(documents?: Document[]): WorkspaceIndex;
export function restoreIndex(snapshot: string): WorkspaceIndex;
```

Keep coherent modules for query parsing, index state, and snapshot serialization. Preserve the public entry point. Internal structure is otherwise your choice.

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

Run visible tests with `npm test` (equivalently `node --experimental-strip-types --test test/*.test.ts`). Add focused tests for the new behavior. Keep all implementation inside the fixture project; external evaluation tests will import its `src/index.ts`.
