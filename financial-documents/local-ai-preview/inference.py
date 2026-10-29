"""Frozen section28 Byte31 inference only; stdin never contains labels or IDs of cases."""
import sys,json,hashlib,time
from pathlib import Path
ROOT=Path(__file__).resolve().parent
sys.stdout.reconfigure(encoding='utf-8')
def main():
    assets=ROOT/'assets'
    lock=json.loads((assets/'manifest.json').read_text(encoding='utf-8'))
    for item in lock['files']:
        p=ROOT/item['path']
        if hashlib.sha256(p.read_bytes()).hexdigest()!=item['sha256']:raise ValueError('MODEL_HASH_CHANGED')
    numpy_root=Path(sys.executable).resolve().parents[1]/'numpy'
    if numpy_root.is_dir():sys.path.insert(0,str(numpy_root))
    sys.path.insert(0,str(ROOT/'runtime'))
    import numpy as np
    from model import Model,predict
    from byte_encoding import encode
    b=sys.stdin.buffer.read(131073)
    if len(b)>131072:raise ValueError('INPUT_TOO_LARGE')
    x=json.loads(b)
    if set(x)!={'schema_version','request','context','candidates'} or x['schema_version']!=1:raise ValueError('INPUT_INVALID')
    if not isinstance(x['request'],str) or not 0<len(x['request'])<=2000 or len(x['request'].encode('utf-8'))>8192:raise ValueError('INPUT_INVALID')
    if set(x['context'])!={'allowed_action','confirmed_format'} or x['context']['allowed_action']!='checklist_review' or x['context']['confirmed_format'] not in [None,'md','txt','json']:raise ValueError('INPUT_INVALID')
    if not isinstance(x['candidates'],list) or len(x['candidates'])>100:raise ValueError('INPUT_INVALID')
    for c in x['candidates']:
        if set(c)!={'id','display_name','aliases','roles'}:raise ValueError('INPUT_INVALID')
    read=lambda n:json.loads((assets/n).read_text(encoding='utf-8'))
    started=time.perf_counter();z=encode(x,read('char-vocab.json'),'Byte')
    if len(z['pairs'])>4096:raise ValueError('INPUT_TOO_LARGE')
    m=Model(read('vocab.json'),read('model-config.json'));m.load(assets/'final-update1100.npz')
    prediction=predict(m,[z])[0]
    return {'ok':True,'prediction':prediction,'model':{'id':'section28-Byte-20261031-update1100','encoding':'utf8-byte-v1','seed':20261031,'updates':1100,'tensor_digest':m.digest(),'manifest_sha256':hashlib.sha256((assets/'manifest.json').read_bytes()).hexdigest(),'numpy':np.__version__,'python':sys.version.split()[0]},'seconds':time.perf_counter()-started}
try: print(json.dumps(main(),ensure_ascii=False,allow_nan=False))
except Exception as e:
    code=str(e) if isinstance(e,ValueError) and str(e) in ['MODEL_HASH_CHANGED','INPUT_INVALID','INPUT_TOO_LARGE'] else 'RUNTIME_FAILED'
    print(json.dumps({'ok':False,'error':{'code':'AI_PREVIEW_'+code}}));sys.exit(1)
