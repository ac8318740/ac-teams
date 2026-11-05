export type Document = { path: string; content: string };

export function tokens(text: string): string[] {
  return (text.match(/[A-Za-z0-9_]+/g) ?? []).map(word => word.toLowerCase());
}

export function validatePath(path: unknown): asserts path is string {
  if (typeof path !== 'string' || path.length === 0) throw new TypeError('Invalid path');
}

export function validateDocument(value: unknown): asserts value is Document {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Invalid document');
  const doc = value as Record<string, unknown>;
  validatePath(doc.path);
  if (typeof doc.content !== 'string') throw new TypeError('Invalid content');
}

export function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
