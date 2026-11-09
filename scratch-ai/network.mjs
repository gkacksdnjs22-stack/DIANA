// A small, genuinely trained neural classifier. No pretrained tensors or runtime dependencies.
// Character n-grams -> sum(trainable embeddings)/sqrt(token count) -> tanh -> softmax.
import { INPUT_MODE, modelInput } from './note-input.mjs';
import { QUOTE_INPUT_MODE, quotedModelInput } from './quoted-input.mjs';
const inputModes = [INPUT_MODE, 'raw-v1', QUOTE_INPUT_MODE];
export const LABELS = ['search', 'send', 'note', 'cancel', 'clarify', 'unsupported'];
export const normalize = text => text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
export function tokens(text, inputMode = INPUT_MODE) {
  const input = inputMode === QUOTE_INPUT_MODE ? quotedModelInput(text) : modelInput(text, inputMode);
  const chars = [...`^${normalize(input).replace(/\s/g, '')}$`];
  const result = new Set();
  for (const n of [1, 2, 3, 4]) for (let i = 0; i + n <= chars.length; i++) result.add(chars.slice(i, i + n).join(''));
  return [...result];
}
export function rng(seed = 42023) {
  return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; };
}
export function vocabulary(rows, inputMode = INPUT_MODE) {
  return Object.fromEntries([...new Set(rows.flatMap(r => tokens(r.text, inputMode)))].sort().map((t, i) => [t, i]));
}
export class IntentNet {
  constructor(vocab, { hidden = 24, seed = 42023, inputMode = INPUT_MODE } = {}) {
    if (!inputModes.includes(inputMode)) throw new Error('unsupported_input_mode');
    this.vocab = vocab; this.hidden = hidden; this.seed = seed; this.inputMode = inputMode;
    const random = rng(seed);
    this.embedding = Float64Array.from({ length: Object.keys(vocab).length * hidden }, () => (random() - 0.5) * 0.2);
    this.weights = Float64Array.from({ length: hidden * LABELS.length }, () => (random() - 0.5) * 0.3);
    this.bias = new Float64Array(LABELS.length);
    this.hiddenBias = new Float64Array(hidden);
  }
  encode(text) { return tokens(text, this.inputMode).filter(t => Object.hasOwn(this.vocab, t)).map(t => this.vocab[t]); }
  forward(ids) {
    const h = this.hidden; const a = new Float64Array(h); const logits = new Float64Array(LABELS.length);
    const scale = 1 / Math.sqrt(Math.max(1, ids.length));
    for (let j = 0; j < h; j++) {
      let z = this.hiddenBias[j];
      for (const id of ids) z += this.embedding[id * h + j] * scale;
      a[j] = Math.tanh(z);
    }
    for (let k = 0; k < LABELS.length; k++) {
      logits[k] = this.bias[k];
      for (let j = 0; j < h; j++) logits[k] += a[j] * this.weights[j * LABELS.length + k];
    }
    const max = Math.max(...logits); const exps = Array.from(logits, v => Math.exp(v - max)); const sum = exps.reduce((a, b) => a + b, 0);
    return { a, probs: exps.map(v => v / sum), scale };
  }
  step(ids, label, learningRate) {
    const { a, probs, scale } = this.forward(ids); const h = this.hidden;
    const delta = probs.map((v, k) => v - (k === label ? 1 : 0));
    const hiddenDelta = new Float64Array(h);
    for (let j = 0; j < h; j++) {
      let sum = 0;
      for (let k = 0; k < LABELS.length; k++) sum += this.weights[j * LABELS.length + k] * delta[k];
      hiddenDelta[j] = sum * (1 - a[j] ** 2);
    }
    for (let k = 0; k < LABELS.length; k++) {
      this.bias[k] -= learningRate * delta[k];
      for (let j = 0; j < h; j++) this.weights[j * LABELS.length + k] -= learningRate * a[j] * delta[k];
    }
    for (let j = 0; j < h; j++) {
      this.hiddenBias[j] -= learningRate * hiddenDelta[j];
      for (const id of ids) this.embedding[id * h + j] -= learningRate * hiddenDelta[j] * scale;
    }
    return -Math.log(Math.max(1e-12, probs[label]));
  }
  predict(text) {
    if (typeof text !== 'string' || text.length > 2000) throw new Error('invalid_input');
    const all = tokens(text, this.inputMode); const ids = this.encode(text); const { probs } = this.forward(ids);
    const ranked = probs.map((p, i) => ({ label: LABELS[i], probability: p })).sort((a, b) => b.probability - a.probability);
    return { ...ranked[0], margin: ranked[0].probability - ranked[1].probability,
      coverage: ids.length / Math.max(1, all.length), probabilities: Object.fromEntries(ranked.map(x => [x.label, x.probability])) };
  }
  serialize() {
    return { version: 2, inputMode: this.inputMode, architecture: 'character-ngram-tanh-softmax', initialization: 'random', labels: LABELS,
      vocab: this.vocab, hidden: this.hidden, seed: this.seed,
      embedding: [...this.embedding], weights: [...this.weights], bias: [...this.bias], hiddenBias: [...this.hiddenBias] };
  }
  static load(data) {
    if (!data || typeof data !== 'object' || ![1, 2].includes(data.version) || (data.version === 2 && !inputModes.includes(data.inputMode)) || data.architecture !== 'character-ngram-tanh-softmax' || JSON.stringify(data.labels) !== JSON.stringify(LABELS) ||
        !Number.isInteger(data.hidden) || data.hidden < 1 || data.hidden > 128 || !data.vocab || !Object.keys(data.vocab).length || Object.keys(data.vocab).length > 50000 ||
        Object.values(data.vocab).some((v, i) => v !== i)) throw new Error('invalid_checkpoint');
    const net = new IntentNet(data.vocab, { hidden: data.hidden, seed: data.seed, inputMode: data.version === 1 ? 'raw-v1' : data.inputMode });
    for (const key of ['embedding', 'weights', 'bias', 'hiddenBias']) {
      if (!Array.isArray(data[key]) || data[key].length !== net[key].length || data[key].some(v => !Number.isFinite(v))) throw new Error('invalid_checkpoint');
      net[key].set(data[key]);
    }
    return net;
  }
}
