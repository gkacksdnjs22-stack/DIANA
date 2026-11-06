"""Neutral typography for reports, summaries, comparisons and text conversion."""
import io,os
from pathlib import Path
from xml.sax.saxutils import escape
from document_plan import text_blocks

def render_pdf(title,sections,docs,slides=False,table=None,preserve=False):
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,PageBreak,Table,TableStyle
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import A4
    fonts=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'Fonts';normal=fonts/'malgun.ttf';bold=fonts/'malgunbd.ttf'
    if not normal.is_file():raise ValueError('PDF 작성에 필요한 한글 글꼴을 찾지 못했습니다.')
    pdfmetrics.registerFont(TTFont('DocumentText',str(normal)));pdfmetrics.registerFont(TTFont('DocumentTitle',str(bold if bold.is_file() else normal)))
    width,height=(960,540) if slides else A4
    ink=HexColor('#253042');muted=HexColor('#657080')
    base=dict(fontName='DocumentText',textColor=ink,wordWrap='CJK')
    body=ParagraphStyle('body',fontSize=16 if slides else 10.5,leading=24 if slides else 17,spaceAfter=12 if slides else 8,**base)
    heading=ParagraphStyle('heading',fontName='DocumentTitle',textColor=ink,fontSize=22 if slides else 14,leading=29 if slides else 21,spaceBefore=12,spaceAfter=12,keepWithNext=True,wordWrap='CJK')
    title_style=ParagraphStyle('title',parent=heading,fontSize=26 if slides else 22,leading=34 if slides else 30,spaceBefore=0,spaceAfter=15)
    small=ParagraphStyle('source',parent=body,fontSize=11 if slides else 9,leading=17 if slides else 14,spaceAfter=6)
    def frame(c,doc):
        c.saveState();c.setFillColor(muted);c.setFont('DocumentText',8);c.drawRightString(width-42,18,str(doc.page))
        if doc.page>1 and not preserve:
            header=Paragraph(escape(title),small);_,hh=header.wrap(width-90,40)
            if hh<=30:header.drawOn(c,42,height-12-hh)
        c.restoreState()
    story=[]
    if not preserve:story.append(Paragraph(escape(title),title_style))
    for index,(name,items) in enumerate(sections):
        if not items:continue
        if name:story.append(Paragraph(escape(name),heading))
        if table and name==table['heading']:
            data=[[Paragraph(escape(str(v)),small) for v in row] for row in [table['headers']]+table['rows']]
            available=width-84
            t=Table(data,colWidths=[available*.43,available*.12,available*.12,available*.33],repeatRows=1,splitByRow=1,splitInRow=1,hAlign='LEFT')
            t.setStyle(TableStyle([('BACKGROUND',(0,0),(-1,0),HexColor('#e9edf2')),('GRID',(0,0),(-1,-1),.5,HexColor('#d9d9d9')),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]));story.extend([t,Spacer(1,12)]);continue
        for item in items:
            for kind,value in text_blocks(item):
                style=heading if kind.startswith('heading') else small if name=='출처' else body
                story.append(Paragraph(escape(value).replace('\n','<br/>'),style))
        if slides and index==0 and name=='핵심 요약' and len(sections)>1:story.append(PageBreak())
    if docs and not preserve and not any(h=='출처' for h,_ in sections):
        story.append(Paragraph('출처',heading))
        for i,(name,_) in enumerate(docs,1):story.append(Paragraph(escape(f'[{i}] {name}'),small))
    stream=io.BytesIO();SimpleDocTemplate(stream,pagesize=(width,height),leftMargin=42,rightMargin=42,topMargin=48,bottomMargin=42,title=title,author='',pageCompression=1).build(story,onFirstPage=frame,onLaterPages=frame)
    return stream.getvalue()
