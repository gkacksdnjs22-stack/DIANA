import path from 'node:path';
import {lstat,realpath,opendir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {checkedDirectory} from '../personal-ai/documents/files.mjs';
import {allowedPart} from '../local-ai/files.mjs';

const privatePart=/(?:^|[\\/])(?:\.[^\\/]+|AppData|ProgramData|Program Files(?: \(x86\))?|Windows|System Volume Information|Recovery|node_modules|credentials?|secrets?|vault|암호|인증정보)(?:[\\/]|$)/i;
const secretName=/(?:password|credential|secret|private.?key|access.?token|암호|비밀번호|인증키|\.(?:pem|p12|pfx|kdbx|key)$)/i;
export const within=(parent,child)=>{const r=path.relative(parent,child);return !r||(!r.startsWith('..'+path.sep)&&r!=='..'&&!path.isAbsolute(r));};
export async function safeRoot(p){
 if(!path.isAbsolute(p)||path.resolve(p)!==p||path.parse(p).root===p||privatePart.test(p)||p.startsWith('\\\\')||p.toLowerCase()===process.env.USERPROFILE?.toLowerCase())throw Error('허용할 수 없는 폴더입니다.');
 return checkedDirectory(p);
}
export function scope(roots,request){
 const absolute=request.match(/^(?:["“]([a-z]:[\\/][^"”]+)["”]|([a-z]:[\\/][^\s]+?))\s*(?:폴더)?(?:에서|의)\s*/iu);
 if(absolute){
  const dir=path.resolve(absolute[1]||absolute[2]),owner=roots.find(r=>within(r.path,dir));
  if(!owner||privatePart.test(dir))throw Error('지정한 위치가 검색 허용 범위 밖입니다.');
  return {roots:[{...owner,path:dir}],query:request.slice(absolute[0].length),named:true};
 }
 if(/[a-z]:[\\/]|\\\\/iu.test(request))throw Error('검색 설정에 있는 폴더 이름이나 허용된 폴더 경로를 지정하세요.');
 const labels=[...new Set([...roots.map(r=>r.label),'바탕화면','문서','다운로드'])].filter(Boolean).sort((a,b)=>b.length-a.length);
 let selected=roots,query=request,named=false;
 for(const label of labels){
  const escaped=label.replace(/[.*+?^$(){}|[\]\\]/g,'\\$&');
  const loc=new RegExp('(?:^|\\s)'+escaped+'\\s*(?:폴더\\s*|위치\\s*)?(?:에서|안의|안에|에\\s*있는|의(?=\\s))','u').exec(request);
  if(!loc)continue;
  // A non-leading "document's contents" is a source description, not a folder.
  if(loc.index>0&&/의$/u.test(loc[0])&&!/폴더|위치/u.test(loc[0]))continue;
  selected=roots.filter(r=>r.label===label);if(!selected.length)throw Error('지정한 위치가 검색 설정에서 제외되었거나 사용할 수 없습니다.');
  named=true;query=request.replace(loc[0],' ').trim();break;
 }
 const nested=query.match(/^(?:["“]([^"”]+)["”]|([^\\/:"<>|*?]+?))\s+폴더\s*(?:에서|의|안의)\s*/u);
 if(nested){const folder=(nested[1]||nested[2]).trim();if(!allowedPart(folder)||secretName.test(folder)||folder.includes(path.sep))throw Error('허용할 수 없는 검색 위치입니다.');
  return {roots:selected,query:query.slice(nested[0].length),named:true,folder};
 }
 return {roots:selected,query,named};
}
export async function discover(roots,excluded,request='',options={}){
 const target=scope(roots,request),locations=target.roots;
 if(!locations.length)throw Error('검색 위치가 없습니다. 설정에서 폴더를 추가하세요.');
 const files=[],seen=new Set(),queue=locations.map(r=>({...r,depth:0}));
 const blocked=p=>privatePart.test(p)||excluded.some(x=>within(x,p));
 let count=0,denied=false,deep=false,foundFolder=false;
 for(let i=0;i<queue.length;i++){
  const r=queue[i],dir=r.path,key=dir.toLowerCase();
  if(seen.has(key)||blocked(dir))continue;
  seen.add(key);
  const inside=!target.folder||r.inside||path.basename(dir).toLowerCase()===target.folder.toLowerCase();if(inside)foundFolder=true;
  try{
   await safeRoot(dir);
   for await(const e of await opendir(dir)){
    options.signal?.throwIfAborted();
    if(++count>(options.limit??6000))throw Error('검색 항목 수 한도에 도달했습니다. 더 좁은 폴더를 지정하세요.');
    const p=path.join(dir,e.name);
    if(e.isSymbolicLink()||!allowedPart(e.name)||secretName.test(e.name)||blocked(p)||e.name.startsWith('~'))continue;
    if(e.isDirectory()){if(r.depth>=(options.depth??8))deep=true;else queue.push({path:p,label:r.label,depth:r.depth+1,inside});continue;}
    if(!inside||!e.isFile())continue;
    const st=await lstat(p,{bigint:true});
    if(!st.isFile()||st.nlink!==1n||await realpath(p)!==p)continue;
    files.push({id:createHash('sha256').update(p).digest('hex'),path:p,location:dir,label:r.label,name:e.name,mtime:Number(st.mtimeNs/1000000n),stamp:[st.dev,st.ino,st.size,st.mtimeNs].join('-')});
   }
  }catch(e){if(['EPERM','EACCES'].includes(e.code)){denied=true;continue;}if(e.code==='ENOENT')throw Error('검색 중 파일이나 위치가 사라졌습니다. 다시 시도하세요.');throw e;}
 }
 if(denied)throw Error('읽기 권한이 없는 위치가 있어 검색을 끝내지 못했습니다. 검색 위치를 좁혀 주세요.');
 if(deep)throw Error('하위 폴더 깊이 한도에 도달했습니다. 더 좁은 폴더를 지정하세요.');
 if(target.folder&&!foundFolder)throw Error('지정한 하위 폴더를 허용한 위치에서 찾지 못했습니다.');
 return files;
}
const compact=s=>s.normalize('NFKC').toLowerCase().replace(/[\s_.’'"“”-]/gu,'');
const generic=/^(?:(?:이|그|해당|첨부한|선택한|모든|전체|여러|두|최근|최신)\s*)?(?:자료|파일|문서)(?:들)?$/u;
function sourceName(term){
 // Work on the still-masked name: quoted/file-name words cannot be stripped here.
 return term.trim()
  .replace(/\s+(?:(?:두|여러|해당|각|각각의)\s+)?(?:파일|문서|자료)(?:들)?(?:의)?(?:\s+(?:(?:전체|주요|핵심)\s+)?(?:내용|본문))?$/u,'')
  .replace(/\s+(?:의\s+)?(?:(?:전체|주요|핵심)\s+)?(?:내용|본문)$/u,'')
  .replace(/^["“]|["”]$/gu,'').trim();
}
export function sourceQuery(text){
 // Protect file names before looking for operation verbs inside the surrounding request.
 const literals=[];
 const masked=text.replace(/["“]([^"”]+\.[a-z0-9]{1,12})["”]|([^\s"'“”,]+\.[a-z0-9]{1,12})(?=\s|[,，]|$|을|를|랑|이랑|와|과)/giu,(_,quoted,bare)=>{
  literals.push(quoted||bare);return '\u0001'+(literals.length-1)+'\u0002';
 });
 let source=masked.split(/\s*(?:(?:요약|비교|종합)(?=해|하|한|할|해서|하여|$)|읽고|읽어|읽어서|보고(?=\s|$)|찾아|찾기|정리해|정리한|변환해|바꿔|수정해|검토해)/u)[0].trim();
 source=source.replace(/^(?:첨부한|첨부된|선택한)\s+/u,'').replace(/\s+(?:TXT|MD|JSON|PPTX?|DOCX|텍스트|마크다운)(?:로|으로).*$/iu,'');
 const content=source.match(/(?:["“]([^"”]+)["”]|([가-힣A-Za-z0-9_-]+?))(?:이|가|을|를)?\s*(?:들어간|포함된|언급된|담긴)/u);
 if(content)source=source.replace(content[0],'');
 const now=new Date();let start=-Infinity,end=Infinity;
 const date=source.match(/(\d{4}-\d{2}-\d{2})\s*(?:부터|[~～–])\s*(\d{4}-\d{2}-\d{2})(?:까지)?/u);
 const days=source.match(/최근\s*(\d{1,4})\s*일(?:간|의)?/u);
 const month=source.match(/이번\s*달|지난\s*달|(\d{4})년\s*(\d{1,2})월/u);
 if(date){start=new Date(date[1]+'T00:00:00').getTime();end=new Date(date[2]+'T23:59:59.999').getTime();if(!(end>=start))throw Error('검색 날짜 범위를 확인하세요.');source=source.replace(date[0],'');}
 else if(days){start=now.getTime()-Number(days[1])*86400000;end=now.getTime();source=source.replace(days[0],'');}
 else if(month){const y=Number(month[1]||now.getFullYear()),m=month[2]?Number(month[2])-1:now.getMonth()-Number(month[0].includes('지난'));start=+new Date(y,m,1);end=+new Date(y,m+1,1)-1;source=source.replace(month[0],'');}
 const latest=/(?:가장\s*)?(?:최근|최신)/u.test(source);
 source=source.replace(/(?:가장\s*)?(?:최근|최신)(?:에|의)?\s*(?:받은|수정한|작성한)?/gu,'').trim();
 const quarters=source.match(/([1-4])\s*(?:분기)?\s*(?:[~～–-]|부터)\s*([1-4])\s*분기(?:까지)?/u);
 if(quarters)source=source.replace(quarters[0],'').trim();
 const raw=source.split(/(?:이랑|랑|하고|와|과)(?=\s)(?!\s+(?:파일|문서|자료)(?:들)?(?:의|을|를)?(?:\s|$))|\s+(?:및|그리고)\s+|[,，]/u).map(t=>t.trim().replace(/^(?:모든|전체|여러)\s+/u,'').replace(/(?:을|를)$/u,'').trim()).filter(Boolean);
 const unmask=t=>t.replace(/\u0001(\d+)\u0002/g,(_,i)=>literals[Number(i)]);
 return {terms:raw.map(t=>unmask(sourceName(t))),rawTerms:raw.map(t=>unmask(t.replace(/^["“]|["”]$/gu,''))),content:content?.[1]||content?.[2],latest,start,end,quarters};
}
export function groupsFor(files,q,all=false){
 const dated=files.filter(f=>q.start===-Infinity&&q.end===Infinity||f.mtime>=q.start&&f.mtime<=q.end);
 const groups=[];
 function add(term,pool,quarter,rawTerm=term){
  const literal=term.trim(),needle=compact(literal),broad=!needle||generic.test(literal);
  const stem=f=>compact(path.parse(f.name).name);
  const rawNeedle=compact(rawTerm);
  const exact=pool.filter(f=>compact(f.name)===rawNeedle||stem(f)===rawNeedle);
  const core=compact(literal.replace(/\s+(?:자료|파일|문서)$/u,''));
  let hits=broad?pool:exact.length&&!q.latest?exact:pool.filter(f=>stem(f).includes(needle)||core&&stem(f).includes(core)||rawNeedle&&stem(f).includes(rawNeedle)||compact(f.name)===needle);
  if(!hits.length&&rawNeedle!==needle&&/의$/u.test(literal)){
   const possessive=literal.slice(0,-1),part=compact(possessive);
   hits=generic.test(possessive)?pool:pool.filter(f=>stem(f).includes(part));
  }
  if(/\.[a-z0-9]{1,8}$/i.test(literal))hits=pool.filter(f=>compact(f.name)===needle);
  if(!hits.length)throw Error((quarter||literal||'요청한')+' 자료를 검색 위치에서 찾지 못했습니다.');
  groups.push({label:[quarter,literal].filter(Boolean).join(' ')||'자료',hits,all});
 }
 const terms=q.terms.length?q.terms:[''];
 if(q.quarters){const first=Number(q.quarters[1]),last=Number(q.quarters[2]);if(first>last)throw Error('분기 순서를 확인하세요.');for(let n=first;n<=last;n++)for(const [i,t] of terms.entries())add(t,dated.filter(f=>new RegExp('(?:^|[^0-9])'+n+'\\s*분기|(?:^|[^a-z0-9])q'+n+'(?![0-9])','i').test(f.name)),n+'분기',q.rawTerms?.[i]??t);}
 else for(const [i,term] of terms.entries())add(term,dated,undefined,q.rawTerms?.[i]??term);
 return groups;
}
