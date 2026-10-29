"""Read-only loader/mention compatibility check. No model, inference or optimizer is created."""
import argparse, json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE / 'local-ai-preview/runtime'))
# Windows bundle includes NumPy beside the Python runtime, not in site-packages.
bundled_numpy = HERE.parents[1] / 'runtime/numpy'
if bundled_numpy.exists():
    sys.path.insert(0, str(bundled_numpy))
from model import preprocess, pair_index, STATUSES, INTENTS, FIELDS, CODES, FORMAT_CLASSES
from byte_encoding import encode


def check(bundle):
    assert bundle['schema_version'] == 1
    assert bundle['training_ready'] is False and bundle['split_assigned'] is False
    vocab = json.loads((HERE / 'local-ai-preview/assets/char-vocab.json').read_text(encoding='utf-8'))
    checked = []
    for row in bundle['rows']:
        x, t, mask = row['input'], row['target'], row['supervision']
        assert t['scores'] is None
        assert t['status'] in STATUSES and t['intent'] in INTENTS
        assert all(i['field'] in FIELDS and i['code'] in CODES[1:] for i in t['issues'])
        assert len({i['field'] for i in t['issues']}) == len(t['issues'])
        review = t['intent'] == 'checklist_review'
        assert mask == dict(status=True, intent=True, issues=True, arguments=review,
                            argument_supervision='review' if review else 'unannotated')
        for arm in ['Char', 'Byte']:
            item = preprocess(x, vocab) if arm == 'Char' else encode(x, vocab, arm)
            if review:
                for binding in [t['target_doc'], *t['source_ids'], t['guideline_id']]:
                    pair_index(item, binding)
                f = t['format']
                assert (None if f is None else (f['origin'], f['value'])) in FORMAT_CLASSES
                if f and f['origin'] == 'request':
                    assert any(p['kind'] == 'format' and p['span'] == f['span'] and p['literal_value'] == f['value'] for p in item['pairs'])
            else:
                assert t['target_doc'] is None and t['source_ids'] == [] and t['guideline_id'] is None and t['format'] is None
        checked.append({'example_id': row['example_id'], 'arguments_supervised': review})
    return dict(format_check_only=True, model_loaded=False, inference=False, training=False,
                rows=len(checked), purpose=bundle['purpose'], checked=checked,
                training_ready=False, evaluation_ready=False)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('bundle', type=Path)
    args = parser.parse_args()
    print(json.dumps(check(json.loads(args.bundle.read_text(encoding='utf-8'))), ensure_ascii=False))
