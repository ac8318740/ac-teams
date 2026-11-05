import { compare, tokens } from './text.ts';
import type { Document } from './text.ts';
import type { Query } from './query.ts';

export type Posting = { path: string; positions: number[] };

export class IndexState {
  documents = new Map<string, string>();
  postings = new Map<string, Map<string, number[]>>();
  private documentTerms = new Map<string, Set<string>>();

  constructor(documents: Document[]) { for (const document of documents) this.upsert(document); }

  remove(path: string): boolean {
    for (const term of this.documentTerms.get(path) ?? []) {
      const posting = this.postings.get(term)!;
      posting.delete(path);
      if (!posting.size) this.postings.delete(term);
    }
    this.documentTerms.delete(path);
    return this.documents.delete(path);
  }

  upsert({ path, content }: Document): void {
    this.remove(path);
    const words = tokens(content);
    const terms = new Set(words);
    this.documents.set(path, content);
    this.documentTerms.set(path, terms);
    words.forEach((word, position) => {
      if (!this.postings.has(word)) this.postings.set(word, new Map());
      const posting = this.postings.get(word)!;
      if (!posting.has(path)) posting.set(path, []);
      posting.get(path)!.push(position);
    });
  }

  exportDocuments(): Document[] {
    return [...this.documents].map(([path, content]) => ({ path, content })).sort((a, b) => compare(a.path, b.path));
  }

  getPostings(term: string): Posting[] {
    if (typeof term !== 'string' || !/^[A-Za-z0-9_]+$/.test(term)) throw new TypeError('Invalid term');
    return [...(this.postings.get(term.toLowerCase()) ?? [])]
      .map(([path, positions]) => ({ path, positions: [...positions] })).sort((a, b) => compare(a.path, b.path));
  }

  phraseCount(words: string[], path: string): number {
    const starts = this.postings.get(words[0])?.get(path) ?? [];
    return starts.filter(start => words.every((word, offset) => this.postings.get(word)?.get(path)?.includes(start + offset))).length;
  }

  evaluate(query: Query): Set<string> {
    switch (query.kind) {
      case 'empty': return new Set();
      case 'word': return new Set(this.postings.get(query.value)?.keys());
      case 'path': return new Set([...this.documents.keys()].filter(path => path.startsWith(query.value)));
      case 'phrase': return new Set([...(this.postings.get(query.words[0])?.keys() ?? [])].filter(path => this.phraseCount(query.words, path) > 0));
      case 'not': {
        const excluded = this.evaluate(query.child);
        return new Set([...this.documents.keys()].filter(path => !excluded.has(path)));
      }
      case 'and': {
        const left = this.evaluate(query.left), right = this.evaluate(query.right);
        return new Set([...left].filter(path => right.has(path)));
      }
      case 'or': return new Set([...this.evaluate(query.left), ...this.evaluate(query.right)]);
    }
  }
}
