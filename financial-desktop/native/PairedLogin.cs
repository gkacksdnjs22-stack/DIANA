using System;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace Diana.Desktop {
 internal sealed partial class PairedForm {
  // Native controls throughout. No embedded browser, remote assets or new auth API.
  sealed class LoginView:Panel {
   readonly LoginHero hero=new LoginHero();readonly LoginCard card=new LoginCard();
   readonly AuthTab login=new AuthTab("로그인"),signup=new AuthTab("회원가입");
   readonly Label title,description,emailLabel,passwordLabel,hint,footer;
   readonly LoginInput email=new LoginInput(false),password=new LoginInput(true);
   readonly BrandButton submit=new BrandButton("로그인",true,false);
   readonly Func<string,string,string,Task> send;
   public readonly Label Feedback;
   public event Action<Control> FocusTarget;
   bool create,sending;
   public LoginView(Func<string,string,string,Task> action){
    send=action;DoubleBuffered=true;BackColor=Canvas;Margin=Padding.Empty;Width=780;
    Controls.Add(hero);Controls.Add(card);
    title=TextLabel("다시 만나 반가워요",19,true,Ink);description=TextLabel("DIANA 계정으로 작업을 이어가세요.",10,false,Muted);
    emailLabel=TextLabel("메일 주소",10,true,Ink);passwordLabel=TextLabel("비밀번호",10,true,Ink);
    hint=TextLabel("비밀번호는 10자 이상 입력해 주세요.",9,false,Muted);
    footer=TextLabel("로그인 다음 단계에서 이 PC를 연결합니다.",9,false,Muted);
    Feedback=TextLabel("",9,false,Color.FromArgb(255,167,163));Feedback.AccessibleName="로그인 안내";
    card.Controls.AddRange(new Control[]{title,description,login,signup,emailLabel,email,passwordLabel,password,hint,submit,Feedback,footer});
    email.Editor.AccessibleName="메일 주소";email.Editor.MaxLength=181;email.Editor.TabIndex=2;
    password.Editor.AccessibleName="비밀번호";password.Editor.MaxLength=200;password.Editor.TabIndex=3;
    login.TabIndex=0;signup.TabIndex=1;submit.TabIndex=4;submit.AccessibleName="로그인";
    login.Click+=delegate{SetMode(false);};signup.Click+=delegate{SetMode(true);};submit.Click+=async delegate{await Send();};
    foreach(Control focus in new Control[]{login,signup,email.Editor,password.Editor,submit})focus.GotFocus+=delegate{if(FocusTarget!=null)FocusTarget(focus);};
    email.Editor.KeyDown+=async delegate(object sender,KeyEventArgs e){if(e.KeyCode==Keys.Enter){e.SuppressKeyPress=true;password.Editor.Focus();await Task.FromResult(0);}};
    password.Editor.KeyDown+=async delegate(object sender,KeyEventArgs e){if(e.KeyCode==Keys.Enter){e.SuppressKeyPress=true;await Send();}};
    SetMode(false);LayoutView();
   }
   Label TextLabel(string text,float size,bool bold,Color color){return new Label{Text=text,AutoSize=false,ForeColor=color,BackColor=SurfaceColor,Font=new Font("맑은 고딕",size,bold?FontStyle.Bold:FontStyle.Regular),UseMnemonic=false};}
   void SetMode(bool value){if(sending)return;create=value;login.Selected=!value;signup.Selected=value;login.Invalidate();signup.Invalidate();
    title.Text=value?"DIANA와 시작해 보세요":"다시 만나 반가워요";
    description.Text=value?"이 PC에서 사용할 계정을 만들어 주세요.":"DIANA 계정으로 작업을 이어가세요.";
    submit.Text=value?"계정 만들기":"로그인";submit.AccessibleName=submit.Text;submit.Invalidate();Feedback.Text="";password.Editor.Clear();}
   public void ClearPassword(){password.Editor.Clear();}
   async Task Send(){if(sending)return;
    if(String.IsNullOrWhiteSpace(email.Editor.Text)){Feedback.Text="메일 주소를 입력해 주세요.";email.Editor.Focus();return;}
    if(password.Editor.Text.Length<10){Feedback.Text="비밀번호는 10자 이상 입력해 주세요.";password.Editor.Focus();return;}
    sending=true;submit.Enabled=login.Enabled=signup.Enabled=email.Enabled=password.Enabled=false;Feedback.Text="연결하고 있습니다…";Feedback.ForeColor=Muted;
    try{await send(create?"signup":"login",email.Editor.Text.Trim(),password.Editor.Text);}
    finally{if(!IsDisposed){sending=false;submit.Enabled=login.Enabled=signup.Enabled=email.Enabled=password.Enabled=true;Feedback.ForeColor=Color.FromArgb(255,167,163);}}
   }
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);if(footer!=null)LayoutView();}
   void LayoutView(){bool wide=Width>=760;int cardWidth=Math.Min(420,Width-8);int cardX=wide?Width-cardWidth:Math.Max(0,(Width-cardWidth)/2);int cardY=wide?14:134;
    hero.Compact=!wide;hero.SetBounds(0,wide?14:0,wide?Math.Max(260,cardX-28):Width,wide?530:116);hero.Invalidate();
    card.SetBounds(cardX,cardY,cardWidth,526);int x=28,w=cardWidth-56;
    title.SetBounds(x,29,w,38);description.SetBounds(x,74,w,24);
    login.SetBounds(x,116,w/2,41);signup.SetBounds(x+w/2,116,w-w/2,41);
    emailLabel.SetBounds(x,180,w,23);email.SetBounds(x,211,w,51);
    passwordLabel.SetBounds(x,280,w,23);password.SetBounds(x,311,w,51);
    hint.SetBounds(x,371,w,23);submit.SetBounds(x,412,w,46);
    Feedback.SetBounds(x,467,w,45);
    footer.BackColor=Canvas;footer.TextAlign=ContentAlignment.MiddleCenter;footer.SetBounds(cardX,cardY+538,cardWidth,36);if(footer.Parent!=this)Controls.Add(footer);
    Height=cardY+581;
   }
  }
  sealed class LoginCard:Panel {
   public LoginCard(){DoubleBuffered=true;BackColor=SurfaceColor;}
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);ClipCorners(this,18);Invalidate();}
   protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Width<40||Height<40)return;e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;using(var shape=Rounded(new Rectangle(1,1,Width-3,Height-3),18))using(var pen=new Pen(Color.FromArgb(53,75,97)))e.Graphics.DrawPath(pen,shape);using(var line=new LinearGradientBrush(new Rectangle(26,1,Width-52,2),Teal,Color.FromArgb(139,132,218),0f))e.Graphics.FillRectangle(line,26,1,Width-52,2);}
  }
  sealed class AuthTab:Button {
   public bool Selected;
   public AuthTab(string text){Text=text;AccessibleName=text;DoubleBuffered=true;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;Cursor=Cursors.Hand;BackColor=SurfaceColor;ForeColor=Ink;Font=new Font("맑은 고딕",10,FontStyle.Bold);}
   protected override void OnPaint(PaintEventArgs e){var g=e.Graphics;g.Clear(SurfaceColor);if(Selected){using(var shape=Rounded(new Rectangle(0,0,Width-1,Height-1),8))using(var fill=new SolidBrush(Color.FromArgb(34,66,81)))g.FillPath(fill,shape);using(var pen=new Pen(Teal,2))g.DrawLine(pen,15,Height-2,Width-15,Height-2);}TextRenderer.DrawText(g,Text,Font,ClientRectangle,Selected?Teal:Muted,TextFormatFlags.VerticalCenter|TextFormatFlags.HorizontalCenter);if(Focused)ControlPaint.DrawFocusRectangle(g,new Rectangle(4,4,Width-8,Height-8),Teal,SurfaceColor);}
  }
  sealed class LoginTextBox:TextBox {
   public string Hint;
   protected override void WndProc(ref Message m){base.WndProc(ref m);if(m.Msg==15&&TextLength==0&&!Focused){using(var g=CreateGraphics())TextRenderer.DrawText(g,Hint,Font,ClientRectangle,Muted,TextFormatFlags.Left|TextFormatFlags.VerticalCenter|TextFormatFlags.NoPadding);}}
   protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);Invalidate();}
  }
  sealed class LoginInput:Panel {
   public readonly LoginTextBox Editor=new LoginTextBox();readonly bool password;readonly Button reveal;
   public LoginInput(bool secret){password=secret;DoubleBuffered=true;BackColor=Color.FromArgb(12,24,40);TabStop=false;
    Editor.BorderStyle=BorderStyle.None;Editor.Font=new Font("맑은 고딕",10.5f);Editor.BackColor=BackColor;Editor.ForeColor=Ink;Editor.UseSystemPasswordChar=secret;Editor.Hint=secret?"비밀번호를 입력하세요":"name@example.com";Controls.Add(Editor);
    Editor.GotFocus+=delegate{Invalidate();};Editor.LostFocus+=delegate{Invalidate();};
    if(secret){reveal=new Button{Text="보기",AccessibleName="비밀번호 표시",FlatStyle=FlatStyle.Flat,BackColor=BackColor,ForeColor=Muted,Font=new Font("맑은 고딕",9),Cursor=Cursors.Hand,TabStop=false};reveal.FlatAppearance.BorderSize=0;Controls.Add(reveal);reveal.Click+=delegate{Editor.UseSystemPasswordChar=!Editor.UseSystemPasswordChar;reveal.Text=Editor.UseSystemPasswordChar?"보기":"숨김";reveal.AccessibleName=Editor.UseSystemPasswordChar?"비밀번호 표시":"비밀번호 숨기기";Editor.Focus();};}
   }
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);if(Editor==null)return;ClipCorners(this,9);Editor.SetBounds(42,Math.Max(8,(Height-Editor.PreferredHeight)/2),Math.Max(40,Width-54-(password?46:0)),Editor.PreferredHeight);if(reveal!=null)reveal.SetBounds(Width-47,8,41,Height-16);}
   protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);Editor.Focus();}
   protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);if(Width<30||Height<30)return;var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;using(var shape=Rounded(new Rectangle(1,1,Width-3,Height-3),9))using(var pen=new Pen(Editor.Focused?Teal:Color.FromArgb(71,96,118),Editor.Focused?2:1))g.DrawPath(pen,shape);int y=(Height-15)/2;using(var pen=new Pen(Editor.Focused?Teal:Muted,1.3f)){if(password){g.DrawArc(pen,17,y-3,10,12,180,180);g.DrawRectangle(pen,14,y+4,16,12);g.DrawLine(pen,22,y+8,22,y+12);}else{g.DrawRectangle(pen,13,y,18,14);g.DrawLine(pen,13,y,22,y+7);g.DrawLine(pen,31,y,22,y+7);}}}
  }
  sealed class LoginHero:Panel {
   readonly Image mark;readonly Font brand=new Font("Segoe UI",24,FontStyle.Bold),headline=new Font("맑은 고딕",24,FontStyle.Bold),copy=new Font("맑은 고딕",11),small=new Font("맑은 고딕",9);
   public bool Compact;
   public LoginHero(){DoubleBuffered=true;BackColor=Canvas;using(var stream=typeof(PairedForm).Assembly.GetManifestResourceStream("diana.png"))using(var image=Image.FromStream(stream))mark=new Bitmap(image);}
   protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;g.InterpolationMode=InterpolationMode.HighQualityBicubic;
    var tile=new Rectangle(Compact?8:3,Compact?20:30,64,64);var previous=g.Save();using(var cut=Rounded(tile,14))g.SetClip(cut);g.DrawImage(mark,tile);g.Restore(previous);
    TextRenderer.DrawText(g,"DIANA",brand,new Point(tile.Right+15,tile.Top-1),Ink,TextFormatFlags.NoPadding);TextRenderer.DrawText(g,"DOCUMENT WORKSPACE",small,new Point(tile.Right+17,tile.Top+43),Muted,TextFormatFlags.NoPadding);
    if(Compact)return;
    TextRenderer.DrawText(g,"내 문서 작업을,\n하나로 이어서.",headline,new Rectangle(0,151,Width,110),Ink,TextFormatFlags.Left|TextFormatFlags.Top|TextFormatFlags.NoPadding);
    TextRenderer.DrawText(g,"PC에서 처리하고\n모바일에서 이어받으세요.",copy,new Rectangle(2,283,Width-4,65),Muted,TextFormatFlags.Left|TextFormatFlags.Top|TextFormatFlags.NoPadding);
    int top=390,w=Math.Min(Width-8,320);using(var shape=Rounded(new Rectangle(1,top,w,87),12))using(var fill=new SolidBrush(Color.FromArgb(16,35,50)))using(var edge=new Pen(Color.FromArgb(40,72,88))){g.FillPath(fill,shape);g.DrawPath(edge,shape);}
    using(var pen=new Pen(Teal,1.5f)){g.DrawRectangle(pen,20,top+24,34,23);g.DrawLine(pen,37,top+47,37,top+55);g.DrawLine(pen,27,top+55,47,top+55);g.DrawRectangle(pen,w-46,top+20,20,35);for(int x=77;x<w-68;x+=15)g.DrawEllipse(pen,x,top+36,3,3);}
    TextRenderer.DrawText(g,"PC",small,new Point(25,top+62),Muted,TextFormatFlags.NoPadding);TextRenderer.DrawText(g,"MOBILE",small,new Point(w-61,top+62),Muted,TextFormatFlags.NoPadding);
    TextRenderer.DrawText(g,"한 번 연결하고, 다음부터 바로.",small,new Rectangle(2,505,Width-4,26),Color.FromArgb(112,181,181),TextFormatFlags.Left|TextFormatFlags.NoPadding);
   }
   protected override void Dispose(bool disposing){if(disposing){mark.Dispose();brand.Dispose();headline.Dispose();copy.Dispose();small.Dispose();}base.Dispose(disposing);}
  }
 }
}
