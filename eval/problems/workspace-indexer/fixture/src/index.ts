import { compare, tokens, validateDocument, validatePath } from './text.ts';
import type { Document } from './text.ts';
import { parse } from './query.ts';
import { deserialize, serialize } from './snapshot.ts';
export type { Document } from './text.ts';

export type Operation = { type: 'upsert'; path: string; content: string } | { type: 'remove'; path: string };
export interface WorkspaceIndex {
  upsert(document: Document): void;
  remove(path: string): boolean;
  applyBatch(operations: Operation[]): void;
  search(expression: string): string[];
  snapshot(): string;
}

export function createIndex(documents: Document[] = []): WorkspaceIndex {
  if (!Array.isArray(documents)) throw new TypeError('Invalid documents');
  for (const document of documents) validateDocument(document);
  const entries = new Map<string, { content: string; words: string[] }>();
  function upsert(document: Document): void {
    validateDocument(document);
    entries.set(document.path, { content: document.content, words: tokens(document.content) });
  }
  documents.forEach(upsert);
  return {
    upsert,
    remove(path: string): boolean {
      validatePath(path);
      return entries.delete(path);
    },
    applyBatch(operations: Operation[]): void {
      if (!Array.isArray(operations)) throw new TypeError('Invalid operations');
      for (const operation of operations) {
        if (!operation || typeof operation !== 'object' || Array.isArray(operation)) throw new TypeError('Invalid operation');
        if (operation.type === 'upsert') validateDocument(operation);
        else if (operation.type === 'remove') validatePath(operation.path);
        else throw new TypeError('Invalid operation');
      }
      for (const operation of operations) {
        if (operation.type === 'upsert') upsert(operation);
        else entries.delete(operation.path);
      }
    },
    search(expression: string): string[] {
      const predicate = parse(expression);
      return [...entries].filter(([path, entry]) => predicate(path, entry.words)).map(([path]) => path).sort(compare);
    },
    snapshot(): string {
      return serialize([...entries].map(([path, entry]) => ({ path, content: entry.content })));
    },
  };
}

export function restoreIndex(snapshot: string): WorkspaceIndex {
  return createIndex(deserialize(snapshot));
}
