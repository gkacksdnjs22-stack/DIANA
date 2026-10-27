import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, cp, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { verifiedPython } from '../financial-documents/python.mjs';

export async function initDemo(python) {
  python=await verifiedPython(python);
  const root=path.resolve('.local','financial-mobile-demo-'+randomUUID());await mkdir(root,{recursive:true,mode:0o700});
  const input=path.join(root,'input'),output=path.join(root,'output'),generic=path.join(root,'generic');
  await cp(path.resolve('financial-documents/fixtures/fund-a'),input,{recursive:true});await mkdir(output);await mkdir(generic);
  const coreConfig=path.join(root,'core.json'),workerConfig=path.join(root,'worker.json');
  const core={schema_version:1,principal:'local-demo-user',role:'analyst',readRoots:[input],outputRoot:output,python,write_roles:['analyst'],approval_ttl_ms:300_000,
    documents:[['REVIEW_A','review.md'],['DD_A','due-diligence.txt'],['PE-02','guideline.json']].map(([id,relativePath])=>({id,relativePath,rootIndex:0,version:'1',classification:'synthetic',read_roles:['analyst']}))};
  const tasks=[['가상 실사 검토',['checklist_review'],[]],['가상 검토서 보완',['patch'],['KEY_MAN']],['가상 문서 변환',['convert'],[]]].map(([label,actions,item_ids])=>({id:randomUUID(),label,actions,formats:['md','txt','json'],target_doc:'REVIEW_A',source_ids:['DD_A'],guideline_id:'PE-02',item_ids}));
  await writeFile(coreConfig,JSON.stringify(core,null,2),{flag:'wx',mode:0o600});
  await writeFile(workerConfig,JSON.stringify({schema_version:1,coreConfig,stateDir:path.join(root,'worker-state'),tasks},null,2),{flag:'wx',mode:0o600});
  return {root,workerConfig,generic};
}
if(process.argv[1]&&import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
  const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--python'){console.error('Usage: node scripts/init-financial-mobile-demo.mjs --python ABSOLUTE_PYTHON_PATH');process.exitCode=1;}
  else initDemo(args[1]).then(r=>console.log(JSON.stringify(r,null,2))).catch(()=>{console.error('FINANCIAL_DEMO_INIT_FAILED');process.exitCode=1;});
}
