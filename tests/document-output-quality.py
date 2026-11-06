"""Synthetic content checks; no user documents, model calls, or file approval."""
from pathlib import Path
import sys,unittest,io,json,base64,subprocess
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'financial-documents'))
sys.path.insert(0,str(Path(sys.executable).resolve().parent.parent/'office'))
import document_shaping as ds
from pdf_theme import render_pdf
class Page:
    def __init__(self,text):self.text=text
    def extract_text(self,**kwargs):return self.text
class Quality(unittest.TestCase):
    def office(self,fmt,kind='slides'):
        request={'kind':kind,'format':fmt,'request':'두 기록을 요약해 발표자료로 만들어줘','docs':[
            {'name':'현장 점검 기록.txt','decoded':'점검자는 장치 217개를 확인하고 이상이 없는지 기록했습니다.'},
            {'name':'활동 & 시험 기록.txt','decoded':'담당자는 시험 39회를 마치고 다음 일정을 기록했습니다.'}]}
        completed=subprocess.run([sys.executable,'-I','-B',str(root/'financial-documents/workbench-content.py')],input=json.dumps(request).encode(),stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=45,check=True)
        value=json.loads(completed.stdout);self.assertNotIn('error',value)
        return value,base64.b64decode(value['data'])
    def test_wrapped_paragraph_stays_complete(self):
        raw=ds.recover_pdf_pages([Page('점검 개요\n\n새 부품의 내구성을 시험했고\n안전 기준을 모두 만족했습니다.')])
        self.assertIn('시험했고 안전 기준을 모두 만족했습니다.',raw)
        o=ds.select_outline('시험.txt',raw,'발표자료')
        self.assertTrue(all(v.endswith('.') for _,g in o['groups'] for v in g))
    def test_repeated_boundary_removed(self):
        raw=ds.recover_pdf_pages([Page('반복되는 문서 머리말\n\n첫 번째 자료의 본문을 자세히 기록했습니다.\n\n1'),Page('반복되는 문서 머리말\n\n두 번째 자료의 본문을 자세히 기록했습니다.\n\n2')])
        self.assertNotIn('반복되는 문서 머리말',raw);self.assertIn('첫 번째',raw);self.assertIn('두 번째',raw)
    def test_body_in_header_group_is_preserved(self):
        raw=ds.recover_pdf_pages([Page('반복되는 문서 머리말\n첫 번째 페이지의 본문을 보존해야 합니다.'),Page('반복되는 문서 머리말\n두 번째 페이지의 본문도 보존해야 합니다.')])
        self.assertNotIn('반복되는 문서 머리말',raw)
        self.assertIn('첫 번째 페이지의 본문을 보존해야 합니다.',raw)
        self.assertIn('두 번째 페이지의 본문도 보존해야 합니다.',raw)
    def test_body_beside_header_is_preserved(self):
        raw=ds.recover_pdf_pages([Page('반복되는 문서 머리말    첫 번째 자료입니다.\n아래 본문도 남아 있어야 합니다.'),Page('반복되는 문서 머리말    두 번째 자료입니다.\n다른 페이지의 본문도 남아 있어야 합니다.')])
        self.assertNotIn('반복되는 문서 머리말',raw)
        for text in ('첫 번째 자료입니다.','두 번째 자료입니다.','아래 본문도 남아 있어야 합니다.','다른 페이지의 본문도 남아 있어야 합니다.'):self.assertIn(text,raw)
    def test_numeric_short_records_retained(self):
        o=ds.select_outline('측정.txt','관측값: 217개\n시험: 39회','요약')
        s=str(o['groups']);self.assertIn('217',s);self.assertIn('39',s)
    def test_extracts_only_source_spans(self):
        t='사업 개요\n\n담당자는 장비 상태를 점검하고 이상 여부를 기록했습니다. 추가 확인이 필요한 위치를 별도로 표시했습니다.'
        o=ds.select_outline('보고서.txt',t,'요약')
        for _,group in o['groups']:
            for fact in group:self.assertIn(fact,t)
    def test_neutral_pdf_and_metadata(self):
        from pypdf import PdfReader
        data=render_pdf('발표 자료',[('핵심 요약',['장치 217개를 확인했습니다. [1]'])],[('측정.txt','장치 217개를 확인했습니다.')],True)
        p=PdfReader(io.BytesIO(data));text=''.join(x.extract_text() for x in p.pages)
        self.assertNotIn('DIANA',text);self.assertNotIn('DIANA',p.metadata.get('/Author',''));self.assertIn('217',text);self.assertGreater(p.pages[0].mediabox.width,p.pages[0].mediabox.height)
    def test_long_text_can_span_pages_without_loss(self):
        from pypdf import PdfReader
        facts=['기록 '+str(i)+'번은 원문을 확인한 내용입니다. '*8 for i in range(18)]
        pdf=PdfReader(io.BytesIO(render_pdf('보고서',[('점검',facts)],[('원문.txt','')],False)))
        text=''.join(p.extract_text() for p in pdf.pages)
        self.assertIn('기록 17번',text);self.assertGreater(len(pdf.pages),1)
    def test_docx_has_reference_filename_list(self):
        from docx import Document
        for kind in ('summary','compare','slides'):
            with self.subTest(kind=kind):
                value,raw=self.office('docx',kind);document=Document(io.BytesIO(raw))
                lines=[p.text for p in document.paragraphs]
                self.assertIn('출처',lines)
                for source in ('[1] 현장 점검 기록.txt','[2] 활동 & 시험 기록.txt'):
                    self.assertIn(source,lines);self.assertIn(source,value['preview'])
    def test_pptx_has_reference_list_and_neutral_theme(self):
        from pptx import Presentation
        for kind in ('summary','compare','slides'):
            with self.subTest(kind=kind):
                value,raw=self.office('pptx',kind);presentation=Presentation(io.BytesIO(raw));text=[]
                for slide in presentation.slides:
                    self.assertEqual(str(slide.background.fill.fore_color.rgb),'FFFFFF')
                    for shape in slide.shapes:
                        if not shape.has_text_frame:continue
                        text.append(shape.text)
                        for paragraph in shape.text_frame.paragraphs:
                            for run in paragraph.runs:self.assertIn(str(run.font.color.rgb),('253042','657080'))
                self.assertIn('출처',text)
                for source in ('[1] 현장 점검 기록.txt','[2] 활동 & 시험 기록.txt'):
                    self.assertIn(source,text);self.assertIn(source,value['preview'])
                self.assertNotIn('DIANA','\n'.join(text))
if __name__=='__main__':unittest.main()
