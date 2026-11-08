"""Source-grounded paragraph recovery and balanced extractive outlines."""
import re, math, collections, unicodedata
from pathlib import Path

def norm(value):
    return re.sub(r'\s+',' ',unicodedata.normalize('NFKC',value)).strip()

def recover_pdf_pages(pages):
    layouts=[]
    for page in pages:
        try: text=page.extract_text(extraction_mode='layout') or ''
        except Exception: text=page.extract_text() or ''
        layouts.append(text)
        if sum(map(len,layouts))>150000: raise ValueError('문서 본문이 읽기 한도를 넘습니다.')
    vocabulary={s.strip('.,:;!?()[]“”"') for text in layouts for s in text.split()}
    boundaries=collections.Counter()
    grouped=[]
    for text in layouts:
        groups=[g for g in re.split(r'\n\s*\n',text) if g.strip()]
        grouped.append(groups)
        keys=set()
        for g in groups[:2]+groups[-3:]:
            line=g.strip().splitlines()[0]
            key=norm(re.split(r'\s{3,}',line.strip())[0])
            if len(key)>8: keys.add(key)
        boundaries.update(keys)
    repeated={k for k,n in boundaries.items() if len(layouts)>1 and n>=max(2,math.ceil(len(layouts)*.5))}
    blocks=[]
    for groups in grouped:
        for i,g in enumerate(groups):
            lines=[s.strip() for s in g.splitlines() if s.strip()]
            if not lines: continue
            first=norm(re.split(r'\s{3,}',lines[0])[0])
            if (i<2 or i>=len(groups)-3) and first in repeated:
                # Remove only the matched boundary text, not the whole group.
                # A PDF extractor may join the header and body into one group,
                # including body text in a second column on the same line.
                parts=re.split(r'\s{3,}',lines[0],maxsplit=1)
                lines=([parts[1].strip()] if len(parts)>1 and parts[1].strip() else [])+lines[1:]
                if not lines: continue
            if len(lines)==1 and re.fullmatch(r'(?:page\s*)?\d+\s*(?:/\s*\d+)?',lines[0],re.I): continue
            # Layout line breaks within a paragraph must not become summary units.
            joined=lines[0]
            for line in lines[1:]:
                left=joined.split()[-1] if joined.split() else '';right=line.split()[0] if line.split() else ''
                merged=(left+right).strip('.,:;!?()[]“”"')
                joined+=('' if len(left)>0 and len(right)>0 and merged in vocabulary else ' ')+line
            block=norm(joined)
            if block: blocks.append(block)
    return '\n\n'.join(blocks)

def terms(text):
    return set(re.findall(r'[가-힣A-Za-z0-9]{2,}',text.lower()))

def is_heading(text):
    return 4<=len(text)<=78 and not re.search(r'[.!?。！？]$',text) and len(text.split())<=13 and not re.search(r'@|https?://|\|\s*20\d\d|\d{3,4}[- ]\d{3,4}|[:：]\s*-?\d',text)

def sentence_units(text):
    """Return complete source spans, never character slices presented as summaries."""
    return [s.strip() for s in re.split(r'(?<=[.!?。！？])\s+(?=[가-힣A-Z0-9“"(])',text) if s.strip()]

def select_outline(name,text,request,max_items=9):
    paragraphs=[norm(p.strip(' \t#*•')) for p in re.split(r'\n\s*\n',text) if p.strip()]
    if len(paragraphs)==1:
        paragraphs=[norm(s.strip(' \t#*•')) for s in text.splitlines() if s.strip()]
    stem=Path(name).stem.replace('_',' ')
    current=stem; candidates=[]; seen=set()
    repetitions=collections.Counter(paragraphs)
    for order,p in enumerate(paragraphs):
        if not p or re.fullmatch(r'[\W\d_]+',p): continue
        if re.search(r'\|.*20\d\d[./-]',p) and not re.search(r'[.!?。！？]$',p): continue
        measured=bool(re.search(r'[:：=]\s*-?\d',p))
        record=measured or bool(re.match(r'^(?:상태|결론|결정|위험|이슈|미해결|확인 필요|누락|제약|주의 사항)\s*[:：]',p))
        if not record and is_heading(p): current=p; continue
        if len(p)<22 and not record or re.match(r'^(?:https?://|www\.)',p): continue
        if re.search(r'@',p) and len(p)<100: continue
        if repetitions[p]>2 and not record: continue
        for sentence in sentence_units(p):
            key=norm(sentence).lower()
            if key in seen or len(sentence)<22 and not record: continue
            if len(sentence)>1800: continue
            seen.add(key);candidates.append({'heading':current,'text':sentence,'order':order})
    if not candidates:
        # Short factual records still need to remain usable and attributable.
        for order,p in enumerate(paragraphs):
            if len(p)>=5 and not re.match(r'^(?:https?://|www\.)',p):
                candidates.append({'heading':stem,'text':p,'order':order})
    if not candidates: raise ValueError('요점을 추출할 본문이 부족합니다: '+name)
    frequency=collections.Counter(w for c in candidates for w in terms(c['text']))
    focus=terms(request)-{'자료','파일','내용','문서','요약해줘','요약해서','발표자료','만들어줘','바탕화면','보고서','작성해줘','포함해서','핵심','주요'}
    def score(c):
        ws=terms(c['text']); complete=bool(re.search(r'[.!?。！？]$',c['text']))
        important=bool(re.match(r'^(?:상태|결론|결정|위험|이슈|미해결|확인 필요|누락|제약|주의 사항)\s*[:：]',c['text']))
        return 3*len(ws&focus)+sum(min(3,frequency[w]) for w in ws)/max(1,len(ws))+1.4*complete+min(len(c['text']),170)/170+.5*bool(re.search(r'\d',c['text']))+3*important
    by_heading=collections.OrderedDict()
    for c in candidates: by_heading.setdefault(c['heading'],[]).append(c)
    budget=min(max_items,max(3,len(by_heading),math.ceil(math.sqrt(len(candidates))*1.25)))
    selected=[]
    # Cover source sections before filling with high-scoring repeated themes.
    ranked_groups=sorted(by_heading.values(),key=lambda group:max(map(score,group)),reverse=True)
    for group in ranked_groups[:budget]: selected.append(max(group,key=score))
    used={id(c) for c in selected}
    for c in sorted(candidates,key=score,reverse=True):
        if len(selected)>=budget: break
        if id(c) not in used and sum(s['heading']==c['heading'] for s in selected)<3:
            selected.append(c);used.add(id(c))
    selected.sort(key=lambda c:c['order'])
    intro=[c for c in candidates if re.search(r'소개|개요|요약|overview|about|summary',c['heading'],re.I)]
    if not intro:intro=[c for c in candidates if c['heading']==candidates[0]['heading']]
    lead_candidates=[]
    for c in intro:
        if len(lead_candidates)>=2 or sum(len(x['text']) for x in lead_candidates)+len(c['text'])>300:break
        lead_candidates.append(c)
    if not lead_candidates:lead_candidates=[min(selected,key=lambda c:c['order'])]
    for c in lead_candidates:
        if c not in selected:selected.append(c)
    while len(selected)>budget:
        removable=[c for c in selected if c not in lead_candidates]
        selected.remove(min(removable,key=score))
    selected.sort(key=lambda c:c['order'])
    groups=collections.OrderedDict()
    for c in selected: groups.setdefault(c['heading'],[]).append(c['text'])
    lead_parts=[c['text'] for c in lead_candidates]
    return {'lead':' '.join(lead_parts),'lead_parts':lead_parts,'groups':list(groups.items()),'selected':len(selected),'candidates':len(candidates)}
