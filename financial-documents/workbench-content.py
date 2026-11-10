"""Bounded, offline document extraction, comparison and Office output. JSON pipe only."""
import sys, os, io, json, re, base64, hashlib, zipfile, collections, decimal, tempfile, subprocess
from contextlib import closing
from xml.etree import ElementTree as ET
from pathlib import Path
lib=Path(sys.executable).resolve().parents[1]/'office'
if lib.is_dir(): sys.path.insert(0,str(lib))
sys.path.insert(0,str(Path(__file__).resolve().parent))
from document_shaping import recover_pdf_pages
from document_plan import build_plan
from office_layout import render_docx,render_pptx
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
                    for i,v in enumerate(o): yield from walk(v,p+'['+str(i)+']')
                elif o is not None: yield p+': '+str(o)
            envelope=isinstance(obj,dict) and isinstance(obj.get('title'),str) and isinstance(obj.get('body'),str) and isinstance(obj.get('sources'),list) and all(isinstance(n,str) for n in obj['sources']) and set(obj)<={'title','body','sources','document_type'}
            text=obj['body'] if envelope else '\n'.join(walk(obj))
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
            text='\n\n'.join(s for n in names for s in paragraphs(z.read(n)) if s)
    else: fail('읽을 수 없는 파일 형식입니다.')
    if len(text)>150000: fail('문서 본문이 읽기 한도를 넘습니다.')
    if not text.strip() or not re.search(r'\w',text) or re.search('[\x00-\x08\x0b\x0c\x0e-\x1f]',text): fail('읽을 수 있는 본문이 없습니다. 이미지 문서는 지원하지 않습니다.')
    return text if ext in ('txt','md','json','csv','tsv') else text.strip()
def words(s): return set(re.findall(r'[가-힣A-Za-z0-9]{2,}',s.lower()))
def inspect_original_pdf(raw):
    from pypdf import PdfReader
    from pypdf.generic import ArrayObject, ByteStringObject, DictionaryObject, IndirectObject, StreamObject
    unsupported='첨부, 암호화 또는 검사할 수 없는 구조가 있는 PDF는 원본으로 보낼 수 없습니다.'
    if not raw.startswith(b'%PDF-') or not re.search(rb'%%EOF\s*$',raw) or len(re.findall(rb'(?m)^startxref\s*$',raw))!=1:
        fail(unsupported)
    blocked={'/AA','/AcroForm','/AF','/EF','/EmbeddedFile','/EmbeddedFiles','/Filespec','/JavaScript','/JS',
             '/Launch','/OpenAction','/Prev','/RichMedia','/Thumb','/XFA'}
    filters={'/FlateDecode','/ASCIIHexDecode','/ASCII85Decode','/RunLengthDecode'}
    parts=[]
    remaining=1_900_000
    def add(text):
        nonlocal remaining
        remaining-=len(text.encode('utf-8'))+1
        if remaining<0:fail('PDF 원본 검사 분량 한도를 넘었습니다. 출력 형식을 지정해 변환해 주세요.')
        parts.append(text)
    def scan_bytes(data):
        add(data.decode('latin-1'))
        if data.startswith((b'\xff\xfe',b'\xfe\xff')):add(data.decode('utf-16'))
    try:
        pdf=PdfReader(io.BytesIO(raw),strict=True)
        if pdf.is_encrypted or not 1<=len(pdf.pages)<=120:fail(unsupported)
        indexed={(number,generation) for generation,entries in pdf.xref.items() for number in entries
                 if number and not pdf.xref_free_entry.get(generation,{}).get(number)}
        indexed.update((number,0) for number in pdf.xref_objStm)
        for match in re.finditer(rb'(?<!\S)(\d+)\s+(\d+)\s+obj(?=\s)',raw):
            number,generation=int(match[1]),int(match[2])
            if (number,generation) not in indexed or pdf.xref.get(generation,{}).get(number)!=match.start(1):
                fail(unsupported)
        seen=set()
        has_images=False
        def visit(obj):
            nonlocal has_images
            if isinstance(obj,IndirectObject):
                key=(obj.idnum,obj.generation)
                if key in seen:return
                if key not in indexed:fail(unsupported)
                seen.add(key)
                visit(obj.get_object())
            elif isinstance(obj,DictionaryObject):
                for key,value in obj.items():
                    if key in blocked:fail(unsupported)
                    resolved=value.get_object() if isinstance(value,IndirectObject) else value
                    if isinstance(resolved,str):add(key.lstrip('/')+': '+resolved)
                    visit(value)
                if isinstance(obj,StreamObject):
                    active_filters=obj.get('/Filter',[])
                    if isinstance(active_filters,str):active_filters=[active_filters]
                    image=obj.get('/Subtype')=='/Image'
                    allowed_filters=filters|{'/DCTDecode'} if image else filters
                    if '/F' in obj or any(value not in allowed_filters for value in active_filters):fail(unsupported)
                    if image:
                        has_images=True
                        if '/DCTDecode' in active_filters:scan_bytes(obj.get_data())
                        return
                    data=obj.get_data()
                    if re.search(rb'(?<!\S)BI(?=\s)',data):fail(unsupported)
                    scan_bytes(data)
                    if obj.get('/Type')=='/Metadata' or obj.get('/Subtype')=='/XML':
                        xml=data.decode('utf-16' if data.startswith((b'\xff\xfe',b'\xfe\xff')) else 'utf-8-sig')
                        if re.search(r'<!DOCTYPE|<!ENTITY',xml,re.I):fail(unsupported)
                        for element in ET.fromstring(xml).iter():
                            add(partname(element.tag)+': '+''.join(element.itertext()))
                            for key,value in element.attrib.items():add(partname(key)+': '+value)
            elif isinstance(obj,ArrayObject):
                for value in obj:visit(value)
            elif isinstance(obj,str):
                if obj in blocked:fail(unsupported)
                add(obj)
            elif isinstance(obj,ByteStringObject):scan_bytes(obj)
        visit(pdf.trailer)
        for number,generation in sorted(indexed):visit(IndirectObject(number,generation,pdf))
        scan_bytes(raw)
        has_text=False
        for page in pdf.pages:
            text=page.extract_text() or ''
            has_text=has_text or bool(re.search(r'\w',text))
            add(text)
        if not has_text and not has_images:fail(unsupported)
    except ValueError:raise
    except Exception:fail(unsupported)
    return {'preview':'\n'.join(parts),'pages':len(pdf.pages),'images':has_images}

