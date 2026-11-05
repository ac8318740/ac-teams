import { tokens } from './text.ts';

export type Query =
  | { kind: 'empty' }
  | { kind: 'word'; value: string }
  | { kind: 'path'; value: string }
  | { kind: 'phrase'; words: string[] }
  | { kind: 'not'; child: Query }
  | { kind: 'and' | 'or'; left: Query; right: Query }; 

type Lexeme = { kind: string; value: string };

export function parse(expression: string): Query {
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
  if (!parts.length) return { kind: 'empty' };
  let position = 0;
  const kind = () => parts[position]?.kind;
  function unary(): Query {
    const part = parts[position++];
    if (!part) return invalid();
    if (part.kind === 'NOT') {
      const child = unary();
      return { kind: 'not', child };
    }
    if (part.kind === '(') {
      const child = disjunction();
      if (kind() !== ')') invalid();
      position++;
      return child;
    }
    if (part.kind === 'word') return { kind: 'word', value: part.value };
    if (part.kind === 'path') return { kind: 'path', value: part.value };
    if (part.kind === 'phrase') return { kind: 'phrase', words: tokens(part.value) };
    return invalid();
  }
  function conjunction(): Query {
    let left = unary();
    while (kind() && kind() !== ')' && kind() !== 'OR') {
      if (kind() === 'AND') position++;
      const right = unary();
      left = { kind: 'and', left, right };
    }
    return left;
  }
  function disjunction(): Query {
    let left = conjunction();
    while (kind() === 'OR') {
      position++;
      const right = conjunction();
      left = { kind: 'or', left, right };
    }
    return left;
  }
  const predicate = disjunction();
  if (position !== parts.length) invalid();
  return predicate;
}
