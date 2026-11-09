import {keys,fail,validId} from './strict-json.mjs';
export function conversionOperation(x){
 keys(x,['action','document','format']);keys(x.document,['kind','id']);
 if(x.action!=='convert_common'||!['registered','saved'].includes(x.document.kind)||!validId(x.document.id)||!['md','txt','json'].includes(x.format))fail('INVALID_CONVERSION');
 return structuredClone(x);
}
