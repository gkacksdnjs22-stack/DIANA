import {newIdentity,offerKey} from '../../lib/e2ee.mjs';
import assert from 'node:assert/strict';
import {randomUUID,randomBytes} from 'node:crypto';

export function pairRequest(body){
  body.publicKey??=newIdentity().publicKey;body.requestId??=randomUUID();body.pairKey??=randomBytes(32).toString('hex');return body;
}
export const approvedRequest=(request,options,agentToken)=>approvedPhone(request,options.body,agentToken);
export async function approvedPhone(request,body,agentToken='a'.repeat(40)){
  pairRequest(body);
  const options={method:'POST',token:'',body};
  const waiting=await request('/api/phone/pair',options);
  if(waiting.status!==202)return waiting;
  assert.equal(waiting.data.phoneToken,undefined);
  const pending=await request('/api/agent/pair-pending',{token:agentToken});
  assert.equal(pending.status,200);
  const decision=await request('/api/agent/pair-approve',{method:'POST',token:agentToken,body:{id:pending.data.pending.id,approve:true,e2ee:offerKey(pending.data.pending.publicKey,pending.data.pending.requestId).reply}});
  assert.equal(decision.status,200);
  return request('/api/phone/pair',options);
}
