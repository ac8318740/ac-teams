import { compare, validateDocument, validatePath } from './text.ts';
import type { Document } from './text.ts';
import { parse } from './query.ts';
import { deserialize, serialize } from './snapshot.ts';
import { IndexState } from './state.ts';
import type { Posting } from './state.ts';
import { rank } from './ranking.ts';
import type { SearchHit } from './ranking.ts';
export type { Document } from './text.ts';
export type { Posting } from './state.ts';
export type { SearchHit } from './ranking.ts';
export { createMemoryStorage, createPersistentIndex, openIndex } from './persistent.ts';
export type { StorageAdapter, PersistentIndex } from './persistent.ts';

export type Operation = { type: 'upsert'; path: string; content: string } | { type: 'remove'; path: string };
export interface WorkspaceIndex {
  upsert(document: Document): void;
  remove(path: string): boolean;
  applyBatch(operations: Operation[]): void;
  search(expression: string): string[];
  searchRanked(expression: string, limit?: number): SearchHit[];
  getPostings(term: string): Posting[];
  snapshot(): string;
}

export function copyOperations(operations: Operation[]): Operation[] {
  if (!Array.isArray(operations)) throw new TypeError('Invalid operations');
  return Array.from(operations, operation => {
    if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new TypeError('Invalid operation');
    if (operation.type === 'upsert') {
      validateDocument(operation);
      return { type: 'upsert', path: operation.path, content: operation.content };
    }
    if (operation.type === 'remove') { validatePath(operation.path); return { type: 'remove', path: operation.path }; }
    throw new TypeError('Invalid operation');
  });
}

export function createIndex(documents: Document[] = []): WorkspaceIndex {
  if (!Array.isArray(documents)) throw new TypeError('Invalid documents');
  for (const document of documents) validateDocument(document);
  const state = new IndexState(documents);
  return {
    upsert(document): void { validateDocument(document); state.upsert(document); },
    remove(path): boolean { validatePath(path); return state.remove(path); },
    applyBatch(operations): void {
      for (const operation of copyOperations(operations)) {
        if (operation.type === 'upsert') state.upsert(operation);
        else state.remove(operation.path);
      }
    },
    search(expression): string[] { return [...state.evaluate(parse(expression))].sort(compare); },
    searchRanked(expression, limit): SearchHit[] { return rank(state, parse(expression), limit); },
    getPostings(term): Posting[] { return state.getPostings(term); },
    snapshot(): string { return serialize(state.exportDocuments()); },
  };
}

export function restoreIndex(snapshot: string): WorkspaceIndex {
  return createIndex(deserialize(snapshot));
}
