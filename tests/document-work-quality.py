"""General document operations: content, structure, arithmetic and editable design."""
from pathlib import Path
import sys,unittest,io,base64,json,copy,importlib.util,re
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'financial-documents'));sys.path.insert(0,str(Path(sys.executable).resolve().parent.parent/'office'))
spec=importlib.util.spec_from_file_location('workbench_content',root/'financial-documents/workbench-content.py')
engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
from document_plan import numeric_analysis,build_plan
from office_layout import chunks
from docx import Document
from pptx import Presentation
from pypdf import PdfReader

class WorkQuality(unittest.TestCase):
    def documents(self):return [{'name':f'{i}분기 운영.txt','decoded':f'분기 운영 기록\n\n담당자는 {i}분기의 현장 점검을 완료하고 변경 내용을 기록했습니다.\n\n점검: {i*10}건'} for i in range(1,5)]
    def request(self,kind='compare',fmt='txt',**extras):return {'kind':kind,'format':fmt,'request':'분기 자료의 합계와 평균을 정리한 보고서 작성','docs':self.documents(),**extras}
    def decoded(self,result):return base64.b64decode(result['data'])
    def export_text(self,raw,fmt):
        if fmt=='pdf':return '\n'.join(p.extract_text() for p in PdfReader(io.BytesIO(raw)).pages)
        if fmt=='docx':
            d=Document(io.BytesIO(raw));return '\n'.join([p.text for p in d.paragraphs]+[c.text for t in d.tables for row in t.rows for c in row.cells])
        if fmt=='pptx':
            p=Presentation(io.BytesIO(raw));return '\n'.join(s.text if s.has_text_frame else '\n'.join(c.text for row in s.table.rows for c in row.cells) if s.has_table else '' for slide in p.slides for s in slide.shapes)
        return json.loads(raw)['body'] if fmt=='json' else raw.decode()
    def test_report_has_scope_facts_table_findings_and_sources(self):
        r=engine.process(self.request());text=r['preview']
        self.assertEqual(r['document_type'],'report');self.assertEqual(r['title'],'자료 종합 보고서')
        for v in ('자료 범위','핵심 요약','주요 수치','확인된 비교 결과','출처','100건','25.00건','30건'):self.assertIn(v,text)
        for i in range(1,5):self.assertIn(f'[{i}] {i}분기 운영.txt',text)
    def test_summary_is_shorter_than_report_without_cutting_sentences(self):
        text='\n\n'.join(f'제{i}작업 내용\n\n담당자는 작업 {i}번의 결과를 확인하고 자세한 상태를 기록했습니다.' for i in range(1,9))
        docs=[{'name':'업무.txt','decoded':text}]
        a=engine.process(self.request('summary',docs=docs,request='자료를 요약해줘'))
        b=engine.process(self.request('summary',docs=docs,request='자료로 보고서 작성해줘'))
        self.assertLess(a['evidence'][0]['selected'],b['evidence'][0]['selected']);self.assertIn('기록했습니다.',a['preview'])
    def test_matrix_content_survives_all_operations_and_formats(self):
        body='# 실행 계획\n\n현장 장치 217개를 점검합니다.\n\n## 다음 일정\n- 시험 39회를 진행합니다.\n- 결과를 확인합니다.'
        cases=[self.request('compare'),self.request('summary',request='짧게 요약해줘'),self.request('slides',request='발표자료 만들어줘'),self.request('summary'),self.request('create',docs=[],body=body,request='새 계획 작성'),self.request('edit',docs=[{'name':'계획.md','decoded':body}],change=['217','218']),self.request('convert',docs=[{'name':'계획.md','decoded':body}])]
        for request in cases:
            for fmt in ('txt','md','json','pdf','docx','pptx'):
                with self.subTest(kind=request['kind'],fmt=fmt,report='보고서' in request['request']):
                    value=engine.process({**request,'format':fmt});text=self.export_text(self.decoded(value),fmt)
                    if request['kind'] in ('create','edit','convert'):
                        self.assertIn('218' if request['kind']=='edit' else '217',text);self.assertIn('39',text)
                    else:
                        for i in range(1,5):self.assertIn(f'{i}분기 운영.txt',text)
                    self.assertNotIn('DIANA',text)
    def test_unit_mismatch_is_not_added_or_subtracted(self):
        a=numeric_analysis([('a','예산: 100만원'),('b','예산: 200원')],'합계 평균')
        self.assertFalse(a['findings']);self.assertEqual(len(a['rows']),2);self.assertIn('단위',' '.join(a['notes']))
    def test_missing_value_is_not_treated_as_zero(self):
        a=numeric_analysis([('a','점검: 10건'),('b','결과를 확인했습니다.')],'합계')
        self.assertFalse(a['findings']);self.assertIn('[2]',' '.join(a['notes']))
    def test_multiple_values_require_a_basis(self):
        a=numeric_analysis([('a','점검: 10건\n점검: 20건'),('b','점검: 30건')],'합계')
        self.assertFalse(a['findings']);self.assertIn('기준 확인',' '.join(a['notes']))
    def test_commas_signs_and_percent_points(self):
        a=numeric_analysis([('a','예산: 1,200만원\n비율: 35%'),('b','예산: -200만원\n비율: 30%')],'합계 평균')
        self.assertIn('1000만원',' '.join(a['findings']));self.assertIn('-5%p',' '.join(a['findings']));self.assertIn('비율',' '.join(a['notes']))
    def test_comparison_order_is_explicit_not_invented_chronology(self):
        a=engine.process(self.request());self.assertIn('입력 순서',a['preview']);self.assertNotIn('원인으로',a['preview'])
    def test_short_unresolved_records_are_kept_with_sources(self):
        r=engine.process(self.request('summary',docs=[{'name':'회의.txt','decoded':'회의 내용\n\n담당자는 다음 일정을 검토한 뒤 결과를 기록했습니다.\n\n미해결: 장소 미정\n제약: 예산 미확인'}]))
        self.assertIn('미해결: 장소 미정 [1]',r['preview']);self.assertIn('제약: 예산 미확인 [1]',r['preview'])
    def test_large_decimal_sum_is_exact(self):
        number='123456789012345678901234567890'
        a=numeric_analysis([('a','금액: '+number+'원'),('b','금액: '+number+'원')],'합계')
        self.assertIn('246913578024691357802469135780원',' '.join(a['findings']))
        with self.assertRaises(ValueError):numeric_analysis([('a','금액: '+'1'*65+'원')],'합계')
    def test_create_preserves_provided_content_and_native_headings(self):
        body='# 실행 계획\n\n장치 217개를 확인합니다.\n\n## 시험 계획\n- 시험 39회를 진행합니다.'
        r=engine.process(self.request('create','docx',docs=[],body=body));d=Document(io.BytesIO(self.decoded(r)))
        self.assertEqual(r['preview'],body);self.assertTrue(any(p.style.name=='Heading 1' and p.text=='실행 계획' for p in d.paragraphs))
        for name in ('Title','Heading 1','Heading 2'):self.assertEqual(str(d.styles[name].font.color.rgb),'000000')
    def test_title_is_not_duplicated_and_has_no_template_rule(self):
        r=engine.process(self.request('create','docx',docs=[],title='실행 계획',body='# 실행 계획\n\n장치 217개를 확인합니다.'))
        d=Document(io.BytesIO(self.decoded(r)));self.assertEqual([p.text for p in d.paragraphs].count('실행 계획'),1)
        self.assertFalse(d.styles['Title'].element.xpath('./w:pPr/w:pBdr'))
    def test_numeric_detail_is_not_repeated_outside_comparison_table(self):
        p=build_plan('compare',None,[('A','작업 결과를 확인하고 자세한 내용을 기록했습니다.\n값: 1건\n거리: 2km'),('B','다른 결과를 확인하고 자세한 내용을 기록했습니다.\n값: 3건\n거리: 4km')],'비교')
        for heading,items in p['sections']:
            if heading.startswith('[1]') or heading.startswith('[2]'):self.assertFalse(any(re.fullmatch(r'거리: \d+km \[\d\]',item) for item in items))
    def test_edit_changes_only_the_requested_literal(self):
        text='옛 일정은 금요일입니다.\n\n옛 일정의 담당자는 그대로입니다.\n\n예산: 120만원\n'
        req=self.request('edit','txt',docs=[{'name':'안내.txt','decoded':text}],change=['옛 일정','새 일정']);before=copy.deepcopy(req)
        r=engine.process(req);self.assertEqual(self.decoded(r).decode(),text.replace('옛 일정','새 일정'));self.assertEqual(r['changes'],2);self.assertEqual(req,before)
    def test_edit_without_a_match_fails(self):
        with self.assertRaises(ValueError):engine.process(self.request('edit',docs=[{'name':'a.txt','decoded':'본문입니다.'}],change=['없는 문구','대체']))
    def test_text_markdown_json_roundtrip_preserves_body(self):
        body='  들여쓴 원문\n\n값: 12건\n'
        for source_format in ('txt','md','json'):
            first=engine.process(self.request('convert',source_format,docs=[{'name':'원문.txt','data':base64.b64encode(body.encode()).decode()}]))
            for target in ('txt','md','json'):
                with self.subTest(source=source_format,target=target):
                    r=engine.process(self.request('convert',target,docs=[{'name':'중간.'+source_format,'data':first['data']}]))
                    self.assertEqual(self.export_text(self.decoded(r),target),body)
    def test_unrelated_json_metadata_is_not_silently_discarded(self):
        raw=json.dumps({'title':'기록','body':'내용','sources':[],'extra':47}).encode()
        self.assertIn('extra: 47',engine.extract(raw,'json'))
    def test_json_list_records_keep_their_indices(self):
        raw=json.dumps([{'값':1},{'값':2}],ensure_ascii=False).encode();text=engine.extract(raw,'json')
        self.assertIn('[0]',text);self.assertIn('[1]',text)
    def test_conversion_warning_is_in_preview_not_in_output_body(self):
        r=engine.process(self.request('convert','docx',docs=[{'name':'원문.txt','decoded':'담당자는 장치 217개를 확인하고 결과를 기록했습니다.'}]))
        self.assertIn('원래 배치',r['preview']);self.assertTrue(r['limitations'])
        self.assertNotIn('원래 배치',self.export_text(self.decoded(r),'docx'))
    def test_ppt_hard_line_breaks_do_not_overpack_a_textbox(self):
        body='\n'.join('작업 기록 '+str(i)+'번의 내용을 보존합니다.' for i in range(24))
        r=engine.process(self.request('create','pptx',body=body,docs=[],title='긴 제목 '*35));p=Presentation(io.BytesIO(self.decoded(r)))
        boxes=[s.text for sl in p.slides for s in sl.shapes if s.has_text_frame]
        self.assertTrue(any('23번' in t for t in boxes));self.assertGreaterEqual(len(p.slides),8)
    def test_long_source_names_are_present_in_pdf(self):
        name='매우 긴 원천 이름 '*14+'.txt'
        value=engine.process(self.request('summary','pdf',docs=[{'name':name,'decoded':'담당자는 장치 217개를 확인하고 결과를 기록했습니다.'}],request='요약'))
        text=self.export_text(self.decoded(value),'pdf');self.assertIn(re.sub(r'\s','',name),re.sub(r'\s','',text))
    def test_pagination_keeps_all_text_and_editable_comparison_rows(self):
        docs=[{'name':f'자료{i}.txt','decoded':'\n'.join(f'항목{k}: {i+k}건' for k in range(15))} for i in (1,2)]
        req=self.request('compare','pptx',docs=docs);r=engine.process(req);p=Presentation(io.BytesIO(self.decoded(r)))
        rows=[list(c.text for c in row.cells) for sl in p.slides for sh in sl.shapes if sh.has_table for row in list(sh.table.rows)[1:]]
        self.assertEqual(len(rows),30);self.assertEqual(sum(row[0]=='항목14' for row in rows),2)
        long='가나다라마바사'*180+' https://example.invalid/'+'x'*500
        self.assertEqual(re.sub(r'\s','',long),re.sub(r'\s','',''.join(chunks(long))))
    def test_invalid_or_empty_operations_fail(self):
        for request in (self.request('create',docs=[],body=' '),self.request('compare',docs=self.documents()[:1]),self.request('summary',docs=[]),self.request(fmt='png')):
            with self.assertRaises((ValueError,KeyError)):engine.process(request)
    def test_ppt_preserves_leading_consecutive_and_trailing_headings(self):
        bodies=['# 단독 제목','# 첫 제목\n## 둘째 제목\n확인한 본문입니다.','# 앞 제목\n확인한 본문입니다.\n## 마지막 제목']
        for op in ('create','edit','convert'):
            for body in bodies:
                with self.subTest(op=op,body=body):
                    req=self.request(op,'pptx',title='검사용 문서',body=body,docs=[] if op=='create' else [{'name':'원문.md','decoded':body}],change=['제목','항목'])
                    value=engine.process(req);p=Presentation(io.BytesIO(self.decoded(value)))
                    text=[s.text for sl in p.slides for s in sl.shapes if s.has_text_frame]
                    expected=[line.lstrip('# ').replace('제목','항목') if op=='edit' else line.lstrip('# ') for line in body.splitlines() if line.startswith('#')]
                    self.assertEqual([t for t in text if t in expected],expected)
                    if '본문' in body:self.assertTrue(any('확인한 본문입니다.' in t for t in text))
    def test_ppt_preserves_section_headings_without_body(self):
        from office_layout import render_pptx
        p=Presentation(io.BytesIO(render_pptx({'title':'검사용 문서','preserve':False,'table':None,'sections':[('앞 제목',[]),('중간 제목',['']),('끝 제목',[])]})))
        text=[s.text for sl in p.slides for s in sl.shapes if s.has_text_frame]
        self.assertEqual([t for t in text if t!='검사용 문서'],['앞 제목','중간 제목','끝 제목'])
    def test_ppt_title_only_document_does_not_repeat_title(self):
        r=engine.process(self.request('create','pptx',title='실행 계획',body='# 실행 계획',docs=[]));p=Presentation(io.BytesIO(self.decoded(r)))
        self.assertEqual([s.text for sl in p.slides for s in sl.shapes if s.has_text_frame],['실행 계획'])
    def test_input_report_references_do_not_select_report_layout(self):
        requests=['분기보고서.txt를 요약해줘','분기보고서를 짧게 요약해줘','"분기보고서.txt"와 회의록을 비교해줘','자료의 "보고서 작성" 부분을 요약해줘','보고서를 요약해서 TXT로 만들어줘','보고서 작성 방법을 짧게 요약해줘','"보고서로 작성해줘"라는 문장을 요약해줘','참고리포트.md의 내용을 요약해줘','보고서 형식으로 작성된 자료를 요약해줘','보고서로 작성하지 말고 요약해줘','보고서작성.pdf를 요약해줘','자료의 보고서 작성, 검토 절차를 요약해줘','보고서 형식으로, 그 내용을 요약해줘']
        docs=[('분기보고서.txt','담당자는 보고서 작성 방법을 확인한 뒤 결과를 기록했습니다.'),('참고리포트.md','다른 담당자는 현장 검토 내용을 확인하고 기록했습니다.')]
        for op in ('summary','compare'):
            for request in requests:
                with self.subTest(op=op,request=request):
                    p=build_plan(op,'사용자 지정 제목',docs,request);self.assertEqual(p['mode'],op);self.assertEqual(p['title'],'사용자 지정 제목');self.assertNotIn('자료 범위',[h for h,_ in p['sections']])
    def test_explicit_report_output_instructions_still_work(self):
        requests=['자료로 보고서 작성해줘','자료를 정리한 보고서 작성','자료를 보고서로 작성해 주세요','분기보고서.txt를 읽고 보고서로 만들어줘','자료를 보고서 형식으로 짧게 요약해줘','리포트 형태로 정리해줘','자료를 "보고서"로 작성해줘','자료를 ‘리포트’로 만들어줘','자료를 "보고서"를 작성해줘','자료를 보고서 PDF로 만들어줘','자료를 보고서로 DOCX 파일로 작성해줘','보고서 형식으로','자료를 보고서로 작성하세요','자료를 보고서로 작성해 주십시오']
        docs=[('분기보고서.txt','담당자는 현장 상태를 확인한 뒤 결과를 기록했습니다.')]
        for op in ('summary','compare'):
            for request in requests:
                with self.subTest(op=op,request=request):
                    p=build_plan(op,None,docs if op=='summary' else docs+[('회의록.txt','참석자는 검토 내용을 정리하고 결과를 기록했습니다.')],request)
                    self.assertEqual(p['mode'],'report');self.assertIn('자료 범위',[h for h,_ in p['sections']])

if __name__=='__main__':unittest.main()
