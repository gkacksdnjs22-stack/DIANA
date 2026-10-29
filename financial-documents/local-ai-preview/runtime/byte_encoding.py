import numpy as np
from model import preprocess as original_preprocess
ARMS=["Char","Byte"]
def byte_vocab():return {'<PAD>':0,**{f'<byte:{b:02x}>':b+1 for b in range(256)},**{f'<unused:{i}>':i for i in range(257,288)}}
def byte_ids(text):return np.frombuffer(text.encode('utf-8'),dtype=np.uint8).astype(np.int64)+1
def decode_bytes(ids):
    assert all(1<=int(i)<=256 for i in ids)
    return bytes(int(i)-1 for i in ids).decode('utf-8')
def byte_offsets(text):
    a=[0]
    for c in text:a.append(a[-1]+len(c.encode('utf-8')))
    return a
def encode(x,char_vocab,arm):
    assert arm in ARMS
    z=original_preprocess(x,char_vocab)
    if arm=='Char':return z
    # Original matching/permissions/context/UTF16 spans remain intact.
    offsets=byte_offsets(x['request']);z['ids']=byte_ids(x['request'])
    z['meta']=[byte_ids('\n'.join([c['display_name'],*c['aliases']])) for c in z['catalog']]
    z['pairs']=[{**p,'a':offsets[p['a']],'b':offsets[p['b']]} for p in z['pairs']]
    return z
