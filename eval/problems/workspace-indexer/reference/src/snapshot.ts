import { compare, validateDocument } from './text.ts';
import type { Document } from './text.ts';

export function serialize(documents: Document[]): string {
  return JSON.stringify({ version: 1, documents: [...documents].sort((a, b) => compare(a.path, b.path)).map(({ path, content }) => ({ path, content })) });
}

export function deserialize(snapshot: string): Document[] {
  try {
    if (typeof snapshot !== 'string') throw new TypeError();
    const value: unknown = JSON.parse(snapshot);
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
    const data = value as Record<string, unknown>;
    if (data.version !== 1 || !Array.isArray(data.documents)) throw new TypeError();
    const seen = new Set<string>();
    for (const document of data.documents) {
      validateDocument(document);
      if (seen.has(document.path)) throw new TypeError();
      seen.add(document.path);
    }
    return data.documents as Document[];
  } catch {
    throw new TypeError('Invalid snapshot');
  }
}
