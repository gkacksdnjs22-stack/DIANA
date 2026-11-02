// Run only by the infrastructure operator in the staging private network.
// Recovery codes must arrive on stdin, never as command-line arguments or env vars.
import {recoverToFile} from './recovery-file.mjs';
import {stageConfig} from './config.mjs';
import {openPostgresStore} from './store.mjs';
import {StagingAdminAuth} from './auth.mjs';
const config=stageConfig(process.env),store=await openPostgresStore(config);
try{
  if(process.argv[2]!=='recover'||!process.argv[3])throw Error();
  let input='';for await(const chunk of process.stdin){input+=chunk;if(input.length>4096)throw Error();}
  const {userId,recoveryCode}=JSON.parse(input),auth=new StagingAdminAuth({store,origin:config.origin,rpID:config.rpID});
  if(typeof userId!=='string'||typeof recoveryCode!=='string')throw Error();
  await recoverToFile(auth,{userId,recoveryCode,outputPath:process.argv[3]});
  console.log('Recovery enrollment ticket written to the requested private file.');
}catch{console.error('Staging recovery denied.');process.exitCode=1;}finally{await store.close();}
