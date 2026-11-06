"""Bounded, offline document extraction, comparison and Office output. JSON pipe only."""
import sys, os, io, json, re, base64, hashlib, zipfile, collections, decimal, tempfile, subprocess
from xml.etree import ElementTree as ET
from pathlib import Path
lib=Path(sys.executable).resolve().parents[1]/'office'
if lib.is_dir(): sys.path.insert(0,str(lib))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from document_shaping import recover_pdf_pages, select_outline
def fail(msg): raise ValueError(msg)
def partname(tag): return tag.rsplit('}',1)[-1]
def paragraphs(xml):
    if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper(): fail('내용을 안전하게 읽을 수 없습니다.')
    root=ET.fromstring(xml)
    return [''.join((t.text or '') for t in p.iter() if partname(t.tag)=='t').strip() for p in root.iter() if partname(p.tag)=='p']
def extract(raw,ext):
    if ext in ('txt','md','json','csv','tsv'):
        text=raw.decode('utf-8-sig')
        if ext=='json':
            obj=json.loads(text)
            def walk(o,p=''):
                if isinstance(o,dict):
                    for k,v in o.items(): yield from walk(v,(p+' '+k).strip())
                elif isinstance(o,list):
                    for v in o: yield from walk(v,p)
                elif o is not None: yield p+': '+str(o)
            text='\n'.join(walk(obj))
    elif ext=='pdf':
        from pypdf import PdfReader
        try:
            pdf=PdfReader(io.BytesIO(raw))
            if pdf.is_encrypted: fail('암호가 있는 파일은 읽을 수 없습니다.')
            if len(pdf.pages)>120: fail('문서 쪽수 한도를 넘습니다.')
            parts=[]
            for page in pdf.pages:
                parts.append(page.extract_text() or '')
                if sum(map(len,parts))>150000: fail('문서 본문이 읽기 한도를 넘습니다.')
            text=recover_pdf_pages(pdf.pages)
        except ValueError: raise
        except Exception: fail('파일을 찾았으나 PDF 본문을 읽지 못했습니다.')
    elif ext in ('docx','pptx'):
        with zipfile.ZipFile(io.BytesIO(raw)) as z:
            info=z.infolist()
            if len(info)>1500 or sum(i.file_size for i in info)>32_000_000: fail('압축 문서가 읽기 한도를 넘습니다.')
            names=['word/document.xml'] if ext=='docx' else sorted((n for n in z.namelist() if re.fullmatch(r'ppt/slides/slide\d+\.xml',n)),key=lambda n:int(re.search(r'(\d+)\.xml',n)[1]))
            text='\n'.join(s for n in names for s in paragraphs(z.read(n)) if s)
    else: fail('읽을 수 없는 파일 형식입니다.')
    if len(text)>150000: fail('문서 본문이 읽기 한도를 넘습니다.')
    if not text.strip() or not re.search(r'\w',text) or re.search('[\x00-\x08\x0b\x0c\x0e-\x1f]',text): fail('읽을 수 있는 본문이 없습니다. 이미지 문서는 지원하지 않습니다.')
    return text.strip()
