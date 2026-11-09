"""Neutral typography for reports, summaries, comparisons and text conversion."""
import io,os
from pathlib import Path
from xml.sax.saxutils import escape
from document_plan import text_blocks

def render_pdf(title,sections,docs,slides=False,table=None,preserve=False,report=False):
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
    accent=HexColor('#3e5770');rule=HexColor('#d5dde5')
    margin=60 if slides else 48 if report else 42
    base=dict(fontName='DocumentText',textColor=ink,wordWrap='CJK')
    body=ParagraphStyle('body',fontSize=19 if slides else 10.5,leading=28 if slides else 17,spaceAfter=14 if slides else 8,**base)
    heading=ParagraphStyle('heading',fontName='DocumentTitle',textColor=accent if slides or report else ink,fontSize=24 if slides else 14,leading=32 if slides else 21,spaceBefore=14,spaceAfter=12,keepWithNext=True,wordWrap='CJK')
    title_style=ParagraphStyle('title',parent=heading,textColor=ink,fontSize=30 if slides else 24 if report else 22,leading=38 if slides else 32 if report else 30,spaceBefore=0,spaceAfter=18)
    small=ParagraphStyle('source',parent=body,fontSize=11 if slides else 9,leading=17 if slides else 14,spaceAfter=6)
    def frame(c,doc):
        c.saveState()
        if slides or report:
            c.setStrokeColor(rule);c.line(margin,32,width-margin,32)
            if slides or doc.page==1:
                c.setFillColor(accent);c.rect(margin,height-33,34,3,stroke=0,fill=1)
        c.setFillColor(muted);c.setFont('DocumentText',9 if slides else 8);c.drawRightString(width-margin,18,str(doc.page))
        if doc.page>1 and not preserve:
            header=Paragraph(escape(title),small);_,hh=header.wrap(width-2*margin-42,40)
            if hh<=30:header.drawOn(c,margin+(46 if slides else 0),height-12-hh)
        c.restoreState()
    story=[]
    if not preserve:story.append(Paragraph(escape(title),title_style))
    for index,(name,items) in enumerate((section for section in sections if section[1])):
        if slides and index:story.append(PageBreak())
        if name:story.append(Paragraph(escape(name),heading))
        if table and name==table['heading']:
            data=[[Paragraph(escape(str(v)),small) for v in row] for row in [table['headers']]+table['rows']]
            available=width-2*margin-12
            t=Table(data,colWidths=[available*.43,available*.12,available*.12,available*.33],repeatRows=1,splitByRow=1,splitInRow=1,hAlign='LEFT')
            t.setStyle(TableStyle([('ROWBACKGROUNDS',(0,1),(-1,-1),[HexColor('#ffffff'),HexColor('#f5f7fa')]),('BACKGROUND',(0,0),(-1,0),HexColor('#e8edf3')),('LINEBELOW',(0,0),(-1,0),.8,accent),('LINEBELOW',(0,-1),(-1,-1),.5,rule),('VALIGN',(0,0),(-1,-1),'MIDDLE'),('LEFTPADDING',(0,0),(-1,-1),8),('RIGHTPADDING',(0,0),(-1,-1),8),('TOPPADDING',(0,0),(-1,-1),7),('BOTTOMPADDING',(0,0),(-1,-1),7)]));story.extend([t,Spacer(1,12)]);continue
        for item in items:
            for kind,value in text_blocks(item):
                style=heading if kind.startswith('heading') else small if name=='출처' else body
                story.append(Paragraph(escape(value).replace('\n','<br/>'),style))
    if docs and not preserve and not any(h=='출처' for h,_ in sections):
        story.append(Paragraph('출처',heading))
        for i,(name,_) in enumerate(docs,1):story.append(Paragraph(escape(f'[{i}] {name}'),small))
    stream=io.BytesIO();SimpleDocTemplate(stream,pagesize=(width,height),leftMargin=margin,rightMargin=margin,topMargin=58 if slides or report else 48,bottomMargin=42,title=title,author='',pageCompression=1).build(story,onFirstPage=frame,onLaterPages=frame)
    return stream.getvalue()
