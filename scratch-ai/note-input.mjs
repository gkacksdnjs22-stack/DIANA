// Explicit note syntax is a program boundary, not a learned language skill.
// The classifier sees the instruction; storage retains the original payload.
import { canonicalCornerQuotes } from './corner-quotes.mjs';
const colon = /^(새\s*메모(?:\s*(?:만들어줘|작성해줘))?|메모\s*(?:저장|작성해줘)|이\s*내용을\s*기록해\s*메모로|메모\s*하나\s*남기자|잊지\s*않도록\s*메모해\s*둘게|기록을\s*하나\s*남겨줘|새\s*쪽지로\s*적어줘)\s*[:：]\s*([\s\S]+)$/;
const quotePattern = /["“]([^"”\r\n]{1,1500})["”]/g;
export function splitExplicitNote(text) {
  const match = colon.exec(text);
  if (match) return { instruction: match[1], content: match[2], modelText: `${match[1]}: <본문>` };
  text = canonicalCornerQuotes(text);
  if (text === null) return null;
  const quotes = [...text.matchAll(quotePattern)];
  if (quotes.length !== 1) return null;
  const outer = text.replace(quotes[0][0], 'DIANAARGUMENTTOKEN');
  if (!/^(?:메모\s*내용은\s*DIANAARGUMENTTOKEN|DIANAARGUMENTTOKEN\s*(?:라고\s*메모해줘|내용을\s*메모로\s*남겨줘)|새\s*노트에\s*DIANAARGUMENTTOKEN\s*적어줘)[.!?]*$/.test(outer)) return null;
  return { instruction: outer, content: quotes[0][1], modelText: outer.replace('DIANAARGUMENTTOKEN', '<본문>') };
}
export const INPUT_MODE = 'note-payload-v1';
export function modelInput(text, mode = INPUT_MODE) {
  if (mode === 'raw-v1') return text;
  if (mode !== INPUT_MODE) throw new Error('unsupported_input_mode');
  return splitExplicitNote(text)?.modelText || canonicalCornerQuotes(text) || text;
}
