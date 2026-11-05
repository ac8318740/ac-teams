import { compare, tokens, validateDocument, validatePath } from './text.ts';
import type { Document } from './text.ts';
export type { Document } from './text.ts';

export function createIndex(documents: Document[] = []) {
  if (!Array.isArray(documents)) throw new TypeError('Invalid documents');
  documents.forEach(validateDocument);
  const contents = new Map<string, string>();
  function upsert(document: Document): void {
    validateDocument(document);
    contents.set(document.path, document.content);
  }
  documents.forEach(upsert);
  return {
    upsert,
    remove(path: string): boolean {
      validatePath(path);
      return contents.delete(path);
    },
    search(expression: string): string[] {
      if (typeof expression !== 'string') throw new TypeError('Invalid expression');
      const words = tokens(expression);
      if (!words.length) return [];
      return [...contents].filter(([, content]) => {
        const present = new Set(tokens(content));
        return words.every(word => present.has(word));
      }).map(([path]) => path).sort(compare);
    },
  };
}
