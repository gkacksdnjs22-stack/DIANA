using System;
using System.IO;
using System.Net;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Linq;
using System.Text;
using System.Collections.Generic;
using System.Threading.Tasks;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Web.Script.Serialization;
using System.Windows.Forms;

namespace Diana.Desktop {
 internal sealed partial class PairedForm:Form {

  static readonly Color Ink=Color.FromArgb(228,239,248), Muted=Color.FromArgb(155,172,194), Teal=Color.FromArgb(76,224,214), Canvas=Color.FromArgb(10,18,32), SurfaceColor=Color.FromArgb(19,35,56);
  static GraphicsPath Rounded(Rectangle bounds,int radius){
   int n=radius*2;var shape=new GraphicsPath();shape.AddArc(bounds.Left,bounds.Top,n,n,180,90);shape.AddArc(bounds.Right-n,bounds.Top,n,n,270,90);shape.AddArc(bounds.Right-n,bounds.Bottom-n,n,n,0,90);shape.AddArc(bounds.Left,bounds.Bottom-n,n,n,90,90);shape.CloseFigure();return shape;}
  static void ClipCorners(Control control,int radius){if(control.Width<2*radius||control.Height<2*radius)return;var previous=control.Region;using(var shape=Rounded(new Rectangle(0,0,control.Width-1,control.Height-1),radius))control.Region=new Region(shape);if(previous!=null)previous.Dispose();}
  sealed class ComposerPanel:FlowLayoutPanel {
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);ClipCorners(this,13);}
  }
  [DllImport("dwmapi.dll")]static extern int DwmSetWindowAttribute(IntPtr hwnd,int attr,ref int value,int size);
  protected override void OnHandleCreated(EventArgs e){base.OnHandleCreated(e);int dark=1;try{DwmSetWindowAttribute(Handle,20,ref dark,4);}catch(DllNotFoundException){}catch(EntryPointNotFoundException){}}
  sealed class BrandHeader:Panel {
   readonly Image mark;readonly Font word=new Font("Segoe UI",22,FontStyle.Bold);readonly Font caption=new Font("맑은 고딕",10);readonly string section;
   public BrandHeader(string name){section=name;DoubleBuffered=true;Margin=new Padding(0,0,0,18);Height=84;AccessibleName="DIANA "+name;
    using(var stream=typeof(PairedForm).Assembly.GetManifestResourceStream("diana.png"))using(var original=Image.FromStream(stream))mark=new Bitmap(original);}
   protected override void OnPaint(PaintEventArgs e){base.OnPaint(e);var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;TextRenderer.DrawText(g,"DIANA / WORKSPACE",caption,new Point(0,3),Muted,TextFormatFlags.NoPadding);TextRenderer.DrawText(g,section,word,new Rectangle(0,28,Width,47),Ink,TextFormatFlags.NoPadding|TextFormatFlags.EndEllipsis);}
   protected override void Dispose(bool disposing){if(disposing){mark.Dispose();word.Dispose();caption.Dispose();}base.Dispose(disposing);}
  }
  sealed class BrandButton:Button {
   readonly bool primary,file;bool over,down;public BrandButton(string label,bool main,bool isFile){Text=label;primary=main;file=isFile;AccessibleName=label;FlatStyle=FlatStyle.Flat;FlatAppearance.BorderSize=0;UseVisualStyleBackColor=false;BackColor=Canvas;ForeColor=Ink;Cursor=Cursors.Hand;DoubleBuffered=true;AutoSize=false;TabStop=true;Height=file?58:42;Width=Math.Max(86,TextRenderer.MeasureText(label,Font).Width+(file?76:34));Margin=new Padding(0,2,8,5);}
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);ClipCorners(this,9);}
   protected override void OnMouseEnter(EventArgs e){over=true;Invalidate();base.OnMouseEnter(e);} protected override void OnMouseLeave(EventArgs e){over=down=false;Invalidate();base.OnMouseLeave(e);}protected override void OnMouseDown(MouseEventArgs e){down=true;Invalidate();base.OnMouseDown(e);}protected override void OnMouseUp(MouseEventArgs e){down=false;Invalidate();base.OnMouseUp(e);}
   protected override void OnPaint(PaintEventArgs e){var g=e.Graphics;g.SmoothingMode=SmoothingMode.AntiAlias;var r=new Rectangle(1,1,Width-3,Height-3);using(var shape=Rounded(r,9))using(var fill=new LinearGradientBrush(r,primary?(down?Color.FromArgb(49,181,174):Teal):(over?Color.FromArgb(40,62,84):Color.FromArgb(28,48,70)),primary?Teal:Color.FromArgb(28,48,70),90f))using(var edge=new Pen(primary||Focused?Teal:Color.FromArgb(59,82,108))){g.FillPath(fill,shape);g.DrawPath(edge,shape);}
    if(file){var x=15;var y=(Height-17)/2;using(var pen=new Pen(Teal,1.4f)){g.DrawPolygon(pen,new Point[]{new Point(x,y),new Point(x+8,y),new Point(x+13,y+5),new Point(x+13,y+16),new Point(x,y+16)});g.DrawLine(pen,x+3,y+10,x+9,y+10);} }
    var content=new Rectangle(file?40:6,1,Width-(file?54:12),Height-3);TextRenderer.DrawText(g,Text,Font,content,primary?Color.FromArgb(7,42,44):Ink,TextFormatFlags.VerticalCenter|(file?TextFormatFlags.Left:TextFormatFlags.HorizontalCenter)|TextFormatFlags.EndEllipsis|TextFormatFlags.NoPrefix);}
  }
  static readonly Color EntryFill=Color.FromArgb(14,27,43),EntryInk=Color.FromArgb(228,239,248),EntryHint=Color.FromArgb(155,172,194);
  sealed class EntryFrame:Panel {
   readonly TextBox editor;
   public EntryFrame(TextBox input) {
    editor=input;DoubleBuffered=true;TabStop=false;BackColor=EntryFill;
    Padding=new Padding(13,10,13,10);Margin=new Padding(1,7,0,7);Height=82;
    editor.Dock=DockStyle.Fill;Controls.Add(editor);
    editor.GotFocus+=delegate{Invalidate();};editor.LostFocus+=delegate{Invalidate();};
   }
   protected override void OnMouseDown(MouseEventArgs e){base.OnMouseDown(e);editor.Focus();}
   protected override void OnSizeChanged(EventArgs e){base.OnSizeChanged(e);ClipCorners(this,8);}
   protected override void OnPaint(PaintEventArgs e){
    base.OnPaint(e);if(Width<20||Height<20)return;
    e.Graphics.SmoothingMode=SmoothingMode.AntiAlias;
    using(var outline=Rounded(new Rectangle(2,2,Width-5,Height-5),7))
    using(var stroke=new Pen(editor.Focused?Color.FromArgb(16,157,151):Color.FromArgb(135,162,183),editor.Focused?3f:2f))
     e.Graphics.DrawPath(stroke,outline);
   }
  }
  sealed class RequestField:TextBox {
   protected override void WndProc(ref Message m){base.WndProc(ref m);if(m.Msg==15&&TextLength==0&&!Focused){using(var g=CreateGraphics()){TextRenderer.DrawText(g,"어떤 문서 작업을 할까요?",Font,ClientRectangle,EntryHint,TextFormatFlags.Top|TextFormatFlags.Left|TextFormatFlags.NoPadding);}}}
   protected override void OnLostFocus(EventArgs e){base.OnLostFocus(e);Invalidate();}
  }
  BrandHeader header;FlowLayoutPanel nav,composer;
  int ColumnWidth(){return Math.Max(290,Math.Min(900,body.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-56));}
  void FitPage(){if(fittingPage)return;fittingPage=true;try{if(screen=="login"&&loginView!=null&&!loginView.IsDisposed&&loginHost!=null){FitLogin();return;}if(header==null||header.IsDisposed)return;int w=ColumnWidth();int inset=Math.Max(20,(body.ClientSize.Width-SystemInformation.VerticalScrollBarWidth-w)/2);var pad=new Padding(inset,22,20,26);if(body.Padding!=pad)body.Padding=pad;header.Width=w;header.Height=84;if(composer!=null&&!composer.IsDisposed){composer.Width=w;composer.Height=254;if(request!=null&&!request.IsDisposed)request.Parent.Width=w-42;}if(items!=null&&!items.IsDisposed){items.MinimumSize=new Size(w,0);items.MaximumSize=new Size(w,0);}FitCards(body,w);}finally{fittingPage=false;}}
  readonly JavaScriptSerializer json=new JavaScriptSerializer{MaxJsonLength=16000000};
  string origin,owner,token,state,fixture,root,accountToken,ticket,ticketText,signature="",screen="",draftText="";
  Process process; bool busy,polling,closing; Timer timer=new Timer{Interval=1500};
  FlowLayoutPanel body,items; TextBox request; Label note;
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath(ref Guid id,uint flags,IntPtr token,out IntPtr value);
  static string Known(string id){Guid g=new Guid(id);IntPtr ptr;if(SHGetKnownFolderPath(ref g,0,IntPtr.Zero,out ptr)!=0)throw new IOException("Windows 문서 폴더를 확인하지 못했습니다.");try{return Marshal.PtrToStringUni(ptr);}finally{Marshal.FreeCoTaskMem(ptr);}}
  public PairedForm(string directory,string test){root=directory;fixture=test;Text=BuildVersion.MainTitle;try{Icon=Icon.ExtractAssociatedIcon(Application.ExecutablePath);}catch{}Width=1100;Height=780;MinimumSize=new Size(640,500);
   Font=new Font("맑은 고딕",10);BackColor=Canvas;ForeColor=Ink;StartPosition=FormStartPosition.CenterScreen;
   body=new FlowLayoutPanel{Dock=DockStyle.Fill,AutoScroll=true,FlowDirection=FlowDirection.TopDown,WrapContents=false,Padding=new Padding(22)};Controls.Add(body);CreateRail();body.ClientSizeChanged+=delegate{FitPage();};
   timer.Tick+=async delegate{if(!busy&&!polling&&screen=="work"){polling=true;try{await RefreshWork();}catch(Exception e){if(note!=null)note.Text=e.Message;}finally{polling=false;}}};
   Shown+=async delegate{await Perform(StartWithRecovery);};FormClosing+=delegate{closing=true;timer.Stop();StopHost();};}
  static Dictionary<string,object> D(params object[] args){var d=new Dictionary<string,object>();for(int i=0;i<args.Length;i+=2)d[(string)args[i]]=args[i+1];return d;}
  static string S(Dictionary<string,object> d,string k){return d.ContainsKey(k)&&d[k]!=null?d[k].ToString():"";}
  static IEnumerable<Dictionary<string,object>> Rows(Dictionary<string,object> d,string k){return ((System.Collections.IEnumerable)d[k]).Cast<Dictionary<string,object>>();}
  sealed class Expired:IOException{ public Expired(string text):base(text){} }
  void StopHost(){if(process==null)return;try{if(!process.HasExited)process.StandardInput.Close();}catch(InvalidOperationException){}catch(IOException){}process.Dispose();process=null;}
  async Task StartWithRecovery(){
   try{await Start();}
   catch(Exception e){StopHost();origin=owner=null;timer.Stop();Page("startup-error","DIANA  ·  연결 확인");
    note.Text=e is IOException?e.Message:"PC 연결 서비스를 시작하지 못했습니다. 실행 파일과 설정을 확인한 뒤 다시 시도하세요.";
    ButtonAt(body,"다시 시도",StartWithRecovery);ButtonAt(body,"닫기",delegate{Close();return Task.FromResult(0);});}
  }
  async Task Start(){
   var known=D("desktop",Known("B4BFCC3A-DB2C-424C-B029-7FE99A87C641"),"documents",Known("FDD39AD0-238F-46AF-ADB4-6C85480369C7"),"downloads",Known("374DE290-123F-4565-9164-39C4925E467B"));
   if(fixture!=null){Directory.CreateDirectory(fixture);File.WriteAllText(Path.Combine(fixture,"known-folders.json"),json.Serialize(known));foreach(var k in known.Keys.ToArray()){known[k]=Path.Combine(fixture,k);Directory.CreateDirectory((string)known[k]);}}
   state=fixture!=null?Path.Combine(fixture,@"AppData\Local\DIANA\paired-dev"):Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DIANA","paired-dev");Directory.CreateDirectory(state);
   var si=new ProcessStartInfo(Path.Combine(root,@"runtime\node\node.exe"),"\""+Path.Combine(root,@"app\financial-desktop\paired-host.mjs")+"\""){UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardInput=true,RedirectStandardError=true,WorkingDirectory=root,StandardOutputEncoding=Encoding.UTF8};
   si.EnvironmentVariables.Remove("NODE_OPTIONS");si.EnvironmentVariables.Remove("NODE_PATH");
   process=Process.Start(si);process.ErrorDataReceived+=delegate{};process.BeginErrorReadLine();var cfg=D("state",state,"known",known,"python",Path.Combine(root,@"runtime\python\python.exe"),"port",fixture!=null?0:43871);
   var line=json.Serialize(cfg);var raw=Encoding.UTF8.GetBytes(line+"\n");process.StandardInput.BaseStream.Write(raw,0,raw.Length);process.StandardInput.BaseStream.Flush();
   var reading=process.StandardOutput.ReadLineAsync();if(await Task.WhenAny(reading,Task.Delay(20000))!=reading)throw new IOException("PC 연결 서비스의 시작 응답이 지연됩니다. 잠시 뒤 다시 시도하세요.");
   var hello=await reading;if(hello==null)throw new IOException("PC 연결 서비스를 시작하지 못했습니다. 실행 파일과 설정을 확인하세요.");var h=json.Deserialize<Dictionary<string,object>>(hello);
   if(S(h,"type")=="startup-error")throw new IOException(S(h,"message"));origin=S(h,"origin");owner=S(h,"owner");
   Uri local;if(!Uri.TryCreate(origin,UriKind.Absolute,out local)||local.Scheme!="http"||local.Host!="127.0.0.1"||owner.Length!=64)throw new IOException("PC 연결 서비스의 시작 응답을 확인하지 못했습니다.");
   if(File.Exists(Path.Combine(state,"session.bin")))try{token=Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(Path.Combine(state,"session.bin")),null,DataProtectionScope.CurrentUser));await Api(D("op","state"));Work();return;}catch(Expired){token=null;}catch(CryptographicException){token=null;}Login();}
  async Task<Dictionary<string,object>> Api(Dictionary<string,object> data){
   var r=(HttpWebRequest)WebRequest.Create(origin+"/v1");r.Method="POST";r.Proxy=null;r.AllowAutoRedirect=false;r.ContentType="application/json";r.Headers["X-Local-Owner"]=owner;if(!String.IsNullOrEmpty(token))r.Headers["Authorization"]="Bearer "+token;
   byte[] b=Encoding.UTF8.GetBytes(json.Serialize(data));using(var s=await r.GetRequestStreamAsync())await s.WriteAsync(b,0,b.Length);
   try{using(var a=await r.GetResponseAsync())using(var reader=new StreamReader(a.GetResponseStream(),Encoding.UTF8))return json.Deserialize<Dictionary<string,object>>(await reader.ReadToEndAsync());}
   catch(WebException e){if(e.Response==null)throw new IOException("PC 연결이 끊겼습니다. 다시 시도하세요.");using(var reader=new StreamReader(e.Response.GetResponseStream())){string msg=S(json.Deserialize<Dictionary<string,object>>(reader.ReadToEnd()),"error");if(((HttpWebResponse)e.Response).StatusCode==HttpStatusCode.Unauthorized)throw new Expired(msg);throw new IOException(msg);}}}
  async Task Perform(Func<Task> action){if(busy)return;busy=true;try{await action();}catch(Exception e){if(!closing){if(note==null||note.IsDisposed)note=LabelAt(body,"");note.Text=e.Message;}}finally{busy=false;}}
  void Page(string id,string title){screen=id;SelectRail(id);signature="";nav=null;composer=null;items=null;if(loginHost!=null){var owned=loginHost;loginHost=null;owned.Dispose();}body.Visible=true;
   body.SuspendLayout();while(body.Controls.Count>0)body.Controls[0].Dispose();header=new BrandHeader(title.Replace("DIANA  ·  ",""));body.Controls.Add(header);
   note=LabelAt(body,"");note.ForeColor=Teal;note.Visible=false;note.TextChanged+=delegate{note.Visible=note.Text.Length>0;};FitPage();body.ResumeLayout(true);}
  Label LabelAt(FlowLayoutPanel p,string s){var x=new Label{Text=s,AutoSize=true,MaximumSize=new Size(Math.Max(270,ColumnWidth()-26),0),ForeColor=Ink,Margin=new Padding(1,5,3,6)};p.Controls.Add(x);return x;}
  TextBox Field(FlowLayoutPanel p,bool password=false){var x=new TextBox{Width=Math.Min(450,ColumnWidth()-15),BackColor=Color.FromArgb(16,30,48),ForeColor=Ink,BorderStyle=BorderStyle.FixedSingle,Margin=new Padding(1,2,3,10),UseSystemPasswordChar=password};p.Controls.Add(x);return x;}
  Button ButtonAt(FlowLayoutPanel p,string text,Func<Task> click){bool main=text=="보내기"||text=="로그인"||text=="이 PC 등록"||text=="승인 후 저장"||text=="작업 확인"||text=="선택 확인";var x=new BrandButton(text,main,Path.HasExtension(text));x.Click+=async delegate{await Perform(click);};p.Controls.Add(x);return x;}
  FlowLayoutPanel Bar(FlowLayoutPanel p){var x=new FlowLayoutPanel{AutoSize=true,MaximumSize=new Size(Math.Max(290,ColumnWidth()),0),Margin=new Padding(0,3,0,4),BackColor=p.BackColor};p.Controls.Add(x);return x;}
  LoginView loginView;Panel loginHost;VScrollBar loginScroll;bool fittingLogin;
  void FitLogin(){if(fittingLogin||loginHost==null||loginScroll==null)return;fittingLogin=true;try{
   int width=Math.Max(280,Math.Min(1040,loginHost.ClientSize.Width-48-(loginScroll.Visible?loginScroll.Width:0)));loginView.Width=width;
   bool scroll=loginView.Height+32>loginHost.ClientSize.Height;if(scroll!=loginScroll.Visible){loginScroll.Visible=scroll;width=Math.Max(280,Math.Min(1040,loginHost.ClientSize.Width-48-(scroll?loginScroll.Width:0)));loginView.Width=width;}
   int overflow=Math.Max(0,loginView.Height+32-loginHost.ClientSize.Height);loginScroll.LargeChange=100;loginScroll.SmallChange=40;loginScroll.Maximum=overflow+99;if(loginScroll.Value>overflow)loginScroll.Value=overflow;
   int available=loginHost.ClientSize.Width-(loginScroll.Visible?loginScroll.Width:0);loginView.Left=Math.Max(16,(available-width)/2);loginView.Top=overflow>0?16-loginScroll.Value:Math.Max(16,(loginHost.ClientSize.Height-loginView.Height)/2);
  }finally{fittingLogin=false;}}
  void EnsureLoginVisible(Control target){if(loginScroll==null||!loginScroll.Visible||target.IsDisposed)return;var point=loginView.PointToClient(target.PointToScreen(Point.Empty));int y=point.Y+loginView.Top,delta=y<16?y-16:y+target.Height>loginHost.ClientSize.Height-16?y+target.Height-loginHost.ClientSize.Height+16:0;if(delta!=0)loginScroll.Value=Math.Max(0,Math.Min(loginScroll.Maximum-loginScroll.LargeChange+1,loginScroll.Value+delta));}
  void Login(){Page("login","DIANA  ·  계정 연결");body.SuspendLayout();while(body.Controls.Count>0)body.Controls[0].Dispose();header=null;
   loginView=new LoginView(async delegate(string op,string email,string password){await Perform(async delegate{var r=await Api(D("op",op,"email",email,"password",password));loginView.ClearPassword();accountToken=S(r,"token");token=accountToken;
    Page("register","현재 PC 연결");LabelAt(body,"이 계정에서 이 PC의 문서 작업을 사용할 수 있습니다.");ButtonAt(body,"이 PC 등록",async delegate{var v=await Api(D("op","register"));token=S(v,"token");File.WriteAllBytes(Path.Combine(state,"session.bin"),ProtectedData.Protect(Encoding.UTF8.GetBytes(token),null,DataProtectionScope.CurrentUser));Work();await RefreshWork();});});});
   loginHost=new Panel{Dock=DockStyle.Fill,AutoScroll=false,BackColor=Canvas};loginScroll=new VScrollBar{Dock=DockStyle.Right,Visible=false};loginHost.Controls.Add(loginView);loginHost.Controls.Add(loginScroll);loginScroll.ValueChanged+=delegate{FitLogin();};loginHost.ClientSizeChanged+=delegate{FitPage();};loginHost.MouseWheel+=delegate(object sender,MouseEventArgs e){if(loginScroll.Visible)loginScroll.Value=Math.Max(0,Math.Min(loginScroll.Maximum-loginScroll.LargeChange+1,loginScroll.Value-e.Delta/3));};loginView.FocusTarget+=EnsureLoginVisible;body.Visible=false;Controls.Add(loginHost);loginHost.BringToFront();note=loginView.Feedback;FitPage();body.ResumeLayout(true);}
  async Task Job(params object[] args){var d=D(args);d["op"]="job";if(!d.ContainsKey("requestId"))d["requestId"]=Guid.NewGuid().ToString();var v=await Api(d);if(S(v,"notice")!="")note.Text=S(v,"notice");signature="";await RefreshWork();}
  void Work(){Page("work","문서 작업");
   composer=new ComposerPanel{BackColor=SurfaceColor,FlowDirection=FlowDirection.TopDown,WrapContents=false,AutoSize=false,Height=254,Padding=new Padding(19,14,16,14),Margin=new Padding(0,0,0,16)};
   composer.Paint+=delegate(object sender,PaintEventArgs e){var c=(Control)sender;using(var line=new LinearGradientBrush(new Rectangle(0,0,c.Width,2),Teal,Color.FromArgb(142,133,215),0f))e.Graphics.FillRectangle(line,0,0,c.Width,2);};body.Controls.Add(composer);
   var label=LabelAt(composer,"무엇을 만들까요?");label.Font=new Font(Font.FontFamily,17,FontStyle.Bold);Caption(composer,"PC 자료를 찾아 요약하거나 새 문서를 요청하세요.");
   request=new RequestField{Text=draftText,Multiline=true,BorderStyle=BorderStyle.None,BackColor=EntryFill,ForeColor=EntryInk};
   var entryFrame=new EntryFrame(request){Width=ColumnWidth()-42,Height=110};composer.Controls.Add(entryFrame);request.AccessibleName="문서 요청";request.TextChanged+=async delegate{draftText=request.Text;if(!busy&&request.Text.Length>0&&screen=="work"&&items!=null&&HasConfirmation(items))await Perform(async delegate{await Job("action","desk-invalidate");});};var bar=Bar(composer);
   ButtonAt(bar,"보내기",async delegate{if(request.Text.Trim()=="")return;if(ticketText!=request.Text||ticket==null){ticket=Guid.NewGuid().ToString();ticketText=request.Text;}await Job("action","desk-start","id",ticket,"text",ticketText);request.Clear();ticket=null;});
   ButtonAt(bar,"파일 첨부",async delegate{using(var f=new OpenFileDialog{Filter="모든 파일 (*.*)|*.*|문서 (*.txt;*.md;*.json;*.pptx;*.docx)|*.txt;*.md;*.json;*.pptx;*.docx",FilterIndex=1,CheckFileExists=true,RestoreDirectory=true}){if(f.ShowDialog()!=DialogResult.OK)return;if(new FileInfo(f.FileName).Length>8000000)throw new IOException("첨부 한도를 넘었습니다.");var b=File.ReadAllBytes(f.FileName);using(var sha=SHA256.Create())await Job("action","desk-upload","name",Path.GetFileName(f.FileName),"base64",Convert.ToBase64String(b),"sha256",BitConverter.ToString(sha.ComputeHash(b)).Replace("-","").ToLowerInvariant());}});
   items=new FlowLayoutPanel{AutoSize=true,FlowDirection=FlowDirection.TopDown,WrapContents=false};items.Margin=Padding.Empty;body.Controls.Add(items);FitPage();timer.Start();}
  async Task RefreshWork(){var v=await Api(D("op","state"));RenderWork(v);}
  void RenderWork(Dictionary<string,object> v){if(screen!="work"||closing)return;string sig=json.Serialize(v);if(sig==signature)return;signature=sig;while(items.Controls.Count>0)items.Controls[0].Dispose();
   foreach(var j in Rows(v,"jobs")){var jobCard=Card(items);string id=S(j,"id"),st=S(j,"status");if(st=="approval"){LabelAt(jobCard,"저장 전 미리보기");var text=Field(jobCard);text.Multiline=true;text.ReadOnly=true;text.ScrollBars=ScrollBars.Vertical;text.Height=170;text.Width=480;text.Text=S(j,"preview");ButtonAt(jobCard,"승인 후 저장",()=>Job("action","desk-approve","id",id,"nonce",S(j,"nonce")));}
   else if(st=="question"){LabelAt(jobCard,"작성할 내용을 입력하세요.");var t=Field(jobCard);ButtonAt(jobCard,"내용 확인",()=>Job("action","desk-answer","id",id,"answer",t.Text));}
   else if(st=="choose"){LabelAt(jobCard,"사용할 자료를 선택하세요.");var choices=new CheckedListBox{Width=500,Height=90,HorizontalScrollbar=true,CheckOnClick=true};var rows=Rows(j,"choices").ToArray();foreach(var c in rows)choices.Items.Add(S(c,"name")+"  ·  "+S(c,"modified")+"  ·  "+S(c,"location"));jobCard.Controls.Add(choices);ButtonAt(jobCard,"선택 확인",()=>Job("action","desk-select","id",id,"ids",choices.CheckedIndices.Cast<int>().Select(i=>S(rows[i],"id")).ToArray()));}
   else if(st=="failed"||st=="saving"){LabelAt(jobCard,st=="failed"?S(j,"error"):"저장 확인 중");ButtonAt(jobCard,"다시 시도",()=>Job("action","desk-retry","id",id));}else LabelAt(jobCard,"자료 읽는 중");if(st!="saving")ButtonAt(jobCard,"중단",()=>Job("action","desk-cancel","id",id));}
   var legacy=v["legacy"] as Dictionary<string,object>;if(legacy!=null&&legacy.ContainsKey("uncertain")&&legacy["uncertain"]!=null)ButtonAt(items,"기존 저장 결과 확인",()=>Job("action","recover"));if(legacy!=null&&legacy.ContainsKey("review")&&legacy["review"] is System.Collections.IEnumerable){var result=legacy["review"] as System.Collections.IEnumerable;foreach(var entry in result){var row=entry as Dictionary<string,object>;if(row!=null)LabelAt(items,S(row,"label")+"  "+S(row,"status"));}}if(legacy!=null&&S(legacy,"question")!="")LabelAt(items,S(legacy,"question"));if(legacy!=null&&legacy.ContainsKey("awaiting")&&legacy["awaiting"]!=null)ButtonAt(items,"검토 자료 확인",ReviewMaterials);if(legacy!=null&&legacy.ContainsKey("pending")&&legacy["pending"] is Dictionary<string,object>){var p=(Dictionary<string,object>)legacy["pending"];LabelAt(items,S(p,"summary"));var plan=p["plan"] as Dictionary<string,object>;if(plan!=null&&S(plan,"diff")!=""){var preview=Field(items);preview.Multiline=true;preview.Height=90;preview.ReadOnly=true;preview.Text=S(plan,"diff");}ButtonAt(items,"작업 확인",()=>Job("action","approve","planId",S(p,"id"),"revision",p["revision"],"confirmed",true));}
   var files=Rows(v,"files").Take(3).ToArray();if(files.Length>0){var title=LabelAt(items,"최근 파일");title.Font=new Font(Font.FontFamily,12,FontStyle.Bold);foreach(var f in files)FileCard(items,f,false);}else if(!Rows(v,"jobs").Any())Caption(items,"만든 파일은 ‘보관 파일’에 모아둘게요.");FitPage();}


  ComboBox Pick(FlowLayoutPanel panel,Dictionary<string,object>[] list){var box=new ComboBox{DropDownStyle=ComboBoxStyle.DropDownList,Width=490};foreach(var r in list)box.Items.Add(S(r,"name")+"   "+S(r,"path"));if(list.Length==1)box.SelectedIndex=0;panel.Controls.Add(box);return box;}
  async Task ReviewMaterials(){var options=await Api(D("op","review-options"));Page("review","검토 자료 확인");ButtonAt(body,"작업 화면",async delegate{Work();await RefreshWork();});var guides=Rows(options,"guides").ToArray();var docs=Rows(options,"docs").ToArray();if(guides.Length==0||docs.Length<2){LabelAt(body,"허용 폴더에 검토 지침 JSON과 대상 및 근거 파일이 필요합니다.");return;}LabelAt(body,"적용 지침");var guide=Pick(body,guides);LabelAt(body,"검토 대상");var target=Pick(body,docs);var fields=new FlowLayoutPanel{AutoSize=true,FlowDirection=FlowDirection.TopDown};body.Controls.Add(fields);var sources=new List<ComboBox>();Action draw=delegate{fields.Controls.Clear();sources.Clear();if(guide.SelectedIndex<0)return;foreach(var code in (System.Collections.IEnumerable)guides[guide.SelectedIndex]["codes"]){LabelAt(fields,"근거  "+code);sources.Add(Pick(fields,docs));}};guide.SelectedIndexChanged+=delegate{draw();};draw();ButtonAt(body,"이 자료로 검토 계획",async delegate{if(guide.SelectedIndex<0||target.SelectedIndex<0||sources.Any(c=>c.SelectedIndex<0))throw new IOException("대상과 근거를 확인하세요.");await Api(D("op","review-connect","guide",S(guides[guide.SelectedIndex],"id"),"target",S(docs[target.SelectedIndex],"id"),"sources",sources.Select(c=>S(docs[c.SelectedIndex],"id")).ToArray()));Work();await RefreshWork();});}
  async Task ConvertFile(Dictionary<string,object> f){Work();await Job("action","desk-convert","id",Guid.NewGuid().ToString(),"sourceId",S(f,"id"),"format","ppt");}
  async Task OpenFile(Dictionary<string,object> f){await Api(D("op","file","id",S(f,"id")));Process.Start(new ProcessStartInfo(S(f,"location")){UseShellExecute=true});}
  Task Archive(){return ArchivePage(0);}
  async Task ArchivePage(int offset){var v=await Api(D("op","state","offset",offset));RenderArchive(v,offset);}
  void RenderArchive(Dictionary<string,object> v,int offset){Page("archive","보관 파일");Caption(body,"저장한 결과를 열거나 PC 사본을 관리하세요.");var files=Rows(v,"files").ToArray();if(files.Length==0){var empty=Card(body);var title=LabelAt(empty,"아직 저장한 파일이 없어요");title.Font=new Font(Font.FontFamily,13,FontStyle.Bold);Caption(empty,"작업 결과를 확인하고 저장하면 여기에 표시됩니다.");}foreach(var f in files)FileCard(body,f,true);var row=Bar(body);if(offset>0)ButtonAt(row,"이전 파일",()=>ArchivePage(Math.Max(0,offset-20)));if((bool)v["more"])ButtonAt(row,"다음 파일",()=>ArchivePage(offset+20));FitPage();}
  async Task SettingsPage(){var v=await Api(D("op","settings"));RenderSettings(v);}
  void RenderSettings(Dictionary<string,object> v){Page("settings","설정");
   var pair=Card(body);var h=LabelAt(pair,"휴대폰 연결");h.Font=new Font(Font.FontFamily,13,FontStyle.Bold);Caption(pair,"모바일 DIANA에 6자리 코드를 입력하세요.");var code=LabelAt(pair,"••••••");code.Font=new Font("Consolas",28,FontStyle.Bold);code.ForeColor=Teal;var buttons=Bar(pair);ButtonAt(buttons,"연결 코드 만들기",async delegate{note.Text="연결 코드를 만드는 중입니다.";var r=await Api(D("op","code"));code.Text=S(r,"code");note.Text="5분 동안 사용할 수 있으며 한 번만 연결됩니다.";});ButtonAt(buttons,"코드 복사",delegate{if(code.Text.Length==6&&code.Text.All(Char.IsDigit))Clipboard.SetText(code.Text);return Task.FromResult(0);});
   foreach(var dev in Rows(v,"devices").Where(x=>S(x,"kind")=="phone"&&S(x,"active")=="1")){var row=Bar(pair);Caption(row,"연결된 휴대폰 · "+S(dev,"id").Substring(0,6));ButtonAt(row,"연결 해제",async delegate{if(MessageBox.Show("이 휴대폰 연결을 해제할까요?","기기 연결",MessageBoxButtons.YesNo)==DialogResult.Yes){await Api(D("op","revoke","device",S(dev,"id")));await SettingsPage();}});}
   var output=Card(body);LabelAt(output,"결과 저장").Font=new Font(Font.FontFamily,13,FontStyle.Bold);Caption(output,S(v,"output"));var storage=Bar(output);ButtonAt(storage,"결과 폴더 열기",delegate{Process.Start("explorer.exe","\""+S(v,"output")+"\"");return Task.FromResult(0);});ButtonAt(storage,"저장 폴더 변경",()=>ChooseDirectory("output"));
   var search=Card(body);LabelAt(search,"자료 검색").Font=new Font(Font.FontFamily,13,FontStyle.Bold);Caption(search,"아래 위치에서 요청에 맞는 자료를 찾습니다.");foreach(var r in Rows(v,"roots")){LabelAt(search,S(r,"label"));Caption(search,S(r,"path"));}foreach(string excluded in v["excluded"] as System.Collections.IEnumerable)Caption(search,"제외 · "+excluded);var roots=Bar(search);ButtonAt(roots,"검색 폴더 추가",()=>ChooseDirectory("root"));ButtonAt(roots,"검색에서 제외",()=>ChooseDirectory("exclude"));
   var app=Card(body);LabelAt(app,"DIANA");Caption(app,"버전 "+BuildVersion.ProductVersion);FitPage();}
  async Task ChooseDirectory(string kind){using(var folder=new FolderBrowserDialog()){if(folder.ShowDialog()==DialogResult.OK){await Api(D("op","directory","kind",kind,"path",folder.SelectedPath));await SettingsPage();}}}

 }
}




