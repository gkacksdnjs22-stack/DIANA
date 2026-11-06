from pathlib import Path
import sys,importlib.util,json,base64,hashlib,argparse
root=Path(__file__).resolve().parents[1];source=root/'financial-documents'
parser=argparse.ArgumentParser();parser.add_argument('--out',default=str(root/'.local/document-work-preview'));parser.add_argument('--include-legacy-ppt',action='store_true');args=parser.parse_args()
sys.path.insert(0,str(source));sys.path.insert(0,str(Path(sys.executable).resolve().parent.parent/'office'))
spec=importlib.util.spec_from_file_location('engine',source/'workbench-content.py');engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
out=Path(args.out).resolve();out.mkdir(parents=True,exist_ok=True)
quarters=[{'name':f'{i}분기 현장 운영.txt','decoded':f'운영 현황\n\n담당자는 {i}분기 장비 점검을 마치고 조치 내용을 기록했습니다.\n\n점검: {i*10}건\n교육: {i*2}회'} for i in range(1,5)]
meeting=[{'name':'설계 회의록.txt','decoded':'회의 결정\n\n참석자들은 안내판 문구를 확인한 뒤 다음 검토에서 최종안을 정하기로 했습니다.\n\n후속 작업\n\n담당자는 목요일까지 시험 39회의 기록을 취합하고 검토자에게 전달하기로 했습니다.'}]
body='# 신규 직원 교육 계획\n\n신규 직원이 현장 기록과 장비 점검 절차를 익히도록 교육합니다.\n\n## 교육 일정\n1. 월요일에 기록 작성 방법을 안내합니다.\n2. 수요일에 장치 217개의 점검 순서를 확인합니다.\n\n## 확인 사항\n- 시험 39회의 기록을 확인합니다.\n- 질문이 있는 항목은 담당자와 다시 확인합니다.'
inventory=[{'name':'창고 A.txt','decoded':'담당자는 창고의 재고를 확인하고 변경 내용을 기록했습니다.\n재고: 120개\n거리: 15km'},{'name':'창고 B.txt','decoded':'담당자는 다른 창고의 재고를 확인하고 비교 기준을 기록했습니다.\n재고: 90개\n거리: 30kg'}]
cases=[('report',dict(kind='compare',title='분기 현장 운영 보고서',request='분기 자료의 합계와 평균을 정리한 보고서 작성',docs=quarters),('pdf','docx'),['자료 범위','100건','25.00건','출처']),('summary',dict(kind='summary',title='설계 회의 요약',request='짧게 요약해줘',docs=meeting),('pdf',),['안내판','39','출처']),('compare',dict(kind='compare',title='창고 재고 비교',request='두 자료를 비교해줘',docs=inventory),('pdf','docx','pptx','ppt'),['120','90','단위','출처']),('create',dict(kind='create',title='신규 직원 교육 계획',request='새 교육 계획 작성',body=body,docs=[]),('pdf','docx'),['교육 일정','217','39']),('edit',dict(kind='edit',title='교육 계획 수정본',request='지정 문구 수정',change=['수요일','금요일'],docs=[{'name':'교육.md','decoded':body}]),('pdf','docx'),['금요일','217','39']),('convert',dict(kind='convert',title='교육 계획 변환본',request='본문 기반 형식 변환',docs=[{'name':'교육.md','decoded':body}]),('pdf','docx'),['수요일','217','39'])]
cases.append(('stress',dict(kind='create',title='긴 제목 '*35,request='새 문서 작성',body='\n'.join('작업 기록 '+str(i)+'번의 내용을 보존합니다.' for i in range(24)),docs=[]),('pptx',),['23번']))
manifest=[]
for name,req,formats,expected in cases:
    for fmt in formats:
        if fmt=='ppt' and not args.include_legacy_ppt:continue
        value=engine.process({**req,'format':fmt});raw=base64.b64decode(value['data']);file=out/(name+'.'+fmt);file.write_bytes(raw)
        manifest.append({'name':file.name,'format':fmt,'expected':expected,'forbidden':['수요일'] if name=='edit' else [],'sha256':hashlib.sha256(raw).hexdigest(),'bytes':len(raw),'mode':value['document_type']})
(out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8');print(json.dumps({'files':len(manifest),'modes':sorted(set(x['mode'] for x in manifest))}))
