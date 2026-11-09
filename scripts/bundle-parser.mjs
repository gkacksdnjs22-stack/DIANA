import path from 'node:path';
import {createRequire} from 'node:module';
import {mkdir,readFile,writeFile,readdir,copyFile,lstat} from 'node:fs/promises';
const require=createRequire(import.meta.url);

// Package the offline reader and its document dependencies only. The CLI and servers
// are not entry points in the desktop application.
export async function bundleParser(root){
 const bundled=new Map();
 async function install(name,parentRequire){
  let entry;try{entry=parentRequire.resolve(name+'/package.json');}catch{entry=parentRequire.resolve(name);}let source=path.dirname(entry),meta;
  for(;;){
   try{meta=JSON.parse(await readFile(path.join(source,'package.json'),'utf8'));if(meta.name===name)break;}catch(e){if(e.code!=='ENOENT')throw e;}
   if(path.dirname(source)===source)throw Error('PARSER_PACKAGE_NOT_FOUND '+name);source=path.dirname(source);
  }
  if(bundled.has(name)){if(bundled.get(name)!==meta.version)throw Error('PARSER_PACKAGE_CONFLICT');return;}
  bundled.set(name,meta.version);
  const dest=path.join(root,'app/node_modules',name);
  async function copy(rel){
   const dir=path.join(source,rel);await mkdir(path.join(dest,rel),{recursive:true});
   for(const item of await readdir(dir,{withFileTypes:true})){
    const file=path.join(rel,item.name);
    if(item.name.startsWith('.')||/^(?:node_modules|test|tests|bench|examples|coverage|cli|bin|docs)$/i.test(item.name))continue;
    if(item.isSymbolicLink())throw Error('PARSER_LINK');
    if(name==='kordoc'&&!rel&&item.isDirectory()&&!['dist','THIRD_PARTY'].includes(item.name))continue;
    if(item.isDirectory()){await copy(file);continue;}
    if(item.isFile()&&(/\.(?:js|mjs|cjs|json)$/i.test(file)||/license|notice|copying/i.test(file)))await copyFile(path.join(source,file),path.join(dest,file));
   }
  }
  await copy('');
  const deps=name==='kordoc'?['jszip','cfb','@xmldom/xmldom','markdown-it']:Object.keys(meta.dependencies||{});
  const resolveFrom=createRequire(path.join(source,'package.json'));
  for(const dep of deps)await install(dep,resolveFrom);
 }
 await install('kordoc',require);
 await writeFile(path.join(root,'LICENSES/parser-packages.json'),JSON.stringify(Object.fromEntries(bundled),null,2));
}

