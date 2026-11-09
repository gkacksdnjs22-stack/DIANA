// PROGRAM syntax support only. Convert valid corner delimiters for existing
// parsers/model inputs; never normalize or replace any quoted payload byte.
const pairs = new Map([["'", "'"], ['"', '"'], ['‘', '’'], ['“', '”'], ['「', '」']]);
const marks = new Set([...pairs.keys(), ...pairs.values()]);
export function canonicalCornerQuotes(text) {
  if (!/[「」]/u.test(text)) return text;
  const changes = []; let opening = null;
  for (let i = 0; i < text.length; i++) {
    const char = text[i]; if (!marks.has(char)) continue;
    let escapes = 0; for (let j = i - 1; j >= 0 && text[j] === '\\'; j--) escapes++;
    if (escapes % 2) return null;
    if ((char === "'" || char === '’') && /[A-Za-z0-9]/u.test(text[i - 1] || '') && /[A-Za-z0-9]/u.test(text[i + 1] || '')) continue;
    if (opening) {
      if (pairs.get(opening) !== char) return null;
      opening = null;
    } else {
      if (!pairs.has(char)) return null;
      opening = char;
    }
    if (char === '「' || char === '」') changes.push(i);
  }
  if (opening) return null;
  let result = '', cursor = 0;
  for (const index of changes) { result += text.slice(cursor, index) + '"'; cursor = index + 1; }
  return result + text.slice(cursor);
}
