"""Neutral document layouts. Product branding belongs to the app, not user files."""
import io,os
from pathlib import Path
from xml.sax.saxutils import escape

def render_pdf(title,sections,docs,slides=False):
    from reportlab.pdfgen import canvas
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.ttfonts import TTFont
    from reportlab.platypus import SimpleDocTemplate,Paragraph,Spacer,PageBreak,Table,TableStyle
    from reportlab.lib.styles import ParagraphStyle
    from reportlab.lib.colors import HexColor
    from reportlab.lib.pagesizes import A4
    fonts=Path(os.environ.get('SystemRoot',r'C:\Windows'))/'Fonts'
    normal=fonts/'malgun.ttf';bold=fonts/'malgunbd.ttf'
    if not normal.is_file(): raise ValueError('PDF 작성에 필요한 한글 글꼴을 찾지 못했습니다.')
    pdfmetrics.registerFont(TTFont('DianaText',str(normal)))
    pdfmetrics.registerFont(TTFont('DianaTitle',str(bold if bold.is_file() else normal)))
    page=(960,540) if slides else A4; width,height=page
    navy=HexColor('#253042');muted=HexColor('#657080')
    filenames=' '.join(Path(name).stem for name,_ in docs)
    display_title=('경력 및 프로젝트 소개' if '이력서' in filenames and '포트폴리오' in filenames else '핵심 내용 요약') if title=='발표 자료' else title
    heading=ParagraphStyle('section',fontName='DianaTitle',fontSize=22 if slides else 15,leading=30 if slides else 23,textColor=navy,wordWrap='CJK',spaceBefore=10,spaceAfter=15,keepWithNext=True)
    body=ParagraphStyle('fact',fontName='DianaText',fontSize=16 if slides else 10.5,leading=24 if slides else 18,textColor=navy,wordWrap='CJK')
    source_style=ParagraphStyle('sources',fontName='DianaText',fontSize=9,leading=15,textColor=muted,wordWrap='CJK',spaceBefore=5)
    source_names=['['+str(i)+'] '+Path(name).name for i,(name,_) in enumerate(docs,1)]
    def background(c,doc):
        c.saveState();c.setFillColor(HexColor('#ffffff'));c.rect(0,0,width,height,stroke=0,fill=1)
        max_width=width-96;size=14 if slides else 11
        text=display_title
        while pdfmetrics.stringWidth(text,'DianaTitle',size)>max_width and len(text)>5:text=text[:-2]
        if text!=display_title:text+='...'
        c.setFont('DianaTitle',size);c.setFillColor(muted);c.drawString(48,height-35,text)
        c.setStrokeColor(HexColor('#dce1e7'));c.line(48,height-49,width-48,height-49)
        c.setFont('DianaText',8);c.setFillColor(muted);c.drawRightString(width-40,20,f'{doc.page:02d}')
        if len(source_names)<=3:
            footer=Paragraph(escape('  |  '.join(source_names)),source_style);fw=width-130;_,fh=footer.wrap(fw,30)
            if fh<=27:footer.drawOn(c,48,15)
        c.restoreState()
    story=[]
    if title not in ('발표 자료','자료 요약','자료 비교와 종합','새 문서','변환본','수정본'):
        story.extend([Paragraph(escape(title),heading),Spacer(1,4)])
    for index,(name,items) in enumerate(sections):
        if not items:continue
        story.append(Paragraph(escape(name),heading))
        for item in items:
            paragraph=Paragraph(escape(item).replace('\n','<br/>'),body)
            card=Table([[paragraph]],colWidths=[width-(108 if slides else 96)],hAlign='LEFT',splitByRow=1,splitInRow=1,cornerRadii=[8,8,8,8])
            card.setStyle(TableStyle([('LINEBEFORE',(0,0),(0,-1),2,HexColor('#ccd3dc')),('LEFTPADDING',(0,0),(-1,-1),16),('RIGHTPADDING',(0,0),(-1,-1),12),('TOPPADDING',(0,0),(-1,-1),8),('BOTTOMPADDING',(0,0),(-1,-1),8)]))
            card.spaceAfter=12;story.append(card)
        if slides and index==0 and name=='핵심 요약' and len(sections)>1:story.append(PageBreak())
    if len(source_names)>3:
        story.append(Paragraph('출처',heading))
        for source in source_names:story.append(Paragraph(escape(source),source_style))
    stream=io.BytesIO()
    SimpleDocTemplate(stream,pagesize=page,leftMargin=48 if slides else 42,rightMargin=48 if slides else 42,topMargin=65,bottomMargin=55,title=display_title,author='',pageCompression=1).build(story,onFirstPage=background,onLaterPages=background)
    return stream.getvalue()