def words(s): return set(re.findall(r'[가-힣A-Za-z0-9]{2,}',s.lower()))
def process(req):
    op=req['kind']; fmt=req['format']; docs=[]
    for f in req.get('docs',[]):
        docs.append((f['name'],f['decoded'] if 'decoded' in f else extract(base64.b64decode(f['data'],validate=True),f['name'].rsplit('.',1)[-1].lower())))
    title=req.get('title') or {'summary':'자료 요약','compare':'자료 비교와 종합','slides':'발표 자료','create':'새 문서','edit':'수정본','convert':'변환본'}[op]
    sections=[]; evidence=[]
    if op=='create':
        if not req.get('body','').strip():fail('작성할 내용을 입력하세요.')
        sections=[(title,[req['body'].strip()])]
    elif op in ('edit','convert'):
        if len(docs)!=1:fail('작업할 문서 하나를 선택하세요.')
        body=docs[0][1]
        if op=='edit':
            a,b=req['change']
            if not a or a not in body:fail('바꿀 문구를 원문에서 찾지 못했습니다.')
            body=body.replace(a,b)
        sections=[(title,[body])]
    else:
        if not docs or op=='compare' and len(docs)<2:fail('비교에는 두 자료가 필요합니다.' if op=='compare' else '읽을 자료가 필요합니다.')
        sourcefacts=[]; measures=collections.defaultdict(lambda:collections.defaultdict(set)); focus=words(req['request']);tokens=[]
        for idx,(name,txt) in enumerate(docs,1):
            outline=select_outline(name,txt,req['request'])
            lines=[v.strip() for v in txt.splitlines() if v.strip()]
            facts=[v for _,items in outline['groups'] for v in items]
            sourcefacts.append((name,outline));tokens.append(words(txt))
            evidence.append({'name':name,'selected':outline['selected'],'candidates':outline['candidates']})
            for line in lines:
                for m in re.finditer(r'(?:^|[.;]\s*)([가-힣A-Za-z][가-힣A-Za-z0-9 _]{0,30}?)\s*[:=]\s*(-?\d+(?:\.\d+)?)\s*(%|명|건|원|만원|억원|회|일|시간|개|점|kg|km)(?![가-힣A-Za-z])',line):
                    measures[(m[1].strip(),m[3])][idx].add(decimal.Decimal(m[2]))
        compare=[]
        if len(docs)>1:
            for (label,unit),vs in list(measures.items())[:18]:
                if len(vs)<len(docs):compare.append(label+' · 값 미기재: '+', '.join(n for i,(n,_) in enumerate(docs,1) if i not in vs))
                if any(len(a)>1 for a in vs.values()):compare.append(label+' · 한 자료에 서로 다른 값이 있어 계산 보류');continue
                if len(vs)==len(docs) and unit!='%' and re.search('합계|총합|평균',req['request']):
                    values=[next(iter(v)) for v in vs.values()];total=sum(values)
                    if re.search('합계|총합',req['request']):compare.append(f'{label} · 명시된 값의 합계: {total}{unit}')
                    if '평균' in req['request']:compare.append(f'{label} · 단순 평균: {(total/len(values)).quantize(decimal.Decimal("0.01"))}{unit}')
                if len(vs)>1:
                    a=min(vs);b=max(vs);x=next(iter(vs[a]));y=next(iter(vs[b]))
                    compare.append(f'{label}: [{a}] {x}{unit}, [{b}] {y}{unit}. '+('값 일치' if x==y else f'값 차이 확인 필요 · [{b}] - [{a}] = {y-x}'+('%p' if unit=='%' else unit)))
            if not compare and op=='compare':compare=['두 자료에서 같은 기준의 비교값을 확인하지 못했습니다.']
        if compare:sections.append(('자료 사이 비교',compare))
        leads=[outline['lead']+f' [{i}]' for i,(_,outline) in enumerate(sourcefacts,1)]
        sections.insert(0,('핵심 요약',leads))
        for i,(n,outline) in enumerate(sourcefacts,1):
            for heading,facts in outline['groups']:
                rest=[fact+f' [{i}]' for fact in facts if fact not in outline['lead_parts']]
                if rest:sections.append((heading,rest))
    plain='\n\n'.join(h+'\n'+'\n'.join(ls) for h,ls in sections)
    if op in ('edit','convert'):plain=sections[0][1][0]
    md=plain if op in ('edit','convert') else '# '+title+'\n\n'+'\n\n'.join('## '+h+'\n\n'+'\n'.join(ls) for h,ls in sections)
    if op not in ('edit','convert') and docs:
        references='\n'.join(f'[{i}] {name}' for i,(name,_) in enumerate(docs,1))
        plain+='\n\n출처\n'+references
        md+='\n\n## 출처\n\n'+references
    if fmt in ('txt','md','json'):raw=(json.dumps({'title':title,'body':plain,'sources':[x[0] for x in docs]},ensure_ascii=False,indent=2) if fmt=='json' else md if fmt=='md' else plain).encode()
    elif fmt=='pdf':
        from pdf_theme import render_pdf
        raw=render_pdf(title,sections,docs,slides=op=='slides')
        if not raw.startswith(b'%PDF-') or not extract(raw,'pdf'):fail('PDF 결과를 다시 읽지 못했습니다.')
    elif fmt in ('pptx','ppt'):
        from pptx import Presentation
        from pptx.util import Inches,Pt
        from pptx.dml.color import RGBColor
        pres=Presentation();pres.slide_width=Inches(13.33);pres.slide_height=Inches(7.5)
        for h,ls in sections:
            chunks=[]
            for line in ls:
                for j in range(0,len(line),110):chunks.append(line[j:j+110])
            for pos in range(0,len(chunks),3):
                sl=pres.slides.add_slide(pres.slide_layouts[6]);bg=sl.background.fill;bg.solid();bg.fore_color.rgb=RGBColor.from_string('102336')
                def box(x,y,w,ht,txt,size,col):
                    tf=sl.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(ht)).text_frame;tf.word_wrap=True;p=tf.paragraphs[0];r=p.add_run();r.text=txt;r.font.name='맑은 고딕';r.font.size=Pt(size);r.font.color.rgb=RGBColor.from_string(col)
                box(.65,.35,12,.5,title[:65],16,'69D8C7');box(.65,1,12,1,h[:65],29,'FFFFFF')
                for j,line in enumerate(chunks[pos:pos+3]):box(.7,2.05+1.6*j,12,1.56,line,19,'E2E9EF')
        stream=io.BytesIO();pres.save(stream);raw=stream.getvalue()
        if fmt=='ppt':
            tool=Path(sys.executable).resolve().parents[1]/'native'/'DIANA-PresentationExport.exe'
            if not tool.is_file():fail('PPT 변환 도구가 없습니다. 최신 앱 폴더 전체를 다시 풀어 실행하세요.')
            with tempfile.TemporaryDirectory(prefix='diana-presentation-') as folder:
                source=Path(folder)/'source.pptx';target=Path(folder)/'result.ppt';source.write_bytes(raw)
                try:
                    proc=subprocess.run([str(tool),str(source),str(target)],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=28,creationflags=getattr(subprocess,'CREATE_NO_WINDOW',0))
                    result=json.loads(proc.stdout.decode('utf-8-sig'))
                except subprocess.TimeoutExpired:fail('PPT 변환 시간이 초과되었습니다. PowerPoint 초기 설정을 확인하거나 PDF를 사용하세요.')
                except Exception:fail('PPT 변환 응답을 확인하지 못했습니다.')
                if not result.get('ok'):fail(result.get('error','PPT 변환을 마치지 못했습니다.'))
                raw=target.read_bytes()
                if not raw.startswith(bytes.fromhex('d0cf11e0a1b11ae1')):fail('올바른 PPT 파일이 아닙니다.')
    elif fmt=='docx':
        from docx import Document
        d=Document();d.add_heading(title,0)
        for h,ls in sections:
            if h!=title:d.add_heading(h,1)
            for l in ls:d.add_paragraph(l)
        stream=io.BytesIO();d.save(stream);raw=stream.getvalue()
    else:fail('요청한 출력 형식을 지원하지 않습니다.')
    if fmt in ('pptx','docx') and not extract(raw,fmt):fail('결과 파일을 다시 읽지 못했습니다.')
    return {'preview':plain,'evidence':evidence,'data':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest()}
try:
    result=process(json.load(sys.stdin));print(json.dumps(result))
except ImportError:
    print(json.dumps({'error':'문서 도구 구성 요소가 없습니다. 최신 앱 폴더 전체를 다시 풀어 실행하세요.'}))
except (ValueError,KeyError,UnicodeError,zipfile.BadZipFile,ET.ParseError) as e:
    print(json.dumps({'error':str(e) if type(e) is ValueError and any('가'<=c<='힣' for c in str(e)) else '문서 형식이나 본문을 읽지 못했습니다.'}))

