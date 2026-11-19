import {createHash,createHmac,createCipheriv,createDecipheriv,createPublicKey,createPrivateKey,generateKeyPairSync,diffieHellman,hkdfSync,randomBytes,timingSafeEqual} from 'node:crypto';

// Also carries JSON/base64 RPC payloads; individual file limits remain at their endpoints.
export const MAX_PLAIN=16*1024*1024, MAX_WIRE=23*1024*1024;
const MAGIC=Buffer.from('DIANA-E2EE-1\n');
const fail=()=>{throw Object.assign(Error('암호화 정보를 확인하지 못했습니다. 기기를 다시 연결하세요.'),{status:409});};
export const digest=b=>createHash('sha256').update(b).digest('hex');
const b64=b=>Buffer.from(b).toString('base64');
const un64=(s,max)=>{if(typeof s!=='string'||s.length>Math.ceil(max/3)*4||!/^[A-Za-z0-9+/]*={0,2}$/.test(s))fail();const b=Buffer.from(s,'base64');if(b.length>max||b64(b)!==s)fail();return b;};
export function publicKey(value){try{const key=createPublicKey({key:un64(value,128),format:'der',type:'spki'});if(key.asymmetricKeyType!=='ec'||key.asymmetricKeyDetails?.namedCurve!=='prime256v1')fail();return key;}catch{fail();}}
export function newIdentity(){const {privateKey,publicKey}=generateKeyPairSync('ec',{namedCurve:'prime256v1'});return{privateKey:b64(privateKey.export({format:'der',type:'pkcs8'})),publicKey:b64(publicKey.export({format:'der',type:'spki'}))};}
export function sharedKey(identity,peer,requestId,phonePublic,pcPublic){
  try{const secret=diffieHellman({privateKey:createPrivateKey({key:un64(identity.privateKey,256),format:'der',type:'pkcs8'}),publicKey:publicKey(peer)});
    return Buffer.from(hkdfSync('sha256',secret,Buffer.from(digest(Buffer.from(requestId+'\n'+phonePublic+'\n'+pcPublic)),'hex'),'DIANA pairing key v1',32));
  }catch{fail();}
}
export const keyId=key=>digest(key);
export const confirmation=(key,id)=>createHmac('sha256',key).update('DIANA pairing confirmation v1\n'+id).digest('hex');
export function acceptKey(identity,reply,requestId){const key=sharedKey(identity,reply?.publicKey,requestId,identity.publicKey,reply?.publicKey);const expected=confirmation(key,requestId);if(typeof reply.confirm!=='string'||reply.confirm.length!==64||!timingSafeEqual(Buffer.from(expected),Buffer.from(reply.confirm)))fail();return key;}
export function offerKey(phonePublic,requestId){publicKey(phonePublic);const identity=newIdentity();const key=sharedKey(identity,phonePublic,requestId,phonePublic,identity.publicKey);return{key:key.toString('hex'),reply:{publicKey:identity.publicKey,confirm:confirmation(key,requestId)}};}
const keyBytes=value=>{const key=Buffer.isBuffer(value)?value:Buffer.from(value||'','hex');if(key.length!==32)fail();return key;};
function crypt(key,iv,bytes,aad,decrypt=false){
  if(iv.length!==12)fail();
  if(decrypt){if(bytes.length<16)fail();const c=createDecipheriv('aes-256-gcm',key,iv,{authTagLength:16});c.setAAD(Buffer.from(aad));c.setAuthTag(bytes.subarray(-16));return Buffer.concat([c.update(bytes.subarray(0,-16)),c.final()]);}
  const c=createCipheriv('aes-256-gcm',key,iv,{authTagLength:16});c.setAAD(Buffer.from(aad));return Buffer.concat([c.update(bytes),c.final(),c.getAuthTag()]);
}
function aad(m){return 'DIANA-E2EE-1\n'+m.direction+'\n'+m.id+'\n'+b64(Buffer.from(m.filename))+'\n'+m.sha256+'\n'+m.bytes;}
function validateMeta(m){if(!m||!['phone-pc','pc-phone'].includes(m.direction)||typeof m.id!=='string'||! /^[A-Za-z0-9_-]{1,128}$/.test(m.id)||typeof m.filename!=='string'||Buffer.byteLength(m.filename)>1000||/[\x00-\x1f]/.test(m.filename)||! /^[a-f0-9]{64}$/.test(m.sha256||'')||!Number.isSafeInteger(m.bytes)||m.bytes<1||m.bytes>MAX_PLAIN)fail();}
export function seal(bytes,keys,{id,filename,direction}){
  bytes=Buffer.from(bytes);const meta={id,filename,direction,sha256:digest(bytes),bytes:bytes.length};validateMeta(meta);
  if(!Array.isArray(keys)||keys.length<1||keys.length>32)fail();
  const secret=randomBytes(32),iv=randomBytes(12),auth=aad(meta),seen=new Set();
  const recipients=keys.map(value=>{const key=keyBytes(value),kid=keyId(key);if(seen.has(kid))fail();seen.add(kid);const n=randomBytes(12);return{kid,iv:b64(n),key:b64(crypt(key,n,secret,auth+'\n'+kid))};});
  return Buffer.concat([MAGIC,Buffer.from(JSON.stringify({v:1,meta,iv:b64(iv),data:b64(crypt(secret,iv,bytes,auth)),recipients}))]);
}
export function inspectEnvelope(bytes){
  if(!Buffer.isBuffer(bytes)||bytes.length>MAX_WIRE||!bytes.subarray(0,MAGIC.length).equals(MAGIC))fail();
  let v;try{v=JSON.parse(bytes.subarray(MAGIC.length));}catch{fail();}validateMeta(v.meta);
  if(v.v!==1||!Array.isArray(v.recipients)||v.recipients.length<1||v.recipients.length>32||un64(v.iv,12).length!==12||un64(v.data,MAX_PLAIN+16).length!==v.meta.bytes+16)fail();
  const seen=new Set();for(const r of v.recipients){if(!/^[a-f0-9]{64}$/.test(r.kid)||seen.has(r.kid)||un64(r.iv,12).length!==12||un64(r.key,48).length!==48)fail();seen.add(r.kid);}
  return v;
}
export function isEnvelope(bytes){return Buffer.isBuffer(bytes)&&bytes.subarray(0,MAGIC.length).equals(MAGIC);}
export function openEnvelope(bytes,keys,expected){
  try{const v=inspectEnvelope(bytes),m=v.meta;for(const [k,value]of Object.entries(expected))if(m[k]!==value)fail();
    const candidates=keys.map(keyBytes),key=candidates.find(k=>v.recipients.some(r=>r.kid===keyId(k)));if(!key)fail();
    const r=v.recipients.find(r=>r.kid===keyId(key)),auth=aad(m),secret=crypt(key,un64(r.iv,12),un64(r.key,48),auth+'\n'+r.kid,true);
    const plain=crypt(secret,un64(v.iv,12),un64(v.data,MAX_PLAIN+16),auth,true);if(plain.length!==m.bytes||digest(plain)!==m.sha256)fail();return plain;
  }catch{fail();}
}
// The relay validates framing, not plaintext. Only the endpoint validates the GCM tag.
export const transferHash=bytes=>isEnvelope(bytes)?inspectEnvelope(bytes).meta.sha256:digest(bytes);
export const transferSize=bytes=>isEnvelope(bytes)?inspectEnvelope(bytes).meta.bytes:bytes.length;
