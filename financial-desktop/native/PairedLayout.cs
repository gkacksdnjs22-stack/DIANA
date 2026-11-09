using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Windows.Forms;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Linq;

namespace Diana.Desktop {
 internal sealed partial class PairedForm {
  Panel rail;PictureBox railLogo;Label railBrand,railCaption,railStatus;NavChoice workChoice,fileChoice,settingsChoice;bool fittingPage;
  sealed class NavChoice:Button {
   public bool Active;
   public NavChoice(string title){
    Text=title;AccessibleName=title;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;
    UseVisualStyleBackColor=false;BackColor=FrameColor;ForeColor=Muted;Cursor=Cursors.Hand;Height=46;
    SetStyle(ControlStyles.UserPaint|ControlStyles.AllPaintingInWmPaint|
     ControlStyles.OptimizedDoubleBuffer|ControlStyles.Opaque|ControlStyles.ResizeRedraw,true);
   }
   protected override void OnPaint(PaintEventArgs e){
    var g=e.Graphics;
    using(var background=new SolidBrush(BackColor))g.FillRectangle(background,ClientRectangle);
    g.SmoothingMode=SmoothingMode.AntiAlias;
    var r=new Rectangle(1,1,Width-3,Height-3);
    if(Active||Focused){
     using(var shape=Rounded(r,9))
     using(var brush=new SolidBrush(Active?Color.FromArgb(25,57,64):SurfaceColor)){
      g.FillPath(brush,shape);
      if(Focused)using(var outline=new Pen(Teal))g.DrawPath(outline,shape);
     }
     if(Active)using(var marker=new SolidBrush(Teal))g.FillRectangle(marker,3,Height/2-9,2,18);
    }
    TextRenderer.DrawText(g,Text,Font,new Rectangle(12,0,Width-24,Height),Active?Teal:Muted,
     TextFormatFlags.VerticalCenter|TextFormatFlags.Left|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);
   }
  }
  void CreateRail(){
   rail=new Panel{Dock=DockStyle.Left,Width=180,BackColor=FrameColor,Visible=false};Controls.Add(rail);
   railLogo=new PictureBox{SizeMode=PictureBoxSizeMode.Zoom};using(var source=typeof(PairedForm).Assembly.GetManifestResourceStream("diana.png"))using(var image=Image.FromStream(source))railLogo.Image=new Bitmap(image);rail.Controls.Add(railLogo);
   railBrand=new Label{Text="DIANA",ForeColor=Ink,AutoSize=false,Font=new Font("Segoe UI",16,FontStyle.Bold)};rail.Controls.Add(railBrand);
   railCaption=new Label{Text="DOCUMENT WORKSPACE",ForeColor=Muted,AutoSize=false,Font=new Font("Segoe UI",7)};rail.Controls.Add(railCaption);
   workChoice=new NavChoice("작업 요청");fileChoice=new NavChoice("보관 파일");settingsChoice=new NavChoice("설정");rail.Controls.AddRange(new Control[]{workChoice,fileChoice,settingsChoice});
   workChoice.Click+=async delegate{if(busy)return;Work();await Perform(RefreshWork);};fileChoice.Click+=async delegate{await Perform(Archive);};settingsChoice.Click+=async delegate{await Perform(SettingsPage);};
   railStatus=new Label{Text="내 PC에서 작업",ForeColor=Muted,AutoSize=false,Font=new Font("맑은 고딕",8)};rail.Controls.Add(railStatus);ClientSizeChanged+=delegate{FitRail();FitPage();};rail.SizeChanged+=delegate{FitRail();};
  }
  void FitRail(){if(rail==null)return;bool narrow=ClientSize.Width<900;rail.Width=narrow?100:180;railLogo.SetBounds(narrow?29:18,25,42,42);railBrand.Visible=railCaption.Visible=!narrow;railBrand.SetBounds(69,26,106,28);railCaption.SetBounds(18,80,155,18);int y=narrow?110:126;workChoice.Text=narrow?"작업":"작업 요청";fileChoice.Text=narrow?"파일":"보관 파일";foreach(var button in new[]{workChoice,fileChoice,settingsChoice}){button.SetBounds(12,y,rail.Width-24,46);button.Invalidate();y+=56;}railStatus.SetBounds(16,Math.Max(310,rail.Height-53),rail.Width-28,36);railStatus.Text=narrow?"내 PC":"내 PC에서 문서 작업";}
  void SelectRail(string id){if(rail==null)return;rail.Visible=new[]{"work","archive","settings","review"}.Contains(id);workChoice.Active=id=="work"||id=="review";fileChoice.Active=id=="archive";settingsChoice.Active=id=="settings";FitRail();}
  sealed class UiCard:FlowLayoutPanel {
   public UiCard(){AutoSize=true;AutoSizeMode=AutoSizeMode.GrowAndShrink;FlowDirection=FlowDirection.TopDown;WrapContents=false;Padding=new Padding(18,14,18,14);Margin=new Padding(0,0,0,12);BackColor=SurfaceColor;Tag="card";DoubleBuffered=true;}
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);ClipCorners(this,12);}
   protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Width<30||Height<30)return;e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;using(var path=Rounded(new Rectangle(1,1,Width-3,Height-3),12))using(var line=new Pen(Edge))e.Graphics.DrawPath(line,path);}
  }
  FlowLayoutPanel Card(FlowLayoutPanel parent){var card=new UiCard();int width=ColumnWidth();card.MinimumSize=new Size(width,0);card.MaximumSize=new Size(width,0);parent.Controls.Add(card);return card;}
  Label Caption(FlowLayoutPanel parent,string text){var label=LabelAt(parent,text);label.ForeColor=Muted;label.Font=new Font(Font.FontFamily,9);return label;}
  void FitCards(Control parent,int width){if(parent==null)return;foreach(Control child in parent.Controls){var card=child as UiCard;if(card!=null){card.MinimumSize=new Size(width,0);card.MaximumSize=new Size(width,0);card.Width=width;foreach(Control inside in card.Controls){if(inside is Label)inside.MaximumSize=new Size(Math.Max(180,width-40),0);if(inside is TextBox||inside is CheckedListBox||inside is ComboBox)inside.Width=Math.Max(200,width-40);}FitCards(card,width-38);}else if(child is FlowLayoutPanel)FitCards(child,width);}}
  bool HasConfirmation(Control parent){if(parent==null)return false;foreach(Control c in parent.Controls){if(c is Button&&(c.Text=="승인 후 저장"||c.Text=="작업 확인"))return true;if(HasConfirmation(c))return true;}return false;}
  void FileCard(FlowLayoutPanel parent,Dictionary<string,object> file,bool deletion){
   var box=Card(parent);var title=LabelAt(box,S(file,"name"));title.Font=new Font(Font.FontFamily,11,FontStyle.Bold);title.Cursor=Cursors.Hand;title.Click+=async delegate{await Perform(()=>OpenFile(file));};
   long length=0;Int64.TryParse(S(file,"bytes"),out length);Caption(box,S(file,"format").ToUpperInvariant()+"  ·  "+(length>0?Math.Max(1,length/1024)+" KB  ·  ":"")+(S(file,"delivered")=="True"?"휴대폰 수신 완료":"PC에 저장됨"));var row=Bar(box);ButtonAt(row,"열기",()=>OpenFile(file));if(S(file,"format")=="pdf")ButtonAt(row,"PPT로 변환",()=>ConvertFile(file));if(deletion)ButtonAt(row,"PC 사본 삭제",async delegate{if(MessageBox.Show("이 PC의 사본을 삭제할까요?\n"+S(file,"name")+"\n\n휴대폰에 받은 사본은 유지됩니다.","파일 삭제",MessageBoxButtons.YesNo)!=DialogResult.Yes)return;await Api(D("op","delete","id",S(file,"id"),"hash",S(file,"sha256"),"confirm",true));await Archive();});
  }
 }
}
