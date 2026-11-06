import { createIndex, copyOperations } from './index.ts';
import type { WorkspaceIndex, Operation } from './index.ts';
import type { Document } from './text.ts';
import { validateDocument, validatePath } from './text.ts';
import { deserialize } from './snapshot.ts';

export interface StorageAdapter {
  read(key: string): string | undefined;
  write(key: string, value: string): void;
  remove(key: string): void;
}
export interface PersistentIndex extends WorkspaceIndex {
  readonly revision: number;
  checkpoint(): void;
}
const CHECKPOINT = 'workspace.checkpoint';
const JOURNAL = 'workspace.journal';
type Entry = { revision: number; operations: Operation[] };

export function createMemoryStorage(seed: Record<string, string> = {}): StorageAdapter {
  if (!seed || typeof seed !== 'object' || Array.isArray(seed) || Object.values(seed).some(value => typeof value !== 'string')) throw new TypeError('Invalid storage seed');
  const values = new Map(Object.entries(seed));
  return {
    read(key) { return values.get(key); },
    write(key, value) { values.set(key, value); },
    remove(key) { values.delete(key); },
  };
}

function validateStorage(storage: StorageAdapter): void {
  if (!storage || typeof storage.read !== 'function' || typeof storage.write !== 'function' || typeof storage.remove !== 'function') throw new TypeError('Invalid storage');
}
function object(text: string): Record<string, unknown> {
  try {
    if (typeof text !== 'string') throw new TypeError();
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    return value as Record<string, unknown>;
  } catch { throw new TypeError('Invalid persisted data'); }
}
function revision(value: unknown): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new TypeError('Invalid revision');
}
function checkpointText(index: WorkspaceIndex, value: number): string {
  return JSON.stringify({ version: 2, revision: value, documents: deserialize(index.snapshot()) });
}
function attach(storage: StorageAdapter, index: WorkspaceIndex, current: number, entries: Entry[]): PersistentIndex {
  function applyBatch(operations: Operation[]): void {
    const copied = copyOperations(operations);
    if (!copied.length) return;
    revision(current + 1);
    // Covered history may end before the checkpoint; do not append across that gap.
    const history = entries.length && entries.at(-1)!.revision < current ? [] : entries;
    const nextEntries = [...history, { revision: current + 1, operations: copied }];
    storage.write(JOURNAL, JSON.stringify({ version: 2, entries: nextEntries }));
    // The successful atomic journal write is the only update commit point.
    index.applyBatch(copied);
    current++;
    entries = nextEntries;
  }
  return {
    get revision() { return current; },
    upsert(document): void { validateDocument(document); applyBatch([{ type: 'upsert', path: document.path, content: document.content }]); },
    remove(path): boolean {
      validatePath(path);
      const exists = deserialize(index.snapshot()).some(document => document.path === path);
      if (exists) applyBatch([{ type: 'remove', path }]);
      return exists;
    },
    applyBatch,
    search: expression => index.search(expression),
    searchRanked: (expression, limit) => index.searchRanked(expression, limit),
    getPostings: term => index.getPostings(term),
    snapshot: () => index.snapshot(),
    checkpoint(): void {
      storage.write(CHECKPOINT, checkpointText(index, current));
      storage.remove(JOURNAL);
      entries = [];
    },
  };
}

export function createPersistentIndex(storage: StorageAdapter, documents: Document[] = []): PersistentIndex {
  validateStorage(storage);
  const index = createIndex(documents);
  if (storage.read(CHECKPOINT) !== undefined || storage.read(JOURNAL) !== undefined) throw new TypeError('Storage already initialized');
  storage.write(CHECKPOINT, checkpointText(index, 0));
  return attach(storage, index, 0, []);
}

export function openIndex(storage: StorageAdapter): PersistentIndex {
  validateStorage(storage);
  const checkpoint = storage.read(CHECKPOINT);
  const journal = storage.read(JOURNAL);
  if (checkpoint === undefined) throw new TypeError('Missing checkpoint');
  const data = object(checkpoint);
  if (data.version !== 1 && data.version !== 2) throw new TypeError('Unsupported storage version');
  const documents = deserialize(JSON.stringify({ version: 1, documents: data.documents }));
  let current = 0;
  if (data.version === 2) { revision(data.revision); current = data.revision; }
  else if (journal !== undefined) throw new TypeError('Legacy journal is not supported');
  const entries: Entry[] = [];
  if (journal !== undefined) {
    const log = object(journal);
    if (log.version !== 2 || !Array.isArray(log.entries)) throw new TypeError('Invalid journal');
    for (const raw of log.entries) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('Invalid journal entry');
      revision(raw.revision);
      if (raw.revision === 0 || (entries.length && raw.revision !== entries.at(-1)!.revision + 1)) throw new TypeError('Out of order journal');
      const operations = copyOperations(raw.operations);
      if (!operations.length) throw new TypeError('Empty journal entry');
      entries.push({ revision: raw.revision, operations });
    }
  }
  const index = createIndex(documents);
  for (const entry of entries) {
    if (entry.revision <= current) continue;
    if (entry.revision !== current + 1) throw new TypeError('Journal gap');
    index.applyBatch(entry.operations);
    current = entry.revision;
  }
  if (data.version === 1) storage.write(CHECKPOINT, checkpointText(index, 0));
  return attach(storage, index, current, entries);
}
