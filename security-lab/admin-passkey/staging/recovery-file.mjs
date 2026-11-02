import {open,unlink} from 'node:fs/promises';
import {resolve} from 'node:path';

export async function recoverToFile(auth,{userId,recoveryCode,outputPath},{openFile=open,removeFile=unlink}={}){
  // Reserve exclusively before consuming a recovery code. Never replace an existing file.
  const filename=resolve(outputPath),file=await openFile(filename,'wx',0o600);
  let closed=false;
  try{
    return await auth.tx(async()=>{
      const result=await auth.recoverOffline(userId,recoveryCode);
      await file.writeFile(JSON.stringify(result),'utf8');
      await file.sync();
      await file.close();closed=true;
      await auth.audit('operator/recover',true);
      return result;
    });
  }catch(error){
    if(!closed)await file.close().catch(()=>{});
    // Only this invocation's exclusively created output is removed on failure.
    await removeFile(filename).catch(()=>{});
    throw error;
  }
}
