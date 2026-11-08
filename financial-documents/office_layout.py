"""Editable, neutral Office layouts shared by all document operations."""
import io,re,unicodedata
from document_plan import text_blocks

def chunks(text,limit=190):
    """Prefer whitespace boundaries; preserve every non-whitespace character."""
    result=[];part='';size=0
    for token in re.findall(r'\S+\s*|\s+',text):
        cost=sum(2 if unicodedata.east_asian_width(c) in ('W','F') else 1 for c in token)
        if part and size+cost>limit:result.append(part.rstrip());part='';size=0
        for char in token:
            weight=2 if unicodedata.east_asian_width(char) in ('W','F') else 1
            if part and size+weight>limit:result.append(part.rstrip());part='';size=0
            part+=char;size+=weight
    if part.strip():result.append(part.rstrip())
    return result

def render_docx(plan):
    from docx import Document
    from docx.shared import Inches,Pt,RGBColor
    from docx.oxml import OxmlElement
    from docx.oxml.ns import qn
    from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
    d=Document();section=d.sections[0]
    section.top_margin=section.bottom_margin=Inches(.8)
    section.left_margin=section.right_margin=Inches(.85)
    for name,size in [('Normal',10.5),('Title',21),('Heading 1',14),('Heading 2',12),('Heading 3',11)]:
        style=d.styles[name];style.font.name='맑은 고딕';style.font.size=Pt(size);style.font.color.rgb=RGBColor(0,0,0)
        style.element.get_or_add_rPr().rFonts.set(qn('w:eastAsia'),'맑은 고딕')
        style.paragraph_format.space_after=Pt(7);style.paragraph_format.line_spacing=1.25
        if name!='Normal':style.paragraph_format.keep_with_next=True
        for border in style.element.xpath('./w:pPr/w:pBdr'):border.getparent().remove(border)
    if not plan['preserve']:d.add_paragraph(plan['title'],'Title')
    for heading,items in plan['sections']:
        if heading:d.add_heading(heading,1)
        table=plan.get('table')
        if table and heading==table['heading']:
            t=d.add_table(rows=1,cols=4);t.autofit=False
            widths=[2.8,.6,.7,2.4]
            for col,width in zip(t.columns,widths):col.width=Inches(width)
            for cell,width in zip(t.rows[0].cells,widths):cell.width=Inches(width)
            header=t.rows[0]._tr.get_or_add_trPr();header.append(OxmlElement('w:tblHeader'))
            for i,value in enumerate(table['headers']):t.rows[0].cells[i].text=value
            for row in table['rows']:
                cells=t.add_row().cells
                for i,value in enumerate(row):cells[i].text=str(value);cells[i].width=Inches(widths[i])
            for ri,row in enumerate(t.rows):
                for cell in row.cells:
                    cell.vertical_alignment=WD_CELL_VERTICAL_ALIGNMENT.CENTER
                    props=cell._tc.get_or_add_tcPr();shade=OxmlElement('w:shd');shade.set(qn('w:fill'),'E9EDF2' if ri==0 else ('F8F9FB' if ri%2==0 else 'FFFFFF'));props.append(shade)
                    borders=OxmlElement('w:tcBorders')
                    for side in ('top','left','bottom','right'):
                        edge=OxmlElement('w:'+side);edge.set(qn('w:val'),'single');edge.set(qn('w:sz'),'4');edge.set(qn('w:color'),'D9D9D9');borders.append(edge)
                    props.append(borders)
                    for p in cell.paragraphs:
                        p.paragraph_format.space_after=Pt(4);p.paragraph_format.space_before=Pt(4)
                        for run in p.runs:run.bold=ri==0
            d.add_paragraph();continue
        for item in items:
            for kind,value in text_blocks(item):
                if kind.startswith('heading'):d.add_heading(value,int(kind[-1]))
                else:d.add_paragraph(value)
    stream=io.BytesIO();d.core_properties.author='';d.save(stream);return stream.getvalue()

def render_pptx(plan):
    from pptx import Presentation
    from pptx.util import Inches,Pt
    from pptx.dml.color import RGBColor
    p=Presentation();p.slide_width=Inches(13.33);p.slide_height=Inches(7.5);p.core_properties.author=''
    def box(slide,x,y,w,h,text,size,color='253042',bold=False):
        frame=slide.shapes.add_textbox(Inches(x),Inches(y),Inches(w),Inches(h)).text_frame
        frame.word_wrap=True;frame.margin_left=frame.margin_right=Pt(0)
        para=frame.paragraphs[0];para.line_spacing=1.15;run=para.add_run();run.text=text
        run.font.name='맑은 고딕';run.font.size=Pt(size);run.font.bold=bold;run.font.color.rgb=RGBColor.from_string(color)
    def slide(heading,only_title=False):
        s=p.slides.add_slide(p.slide_layouts[6]);fill=s.background.fill;fill.solid();fill.fore_color.rgb=RGBColor(255,255,255)
        if not plan['preserve'] and not only_title and heading!=plan['title']:box(s,.65,.25,12,.65,plan['title'],11 if len(plan['title'])>100 else 14,'657080')
        if heading:box(s,.65,1.2 if only_title else .95,12,4.8 if only_title else .95,heading,27 if only_title else 20 if len(heading)>55 else 27,bold=True)
        return s
    for heading,items in plan['sections']:
        table=plan.get('table')
        if table and heading==table['heading']:
            rows=[]
            for row in table['rows']:
                for value in chunks(str(row[3]),50):rows.append(list(row[:3])+[value])
            for start in range(0,len(rows),6):
                selected=rows[start:start+6];s=slide(heading)
                t=s.shapes.add_table(len(selected)+1,4,Inches(.65),Inches(2),Inches(12),Inches(.6*(len(selected)+1))).table
                for col,width in zip(t.columns,[5.2,1,1.2,4.6]):col.width=Inches(width)
                for ri,row in enumerate([table['headers']]+selected):
                    for ci,value in enumerate(row):
                        cell=t.cell(ri,ci);cell.text=str(value);cell.margin_top=cell.margin_bottom=Pt(3)
                        cell.fill.solid();cell.fill.fore_color.rgb=RGBColor.from_string('E9EDF2' if ri==0 else 'FFFFFF')
                        for para in cell.text_frame.paragraphs:
                            for run in para.runs:run.font.name='맑은 고딕';run.font.size=Pt(14);run.font.bold=ri==0;run.font.color.rgb=RGBColor.from_string('253042')
            continue
        packets=[];current_heading=heading
        def emit():
            nonlocal packets
            if not packets:
                if current_heading:slide(current_heading)
                return
            for start in range(0,len(packets),3):
                s=slide(current_heading)
                for i,value in enumerate(packets[start:start+3]):box(s,.7,2.05+1.55*i,12,1.48,value,19)
            packets=[]
        for item in items:
            for kind,value in text_blocks(item):
                if kind.startswith('heading'):emit();current_heading=value
                else:
                    for line in value.splitlines():packets.extend(chunks(line))
        emit()
    if not p.slides:slide(plan['title'],only_title=True)
    stream=io.BytesIO();p.save(stream);return stream.getvalue()
