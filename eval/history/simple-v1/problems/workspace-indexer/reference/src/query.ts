import { tokens } from './text.ts';

export type Predicate = (path: string, words: string[]) => boolean;

type Lexeme = { kind: string; value: string };

export function parse(expression: string): Predicate {
  if (typeof expression !== 'string') throw new TypeError('Invalid expression');
  const parts: Lexeme[] = [];
  let cursor = 0;
  const invalid = (): never => { throw new SyntaxError('Invalid query'); };
  while (cursor < expression.length) {
    if (/\s/.test(expression[cursor])) { cursor++; continue; }
    const char = expression[cursor];
    if (char === '(' || char === ')') {
      parts.push({ kind: char, value: char }); cursor++; continue;
    }
    if (char === '"') {
      const end = expression.indexOf('"', cursor + 1);
      if (end < 0) invalid();
      const value = expression.slice(cursor + 1, end);
      if (!tokens(value).length) invalid();
      parts.push({ kind: 'phrase', value }); cursor = end + 1; continue;
    }
    const start = cursor;
    while (cursor < expression.length && !/[\s()"]/.test(expression[cursor])) cursor++;
    const value = expression.slice(start, cursor);
    if (value.startsWith('path:')) {
      if (value.length === 5) invalid();
      parts.push({ kind: 'path', value: value.slice(5) });
    } else if (['AND', 'OR', 'NOT'].includes(value)) {
      parts.push({ kind: value, value });
    } else {
      if (!/^[A-Za-z0-9_]+$/.test(value)) invalid();
      parts.push({ kind: 'word', value: value.toLowerCase() });
    }
  }
  if (!parts.length) return () => false;
  let position = 0;
  const kind = () => parts[position]?.kind;
  function unary(): Predicate {
    const part = parts[position++];
    if (!part) return invalid();
    if (part.kind === 'NOT') {
      const child = unary();
      return (path, words) => !child(path, words);
    }
    if (part.kind === '(') {
      const child = disjunction();
      if (kind() !== ')') invalid();
      position++;
      return child;
    }
    if (part.kind === 'word') return (_, words) => words.includes(part.value);
    if (part.kind === 'path') return path => path.startsWith(part.value);
    if (part.kind === 'phrase') {
      const phrase = tokens(part.value);
      return (_, words) => words.some((_, start) => phrase.every((word, offset) => words[start + offset] === word));
    }
    return invalid();
  }
  function conjunction(): Predicate {
    let left = unary();
    while (kind() && kind() !== ')' && kind() !== 'OR') {
      if (kind() === 'AND') position++;
      const right = unary();
      const previous = left;
      left = (path, words) => previous(path, words) && right(path, words);
    }
    return left;
  }
  function disjunction(): Predicate {
    let left = conjunction();
    while (kind() === 'OR') {
      position++;
      const right = conjunction();
      const previous = left;
      left = (path, words) => previous(path, words) || right(path, words);
    }
    return left;
  }
  const predicate = disjunction();
  if (position !== parts.length) invalid();
  return predicate;
}
