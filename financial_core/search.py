"""Read-only TF-IDF retrieval. Ranking is not a financial judgment or AI intent."""
import math
from collections import Counter
from .schemas import fields, require, text, identifier, canonical, sha, MAX_INPUT
from .doc_parser import parse_document, normalize
from .deterministic_tools import reference

VERSION = 'evidence-tfidf-char12-v1'

def terms(raw):
    value = normalize(raw)
    return Counter([('u', c) for c in value] + [('b', value[i:i+2]) for i in range(len(value)-1)])

def search_evidence(payload):
    fields(payload, ['schema_version', 'operation', 'documents', 'catalog'])
    require(type(payload['schema_version']) is int and payload['schema_version'] == 1, 'INVALID_SCHEMA')
    op = payload['operation']; fields(op, ['action', 'query', 'source_ids', 'limit'])
    require(op['action'] == 'search_evidence', 'UNKNOWN_OPERATION')
    require(isinstance(op['query'], str) and bool(op['query'].strip()), 'SEARCH_QUERY_REQUIRED'); text(op['query'], 2000)
    ids = op['source_ids']
    require(type(ids) is list and 1 <= len(ids) <= 16, 'SEARCH_SCOPE_REQUIRED')
    for id in ids: identifier(id)
    require(len(set(ids)) == len(ids), 'DUPLICATE_DOCUMENT')
    require(type(op['limit']) is int and 1 <= op['limit'] <= 20, 'SEARCH_LIMIT_INVALID')
    docs = payload['documents']; catalog = payload['catalog']
    require(type(docs) is list and type(catalog) is list and len(docs) == len(catalog) == len(ids), 'SEARCH_SCOPE_CHANGED')
    require({d['id'] for d in docs} == set(ids) and len({d['id'] for d in docs}) == len(docs), 'SEARCH_SCOPE_CHANGED')
    names = {}
    for row in catalog:
        fields(row, ['id', 'display_name', 'can_select'])
        identifier(row['id']); text(row['display_name'], 120)
        require(type(row['can_select']) is bool and row['id'] not in names, 'INVALID_CATALOG')
        names[row['id']] = row
    require(set(names) == set(ids), 'SEARCH_SCOPE_CHANGED')
    require(sum(len(d['content'].encode('utf8')) for d in docs) <= MAX_INPUT, 'INPUT_LIMIT')
    parsed = [parse_document(d) for d in sorted(docs, key=lambda d: d['id'])]
    corpus = [(d, i, p, terms(p['text'])) for d in parsed for i, p in enumerate(d['paragraphs'])]
    df = Counter(t for _, _, _, counts in corpus for t in counts)
    idf = {t: math.log((1+len(corpus))/(1+n))+1 for t, n in df.items()}
    def vector(counts):
        weights = {t:(1+math.log(n))*idf[t] for t,n in counts.items() if t in idf}
        norm = math.sqrt(sum(x*x for x in weights.values()))
        return {t:w/norm for t,w in weights.items()} if norm else {}
    query = vector(terms(op['query'])); rows=[]
    for d,i,p,counts in corpus:
        v=vector(counts);score=sum(w*v.get(t,0) for t,w in query.items())
        if score <= 0: continue
        ref=reference(d,p); meta=names[ref['doc_id']]
        rows.append({**ref, 'result_id':sha(canonical([ref['doc_id'],ref['hash'],ref['para_id'],p['hash']])),
            'display_name':meta['display_name'], 'can_select':meta['can_select'],
            'paragraph_hash':p['hash'], 'score':score, 'start':p['start'], 'end':p['end'],
            'coordinate':'parsed_body_unicode_codepoint',
            'context':{'before':d['paragraphs'][i-1]['text'] if i else '',
                       'after':d['paragraphs'][i+1]['text'] if i+1<len(d['paragraphs']) else ''}})
    rows.sort(key=lambda r:(-r['score'],r['doc_id'],r['para_id']))
    result={'schema_version':1,'status':'RESULTS' if rows else 'NO_MATCH','algorithm':VERSION,
        'total_matches':len(rows),'results':rows[:op['limit']], 'limit':op['limit'],
        'saved':False,'inference_mode':'explicit','notice':'검색 관련도이며 사실·권리·지침 충족 판정이 아닙니다.'}
    require(len(canonical(result).encode('utf8')) <= 8_000_000,'SEARCH_RESULT_LIMIT')
    return result
