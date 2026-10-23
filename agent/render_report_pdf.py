import json
import os
import sys
from html import escape
from pathlib import Path

from pypdf import PdfReader
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4, landscape
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import KeepTogether, Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle
from reportlab.lib.utils import ImageReader
from reportlab.pdfgen.canvas import Canvas


NAVY = colors.HexColor('#17263C')
TEAL = colors.HexColor('#1BA6A6')
LILAC = colors.HexColor('#7256B8')
MUTED = colors.HexColor('#667487')
PALE = colors.HexColor('#EEF5FA')


def korean_font():
    candidates = [
        os.environ.get('DIANA_PDF_FONT'),
        r'C:\Windows\Fonts\malgun.ttf',
        r'C:\Windows\Fonts\NanumGothic.ttf',
    ]
    regular = next((item for item in candidates if item and Path(item).is_file()), None)
    if not regular:
        raise RuntimeError('A Korean TrueType font is required for PDF export.')
    pdfmetrics.registerFont(TTFont('DianaKorean', regular))
    bold_candidates = [
        os.environ.get('DIANA_PDF_BOLD_FONT'),
        r'C:\Windows\Fonts\malgunbd.ttf',
        regular,
    ]
    bold = next((item for item in bold_candidates if item and Path(item).is_file()), regular)
    pdfmetrics.registerFont(TTFont('DianaKoreanBold', bold))
    pdfmetrics.registerFontFamily('DianaKorean', normal='DianaKorean', bold='DianaKoreanBold', italic='DianaKorean', boldItalic='DianaKoreanBold')
    return 'DianaKorean', 'DianaKoreanBold'


def para_text(value):
    return escape(str(value)).replace('\n', '<br/>')


def render_report(data, output_path, regular, bold):
    report = data['report']
    source = data['source']
    base = getSampleStyleSheet()
    styles = {
        'title': ParagraphStyle('DianaTitle', parent=base['Title'], fontName=bold, fontSize=22, leading=29, textColor=NAVY, alignment=TA_LEFT, spaceAfter=5 * mm, wordWrap='CJK'),
        'deck': ParagraphStyle('DianaDeck', parent=base['Normal'], fontName=regular, fontSize=10, leading=15, textColor=MUTED, spaceAfter=7 * mm, wordWrap='CJK'),
        'summary_head': ParagraphStyle('DianaSummaryHead', parent=base['Heading2'], fontName=bold, fontSize=12, leading=17, textColor=NAVY, spaceAfter=2 * mm, wordWrap='CJK'),
        'body': ParagraphStyle('DianaBody', parent=base['BodyText'], fontName=regular, fontSize=10, leading=16, textColor=colors.HexColor('#26384C'), spaceAfter=3 * mm, wordWrap='CJK'),
        'section': ParagraphStyle('DianaSection', parent=base['Heading2'], fontName=bold, fontSize=15, leading=20, textColor=NAVY, spaceBefore=4 * mm, spaceAfter=3 * mm, keepWithNext=True, wordWrap='CJK'),
        'evidence': ParagraphStyle('DianaEvidence', parent=base['BodyText'], fontName=regular, fontSize=8.5, leading=13, textColor=MUTED, leftIndent=4 * mm, borderColor=TEAL, borderWidth=1, borderPadding=5, spaceBefore=1 * mm, spaceAfter=3 * mm, wordWrap='CJK'),
        'small': ParagraphStyle('DianaSmall', parent=base['BodyText'], fontName=regular, fontSize=8, leading=12, textColor=MUTED, wordWrap='CJK'),
        'limitation': ParagraphStyle('DianaLimitation', parent=base['BodyText'], fontName=regular, fontSize=9, leading=14, textColor=colors.HexColor('#33465A'), leftIndent=4 * mm, bulletIndent=0, spaceAfter=1.5 * mm, wordWrap='CJK'),
    }

    def page(canvas, document):
        canvas.saveState()
        width, height = A4
        canvas.setStrokeColor(colors.HexColor('#D9E2EC'))
        canvas.setLineWidth(0.5)
        canvas.line(document.leftMargin, 15 * mm, width - document.rightMargin, 15 * mm)
        canvas.setFont(regular, 8)
        canvas.setFillColor(MUTED)
        canvas.drawString(document.leftMargin, 10 * mm, 'DIANA  ·  원문 기반 보고서')
        canvas.drawRightString(width - document.rightMargin, 10 * mm, str(document.page))
        canvas.restoreState()

    document = SimpleDocTemplate(
        str(output_path), pagesize=A4, leftMargin=21 * mm, rightMargin=21 * mm,
        topMargin=20 * mm, bottomMargin=21 * mm, title=str(report['title']), author='DIANA',
    )
    story = [
        Paragraph(para_text(report['title']), styles['title']),
        Paragraph('AI 검토 문서  ·  지정한 원문을 바탕으로 작성', styles['deck']),
    ]
    summary = [Paragraph('핵심 요약', styles['summary_head']), Paragraph(para_text(report['summary']), styles['body'])]
    summary_box = Table([[summary]], colWidths=[A4[0] - 42 * mm])
    summary_box.setStyle(TableStyle([
        ('BACKGROUND', (0, 0), (-1, -1), PALE), ('BOX', (0, 0), (-1, -1), 0.7, colors.HexColor('#C6D9E6')),
        ('LINEBEFORE', (0, 0), (0, -1), 3, TEAL), ('LEFTPADDING', (0, 0), (-1, -1), 6 * mm),
        ('RIGHTPADDING', (0, 0), (-1, -1), 6 * mm), ('TOPPADDING', (0, 0), (-1, -1), 5 * mm),
        ('BOTTOMPADDING', (0, 0), (-1, -1), 2 * mm),
    ]))
    story.extend([summary_box, Spacer(1, 5 * mm)])
    for section in report.get('sections', []):
        story.extend([Paragraph(para_text(section['heading']), styles['section']), Paragraph(para_text(section['text']), styles['body'])])
        evidence = section.get('evidence', [])
        if evidence:
            story.append(Paragraph('원문 근거<br/>' + '<br/>'.join(para_text(item) for item in evidence), styles['evidence']))
    story.append(Paragraph('확인 범위와 한계', styles['section']))
    for limitation in report.get('limitations', []):
        story.append(Paragraph('•  ' + para_text(limitation), styles['limitation']))
    story.append(KeepTogether([
        Spacer(1, 3 * mm), Paragraph('원문 및 검증 정보', styles['summary_head']),
        Paragraph('파일: ' + para_text(source['filename']), styles['small']),
        Paragraph('원문 SHA-256: ' + para_text(source['sha256']), styles['small']),
        Paragraph('이 문서는 지정한 원문으로 작성했습니다. 외부 자료를 통한 사실 확인은 수행하지 않았으며 원본은 보존했습니다.', styles['small']),
    ]))
    document.build(story, onFirstPage=page, onLaterPages=page)


