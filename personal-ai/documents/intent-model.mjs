// Reuse a known neural architecture, never its trained weights. These six output
// coordinates have a separate, explicitly saved meaning in this experiment.
import { createHash } from 'node:crypto';
import { IntentNet, LABELS, vocabulary, tokens } from '../../scratch-ai/network.mjs';
import { canonicalCornerQuotes } from '../../scratch-ai/corner-quotes.mjs';

export const DOCUMENT_LABELS = Object.freeze(['extract', 'locate', 'create', 'cancel', 'clarify', 'unsupported']);
export const DOCUMENT_MODEL_VERSION = 'document-intent-v1';
export const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
export function documentModelInput(text) {
  if (typeof text !== 'string' || text.length > 2000) throw new Error('invalid_input');
  // Filename masking is program preprocessing, not learned slot extraction.
  const canonical = canonicalCornerQuotes(text);
  if (canonical === null) return text;
  return canonical.replace(/"[^"\r\n]*"|“[^”\r\n]*”|'[^'\r\n]*'/g, '<문서파일>');
}
export const documentInputKey = text => JSON.stringify(tokens(documentModelInput(text), 'raw-v1').sort());
export class DocumentIntentModel {
  constructor(network, info = {}) { this.network = network; this.info = info; }
  predict(text) {
    const p = this.network.predict(documentModelInput(text));
    return { ...p, label: DOCUMENT_LABELS[LABELS.indexOf(p.label)], probabilities: Object.fromEntries(LABELS.map((label, i) => [DOCUMENT_LABELS[i], p.probabilities[label]])) };
  }
  serialize() { return { kind: DOCUMENT_MODEL_VERSION, labels: DOCUMENT_LABELS, input: 'quoted-filename-mask-v1', network: this.network.serialize() }; }
  static create(rows, seed = 20261024) {
    const mapped = rows.map(row => ({ text: documentModelInput(row.text) }));
    return new DocumentIntentModel(new IntentNet(vocabulary(mapped, 'raw-v1'), { inputMode: 'raw-v1', seed, hidden: 24 }));
  }
  static load(saved, info = {}) {
    if (saved?.kind !== DOCUMENT_MODEL_VERSION || saved.input !== 'quoted-filename-mask-v1' || JSON.stringify(saved.labels) !== JSON.stringify(DOCUMENT_LABELS) || saved.network?.initialization !== 'random' || saved.network?.inputMode !== 'raw-v1') throw new Error('invalid_document_checkpoint');
    return new DocumentIntentModel(IntentNet.load(saved.network), info);
  }
}
