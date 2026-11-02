import {generateKeyPairSync,randomBytes,createHash,sign} from 'node:crypto';
import {isoCBOR} from '@simplewebauthn/server/helpers';
const b64=x=>Buffer.from(x).toString('base64url'),digest=x=>createHash('sha256').update(x).digest();
export class Authenticator {
  constructor(){const pair=generateKeyPairSync('ec',{namedCurve:'prime256v1'});this.privateKey=pair.privateKey;this.pub=pair.publicKey.export({format:'jwk'});this.id=b64(randomBytes(32));this.counter=0;}
  data(options,type,tweaks){return Buffer.from(JSON.stringify({type,challenge:options.challenge,origin:'http://localhost:43871',crossOrigin:false,...tweaks}));}
  authData(flags,rp='localhost'){const count=Buffer.alloc(4);count.writeUInt32BE(this.counter);return Buffer.concat([digest(rp),Buffer.from([flags]),count]);}
  register(options,{client={},flags=0x45,rp}={}){this.user=options.user.id;
    const pub=isoCBOR.encode(new Map([[1,2],[3,-7],[-1,1],[-2,Buffer.from(this.pub.x,'base64url')],[-3,Buffer.from(this.pub.y,'base64url')]]));
    const id=Buffer.from(this.id,'base64url'),len=Buffer.alloc(2);len.writeUInt16BE(id.length);
    const authData=Buffer.concat([this.authData(flags,rp),Buffer.alloc(16),len,id,pub]);
    return {id:this.id,rawId:this.id,type:'public-key',response:{clientDataJSON:b64(this.data(options,'webauthn.create',client)),attestationObject:b64(isoCBOR.encode(new Map([['fmt','none'],['attStmt',new Map()],['authData',authData]]))),transports:['internal']},clientExtensionResults:{}};
  }
  login(options,{client={},flags=0x05,rp,badSignature=false}={}){this.counter++;const data=this.data(options,'webauthn.get',client),ad=this.authData(flags,rp),signature=sign('sha256',Buffer.concat([ad,digest(data)]),this.privateKey);if(badSignature)signature[signature.length-1]^=1;return {id:this.id,rawId:this.id,type:'public-key',response:{clientDataJSON:b64(data),authenticatorData:b64(ad),signature:b64(signature),userHandle:this.user},clientExtensionResults:{}};}
}