def render_slides(data, output_path):
    page_width, page_height = landscape(A4)
    margin = 10 * mm
    pdf = Canvas(str(output_path), pagesize=(page_width, page_height), pageCompression=1)
    pdf.setTitle(str(data['report']['title']) + ' · 발표자료')
    pdf.setAuthor('DIANA')
    for index in range(int(data['slideCount'])):
        preview = Path(data['slidePreviewDirectory']) / f"slide-{index + 1:02d}.png"
        if not preview.is_file():
            raise RuntimeError('A rendered slide preview is missing.')
        image = ImageReader(str(preview))
        image_width, image_height = image.getSize()
        if image_width < 640 or image_height < 360 or image_width / image_height < 1.6 or image_width / image_height > 1.95:
            raise RuntimeError('A rendered slide preview has unexpected dimensions.')
        scale = min((page_width - 2 * margin) / image_width, (page_height - 2 * margin) / image_height)
        width, height = image_width * scale, image_height * scale
        pdf.drawImage(image, (page_width - width) / 2, (page_height - height) / 2,
                      width=width, height=height, preserveAspectRatio=True, mask='auto')
        pdf.showPage()
    pdf.save()


def main():
    if len(sys.argv) != 2:
        raise RuntimeError('Invalid PDF renderer arguments.')
    with open(sys.argv[1], 'r', encoding='utf-8') as stream:
        data = json.load(stream)
    regular, bold = korean_font()
    render_report(data, data['reportPdf'], regular, bold)
    render_slides(data, data['presentationPdf'])
    report_reader = PdfReader(data['reportPdf'])
    slide_reader = PdfReader(data['presentationPdf'])
    if not report_reader.pages or len(slide_reader.pages) != int(data['slideCount']):
        raise RuntimeError('PDF page-count validation failed.')
    report_text = '\n'.join(page.extract_text() or '' for page in report_reader.pages)
    if data['report']['title'] not in report_text or data['source']['filename'] not in report_text:
        raise RuntimeError('PDF text validation failed.')
    if any(not page.get('/Resources', {}).get('/XObject') for page in slide_reader.pages):
        raise RuntimeError('Presentation PDF raster-page validation failed.')
    receipt = {
        'reportPages': len(report_reader.pages),
        'presentationPages': len(slide_reader.pages),
        'reportTitleVerified': True,
        'sourceFilenameVerified': True,
        'slideRasterPagesVerified': True,
    }
    with open(data['validationReceipt'], 'w', encoding='utf-8') as stream:
        json.dump(receipt, stream, ensure_ascii=False, separators=(',', ':'))


if __name__ == '__main__':
    try:
        main()
    except Exception as error:
        print('PDF export validation failed: ' + type(error).__name__)
        sys.exit(1)