def render_pdf_preview(raw,page_number,expected_pages):
    import pypdfium2 as pdfium
    with pdfium.PdfDocument(raw) as pdf:
        if len(pdf)!=expected_pages:fail('PDF 쪽수를 다시 확인해 주세요.')
        with closing(pdf[page_number-1]) as page:
            width,height=page.get_size()
            if min(width,height)<=0 or not 1<=max(width,height)<=14400:fail('PDF 페이지 크기를 확인해 주세요.')
            scale=min(3,1800/max(width,height))
            with closing(page.render(scale=scale,may_draw_forms=False,draw_annots=False)) as bitmap:
                out=io.BytesIO()
                bitmap.to_pil().convert('RGB').save(out,format='JPEG',quality=85)
                if out.tell()>1_500_000:fail('PDF 미리보기 크기 한도를 넘었습니다.')
                return {'image':base64.b64encode(out.getvalue()).decode('ascii')}

def process(req):
    op=req['kind']
    if op=='inspect-original-pdf':return inspect_original_pdf(base64.b64decode(req['data'],validate=True))
    if op=='render-pdf-preview':return render_pdf_preview(base64.b64decode(req['data'],validate=True),req['page'],req['pages'])
    fmt=req['format']; docs=[]
    for f in req.get('docs',[]):
        docs.append((f['name'],f['decoded'] if 'decoded' in f else extract(base64.b64decode(f['data'],validate=True),f['name'].rsplit('.',1)[-1].lower())))
    plan=build_plan(op,req.get('title'),docs,req.get('request',''),req.get('body',''),req.get('change'))
    title=plan['title'];sections=plan['sections'];plain=plan['plain'];md=plan['markdown'];evidence=plan['evidence']
    if fmt in ('txt','md','json'):raw=(json.dumps({'title':title,'body':plain,'sources':[x[0] for x in docs],'document_type':plan['mode']},ensure_ascii=False,indent=2) if fmt=='json' else md if fmt=='md' else plain).encode()
    elif fmt=='pdf':
        from pdf_theme import render_pdf
        raw=render_pdf(title,sections,docs,slides=op=='slides',table=plan['table'],preserve=plan['preserve'],report=plan['mode']=='report')
        if not raw.startswith(b'%PDF-') or not extract(raw,'pdf'):fail('PDF 결과를 다시 읽지 못했습니다.')
    elif fmt in ('pptx','ppt'):
        raw=render_pptx(plan)
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
        raw=render_docx(plan)
    else:fail('요청한 출력 형식을 지원하지 않습니다.')
    if fmt in ('pptx','docx') and not extract(raw,fmt):fail('결과 파일을 다시 읽지 못했습니다.')
    limitations=['본문 기반 작성이며 원문의 그림과 원래 배치는 보존하지 않습니다.'] if plan['preserve'] and fmt not in ('txt','md','json') else []
    preview='\n\n'.join(limitations+[plain]) if limitations else plain
    return {'preview':preview,'evidence':evidence,'data':base64.b64encode(raw).decode(),'sha256':hashlib.sha256(raw).hexdigest(),'document_type':plan['mode'],'title':title,'changes':plan['changes'],'limitations':limitations}
if __name__=='__main__':
    try:
        result=process(json.load(sys.stdin));print(json.dumps(result))
    except ImportError:
        print(json.dumps({'error':'문서 도구 구성 요소가 없습니다. 최신 앱 폴더 전체를 다시 풀어 실행하세요.'}))
    except (ValueError,KeyError,UnicodeError,zipfile.BadZipFile,ET.ParseError) as e:
        print(json.dumps({'error':str(e) if type(e) is ValueError and any('가'<=c<='힣' for c in str(e)) else '문서 형식이나 본문을 읽지 못했습니다.'}))

