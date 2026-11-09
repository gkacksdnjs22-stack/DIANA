import { modelInput } from './note-input.mjs';
import { canonicalCornerQuotes } from './corner-quotes.mjs';

// A classifier-only representation. Original text still goes to the existing
// argument parser and policy checks; these markers never authorize an action.
export const QUOTE_INPUT_MODE = 'quote-context-v1';
const closing = new Map([["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”']]);
const quoteCharacters = new Set([...closing.keys(), ...closing.values()]);
const latinWord = value => value !== undefined && /[A-Za-z0-9]/.test(value);

function escaped(text, index) {
  let slashes = 0;
  for (let i = index - 1; i >= 0 && text[i] === '\\'; i--) slashes++;
  return slashes % 2 === 1;
}

export function quotedModelInput(text) {
  // Reject instead of truncating: a trailing negation must remain visible.
  if (typeof text !== 'string' || text.length > 2000) throw new Error('invalid_input');
  const originalInput = modelInput(text);
  const input = canonicalCornerQuotes(originalInput);
  if (input === null) return originalInput;
  const stack = [];
  const spans = [];
  let start = -1;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (!quoteCharacters.has(char) || escaped(input, i)) continue;
    // don't / O'Reilly / O’Reilly are words, not syntactic quote pairs.
    if ((char === "'" || char === '’') && latinWord(input[i - 1]) && latinWord(input[i + 1])) continue;
    const top = stack.at(-1);
    if (top && closing.get(top) === char) {
      stack.pop();
      if (!stack.length) spans.push({ start, end: i });
      continue;
    }
    // An unmatched closing mark or crossing pairs make the entire quote
    // representation ambiguous. Preserve the input in that case.
    if (!closing.has(char) || stack.includes(char)) return input;
    if (!stack.length) start = i;
    stack.push(char);
  }
  if (stack.length || !spans.length) return input;
  let result = '';
  let cursor = 0;
  for (const [index, span] of spans.entries()) {
    const present = input.slice(span.start + 1, span.end).trim().length > 0;
    // Keep delimiters and every outside character. A position marker retains
    // multiple arguments even though the network uses a set of n-grams.
    result += input.slice(cursor, span.start + 1);
    result += `<인용${String.fromCharCode(0xac00 + index)}:${present ? '본문' : '빈본문'}>`;
    cursor = span.end;
  }
  return result + input.slice(cursor);
}
