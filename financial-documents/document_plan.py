"""Source-grounded plans; no invented conclusions or model calls."""
import re,collections,decimal
from document_shaping import select_outline,norm

def text_blocks(text):
    blocks=[];paragraph=[]
    def flush():
        if paragraph:blocks.append(('paragraph','\n'.join(paragraph)));paragraph.clear()
    for line in text.splitlines():
        heading=re.fullmatch(r'\s*(#{1,6})\s+(.+)',line)
        if not line.strip():flush();continue
        if heading and len(heading[2])<=80:flush();blocks.append(('heading'+str(min(3,len(heading[1]))),heading[2]))
        elif re.match(r'^\s*(?:[-*•]\s+|\d+[.)]\s+)',line):flush();blocks.append(('list',line.strip()))
        else:paragraph.append(line)
    flush();return blocks

def numeric_analysis(docs,request):
    values=collections.OrderedDict();units=collections.defaultdict(set)
    number=r'[+-]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?'
    pattern=re.compile(r'(?:^|[.;]\s*)([가-힣A-Za-z][가-힣A-Za-z0-9 _]{0,30}?)\s*[:=]\s*('+number+r')\s*(억원|만원|시간|kg|km|명|건|원|회|일|개|점|%)(?![가-힣A-Za-z0-9])')
    for index,(_,text) in enumerate(docs,1):
        for line in text.splitlines():
            for match in pattern.finditer(line):
                if len(match[2])>64:raise ValueError('수치의 자릿수가 계산 한도를 넘습니다. 값을 확인하세요.')
                label=norm(match[1]);unit=match[3]
                group=values.setdefault((label,unit),collections.defaultdict(set))
                group[index].add(decimal.Decimal(match[2].replace(',','')));units[label].add(unit)
    rows=[];findings=[];notes=[]
    for (label,unit),group in values.items():
        for index,amounts in group.items():rows.append([label,unit,'['+str(index)+']',', '.join(format(n,'f') for n in sorted(amounts))])
        if len(units[label])>1:
            note=label+'은 자료 간 단위가 달라 직접 비교와 계산을 보류했습니다.'
            if note not in notes:notes.append(note)
            continue
        if any(len(a)>1 for a in group.values()):notes.append(label+'은 한 자료에 여러 값이 있어 기준 확인이 필요합니다.');continue
        missing=[str(i) for i in range(1,len(docs)+1) if i not in group]
        if missing:notes.append(label+'의 값이 없는 자료: '+', '.join('['+i+']' for i in missing)+'. 전체 합계·평균은 계산하지 않았습니다.');continue
        amounts=[next(iter(group[i])) for i in range(1,len(docs)+1)]
        context=decimal.Context(prec=150)
        if len(amounts)>1:
            diff=context.subtract(amounts[-1],amounts[0])
            findings.append(label+': [1] '+format(amounts[0],'f')+unit+', ['+str(len(docs))+'] '+format(amounts[-1],'f')+unit+'. 입력 순서의 마지막 - 처음 = '+format(diff,'f')+('%p' if unit=='%' else unit)+'.')
        if re.search('합계|총합|평균',request):
            if unit=='%':notes.append(label+'의 비율 합계·평균은 산출 기준 확인이 필요해 계산을 보류했습니다.');continue
            total=decimal.Decimal(0)
            for amount in amounts:total=context.add(total,amount)
            if re.search('합계|총합',request):findings.append(label+'의 명시된 값 합계: '+format(total,'f')+unit+'.')
            if '평균' in request:findings.append(label+'의 단순 평균: '+format(context.divide(total,decimal.Decimal(len(amounts))).quantize(decimal.Decimal('0.01'),context=context),'f')+unit+'.')
    return {'rows':rows,'findings':findings,'notes':notes}

