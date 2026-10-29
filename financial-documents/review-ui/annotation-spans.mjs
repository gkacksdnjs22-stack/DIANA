// UTF-16 offsets always refer to the unchanged request. Matching proposes spans only.
export const normalizeMention=s=>s.normalize('NFKC').trim().replace(/\s+/gu,' ').toLowerCase();
export function mentionSpans(text,names){
 const units=[],starts=[],ends=[];let offset=0;
 for(const ch of text){const end=offset+ch.length;for(const c of ch.normalize('NFKC').toLowerCase()){if(/\s/u.test(c)){if(units.at(-1)===' ')ends[ends.length-1]=end;else{units.push(' ');starts.push(offset);ends.push(end);}}else{for(let j=0;j<c.length;j++){units.push(c[j]);starts.push(offset);ends.push(end);}}}offset=end;}
 const normalized=units.join(''),found=new Map();for(const name of names){const key=normalizeMention(name);if(!key)continue;let pos=normalized.indexOf(key);while(pos>=0){const a=starts[pos],b=ends[pos+key.length-1];if(normalizeMention(text.slice(a,b))===key)found.set(a+':'+b,{start:a,end:b});pos=normalized.indexOf(key,pos+1);}}
 return [...found.values()].sort((a,b)=>a.start-b.start||a.end-b.end);
}
export function validSpan(text,s){const bounds=new Set([0]);let n=0;for(const c of text){n+=c.length;bounds.add(n);}return !!s&&Number.isInteger(s.start)&&Number.isInteger(s.end)&&s.end>s.start&&bounds.has(s.start)&&bounds.has(s.end);}
