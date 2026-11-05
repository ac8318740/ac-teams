import { compare } from './text.ts';
import type { Query } from './query.ts';
import type { IndexState } from './state.ts';
export type SearchHit = { path: string; score: number };

export function rank(state: IndexState, query: Query, limit?: number): SearchHit[] {
  if (limit !== undefined && (!Number.isSafeInteger(limit) || limit < 0)) throw new TypeError('Invalid limit');
  const terms = new Set<string>();
  const phrases = new Map<string, string[]>();
  function collect(node: Query, positive = true): void {
    if (node.kind === 'not') collect(node.child, !positive);
    else if (node.kind === 'and' || node.kind === 'or') { collect(node.left, positive); collect(node.right, positive); }
    else if (positive && node.kind === 'word') terms.add(node.value);
    else if (positive && node.kind === 'phrase') {
      node.words.forEach(word => terms.add(word));
      phrases.set(node.words.join(' '), node.words);
    }
  }
  collect(query);
  const orderedTerms = [...terms].sort(compare);
  const orderedPhrases = [...phrases].sort(([a], [b]) => compare(a, b));
  return [...state.evaluate(query)].map(path => {
    let score = 0;
    for (const term of orderedTerms) {
      const posting = state.postings.get(term);
      score += (posting?.get(path)?.length ?? 0) * (1 + Math.log((state.documents.size + 1) / ((posting?.size ?? 0) + 1)));
    }
    for (const [, words] of orderedPhrases) score += 2 * state.phraseCount(words, path);
    return { path, score };
  }).sort((a, b) => b.score - a.score || compare(a.path, b.path)).slice(0, limit);
}