def build_plan(op,title,docs,request,body='',change=None):
    report=op in ('summary','compare') and bool(re.search('보고서|리포트',request))
    mode='report' if report else op
    if not title:title={'summary':'자료 요약','compare':'자료 비교','slides':'발표 자료','create':'새 문서','edit':'수정본','convert':'변환본'}[op]
    if report and title in ('자료 요약','자료 비교'):title='자료 종합 보고서'
    if len(title)>180:raise ValueError('문서 제목을 180자 이내로 입력하세요.')
    sections=[];evidence=[];table=None;changes=0;preserve=op in ('edit','convert')
    if op=='create':
        if not body.strip():raise ValueError('작성할 내용을 입력하세요.')
        lines=body.splitlines();display=body
        if lines and re.fullmatch(r'\s*#\s+'+re.escape(title)+r'\s*',lines[0]):display='\n'.join(lines[1:]).lstrip('\n')
        sections=[('',[display])]
    elif preserve:
        if len(docs)!=1:raise ValueError('작업할 문서 하나를 선택하세요.')
        body=docs[0][1]
        if op=='edit':
            if not change or len(change)!=2 or not all(isinstance(x,str) for x in change):raise ValueError('바꿀 문구와 새 문구를 확인하세요.')
            old,new=change
            if not old or old not in body:raise ValueError('바꿀 문구를 원문에서 찾지 못했습니다.')
            changes=body.count(old);body=body.replace(old,new)
        sections=[('',[body])]
    else:
        if not docs or op=='compare' and len(docs)<2:raise ValueError('비교에는 두 자료가 필요합니다.' if op=='compare' else '읽을 자료가 필요합니다.')
        outlines=[]
        for name,text in docs:
            outline=select_outline(name,text,request,max_items=5 if mode=='summary' else 9)
            outlines.append(outline);evidence.append({'name':name,'selected':outline['selected'],'candidates':outline['candidates']})
        if report:sections.append(('자료 범위',[f'[{i}] {name}' for i,(name,_) in enumerate(docs,1)]))
        sections.append(('핵심 요약',[o['lead']+f' [{i}]' for i,o in enumerate(outlines,1)]))
        analysis=numeric_analysis(docs,request)
        tabular=bool(analysis['rows']) and (report or op=='compare')
        def already_tabulated(index,fact):
            if not tabular:return False
            key=re.sub(r'[\s,]','',fact).replace('=',':')
            return any(row[2]==f'[{index}]' and key==re.sub(r'[\s,]','',row[0]+':'+row[3]+row[1]) for row in analysis['rows'])
        for index,outline in enumerate(outlines,1):
            for heading,facts in outline['groups']:
                detail=[s+f' [{index}]' for s in facts if s not in outline['lead_parts'] and not already_tabulated(index,s)]
                if detail:sections.append((f'[{index}] '+heading,detail))
        if analysis['rows'] and (report or op=='compare'):
            rows=analysis['rows'];heading='주요 수치'
            sections.append((heading,[f'{r[0]} ({r[1]}) · {r[2]} {r[3]}' for r in rows]))
            table={'heading':heading,'headers':['항목','단위','자료','값'],'rows':rows}
        if analysis['findings'] and (len(docs)>1 or re.search('합계|총합|평균',request)):sections.append(('확인된 비교 결과',analysis['findings']))
        if analysis['notes']:sections.append(('확인할 사항',analysis['notes']))
        explicit=[]
        for index,(_,text) in enumerate(docs,1):
            for line in text.splitlines():
                if re.match(r'^\s*(?:미해결|확인 필요|누락|제약|주의 사항)\s*[:：]',line):
                    value=norm(line)+f' [{index}]'
                    if value not in explicit:explicit.append(value)
        if explicit:sections.append(('원문에 명시된 확인 사항',explicit))
        if op=='compare' and not analysis['rows']:sections.append(('확인할 사항',['같은 기준의 명시된 수치를 찾지 못해 수치 계산을 보류했습니다.']))
        sections.append(('출처',[f'[{i}] {name}' for i,(name,_) in enumerate(docs,1)]))
    plain=body if preserve or op=='create' else '\n\n'.join((h+'\n' if h else '')+'\n'.join(items) for h,items in sections)
    markdown=plain if preserve or op=='create' else '# '+title+'\n\n'+'\n\n'.join('## '+h+'\n\n'+'\n'.join(items) for h,items in sections)
    return {'title':title,'mode':mode,'sections':sections,'table':table,'evidence':evidence,'plain':plain,'markdown':markdown,'preserve':preserve,'changes':changes}
