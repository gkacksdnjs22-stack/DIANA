import { keys, fail, validId } from './strict-json.mjs';

// Replacement seam for DIANA action/argument predictions. No model is loaded.
// Predictions must still pass the same operation, policy and approval boundaries.
export function explicitOperation(input) {
  keys(input, ['action', 'target_doc', 'source_ids', 'guideline_id', 'item_ids', 'format']);
  if (!['checklist_review', 'patch', 'convert', 'export'].includes(input.action) || !['txt', 'md', 'json'].includes(input.format) ||
      !validId(input.target_doc) || !validId(input.guideline_id) || !Array.isArray(input.source_ids) || input.source_ids.length > 16 ||
      !Array.isArray(input.item_ids) || input.item_ids.length > 32 ||
      [...input.source_ids, ...input.item_ids].some(id => !validId(id)) || new Set(input.source_ids).size !== input.source_ids.length ||
      new Set(input.item_ids).size !== input.item_ids.length) fail('INVALID_OPERATION');
  return { ...structuredClone(input), inference_mode: 'explicit' };
}
