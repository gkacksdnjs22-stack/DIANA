"""Lossless common-document conversion. No review, model, or file authority."""
from .schemas import fields, require, document, identifier, text, canonical, sha
from .deterministic_tools import deserialize, serialize


def plan_conversion(p):
    fields(p, ['schema_version','request_id','operation','document','authority'])
    require(type(p['schema_version']) is int and p['schema_version']==1,'INVALID_SCHEMA')
    identifier(p['request_id']);op=p['operation']
    fields(op,['action','format']);require(op['action']=='convert_common','INVALID_CONVERSION')
    require(op['format'] in ('md','txt','json'),'UNSUPPORTED_FORMAT')
    d=document(p['document']);a=p['authority']
    fields(a,['principal','role','policy_hash','output_root'])
    for k in a:text(a[k],2000)
    common=deserialize(d['content'],d['format'])
    require(common['classification']==d['classification'],'CLASSIFICATION_MISMATCH','BLOCKED')
    same=op['format']==d['format']
    output=d['content'] if same else serialize(common,op['format'])
    require(deserialize(output,op['format'])==common,'CONVERSION_NOT_LOSSLESS','FAILED')
    approval={'schema_version':1,'request_id':p['request_id'],'operation':op,'authority':a,
              'bindings':{'document':{k:d[k] for k in ('id','version','hash','format','classification')}},
              'common_document':common,'output_content':output,'output_hash':sha(output)}
    raw=canonical(approval);h=sha(raw)
    return {'schema_version':1,'request_id':p['request_id'],'status':'READY' if same else 'AWAITING_APPROVAL',
            'reason':'SAME_FORMAT' if same else 'LOSSLESS_CONVERSION','no_change':same,'saved':False,
            'review_complete':False,'all_items_addressed':not common['unresolved'],
            'plan_id':'plan-'+h,'plan_hash':h,'canonical_payload':raw,'approval_payload':approval,
            'common_document':common,'expected_body':common['body'],'unresolved':common['unresolved'],
            'output_content':output,'input_format':d['format'],'output_format':op['format'],
            'inference_mode':'explicit_conversion'}
