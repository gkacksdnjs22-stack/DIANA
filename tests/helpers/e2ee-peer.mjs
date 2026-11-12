import {offerKey,seal,openEnvelope} from '../../lib/e2ee.mjs';
let input='';for await(const chunk of process.stdin)input+=chunk;
const b=JSON.parse(input);let result;
if(b.op==='offer')result=offerKey(b.publicKey,b.id);
else if(b.op==='open')result={plain:openEnvelope(Buffer.from(b.wire,'base64'),[b.key],b.meta).toString('base64')};
else if(b.op==='seal')result={wire:seal(Buffer.from(b.plain,'base64'),[b.key],b.meta).toString('base64')};
else throw Error('Unknown test operation');
process.stdout.write(JSON.stringify(result));
