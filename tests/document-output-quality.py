"""Synthetic content checks; no user documents, model calls, or file approval."""
from pathlib import Path
import sys,unittest,io
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'financial-documents'))
sys.path.insert(0,str(Path(sys.executable).resolve().parent.parent/'office'))
import document_shaping as ds
from pdf_theme import render_pdf
class Page:
    def __init__(self,text):self.text=text
    def extract_text(self,**kwargs):return self.text
class Quality(unittest.TestCase):
    def test_wrapped_paragraph_stays_complete(self):
        raw=ds.recover_pdf_pages([Page('점검 개요\n\n새 부품의 내구성을 시험했고\n안전 기준을 모두 만족했습니다.')])
        self.assertIn('시험했고 안전 기준을 모두 만족했습니다.',raw)
        o=ds.select_outline('시험.txt',raw,'발표자료')
        self.assertTrue(all(v.endswith('.') for _,g in o['groups'] for v in g))
    def test_repeated_boundary_removed(self):
        raw=ds.recover_pdf_pages([Page('반복되는 문서 머리말\n\n첫 번째 자료의 본문을 자세히 기록했습니다.\n\n1'),Page('반복되는 문서 머리말\n\n두 번째 자료의 본문을 자세히 기록했습니다.\n\n2')])
        self.assertNotIn('반복되는 문서 머리말',raw);self.assertIn('첫 번째',raw);self.assertIn('두 번째',raw)
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
if __name__=='__main__':unittest.main()
