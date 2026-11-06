using System;
using System.IO;
using System.Drawing;
using System.Drawing.Imaging;
using System.Reflection;
using System.ComponentModel;
using System.Collections.Generic;
using System.Windows.Forms;
class RenderWorkspace {
 static Type type; static object target;
 static object Call(string name,params object[] args){return type.GetMethod(name,BindingFlags.Instance|BindingFlags.NonPublic).Invoke(target,args);}
 static Dictionary<string,object> D(params object[] a){var d=new Dictionary<string,object>();for(int i=0;i<a.Length;i+=2)d[(string)a[i]]=a[i+1];return d;}
 static object[] files={D("id","test-only","name","프로젝트 요약 보고서.pdf","format","pdf","bytes",125600,"delivered",true)};
 static void Check(Control parent){foreach(Control child in parent.Controls){if(!child.Visible)continue;if(parent is FlowLayoutPanel && child.Right>parent.ClientSize.Width-parent.Padding.Right+2)throw new Exception("Horizontal overflow: "+child.GetType().Name+" "+child.Text+" right="+child.Right+" parent="+parent.ClientSize.Width);Check(child);}}
 [STAThread] static int Main(string[] args){Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);Directory.CreateDirectory(args[1]);var assembly=Assembly.LoadFrom(args[0]);type=assembly.GetType("Diana.Desktop.PairedForm",true);
  using(var form=(Form)Activator.CreateInstance(type,BindingFlags.Instance|BindingFlags.Public|BindingFlags.NonPublic,null,new object[]{Path.GetDirectoryName(args[0]),null},null)){target=form;
   var key=typeof(Form).GetField("EVENT_SHOWN",BindingFlags.NonPublic|BindingFlags.Static).GetValue(null);var events=(EventHandlerList)typeof(Component).GetProperty("Events",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form,null);events.RemoveHandler(key,events[key]);
   form.Opacity=0;form.ShowInTaskbar=false;form.Show();
   foreach(int width in new[]{1100,680})foreach(string screen in new[]{"work","approval","archive","settings"}){
    form.ClientSize=new Size(width,760);
    if(screen=="work"||screen=="approval"){Call("Work");((Timer)type.GetField("timer",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form)).Stop();Call("RenderWork",D("jobs",screen=="approval"?new object[]{D("id","test-only","status","approval","preview","자료를 확인한 결과입니다. 원문에 확인된 내용만 보존했습니다.\r\n\r\n미해결: 근거가 없는 내용은 추가하지 않았습니다.","nonce","test-only")}:new object[0],"files",screen=="work"?files:new object[0],"legacy",null));}
    if(screen=="archive")Call("RenderArchive",D("files",files,"more",false),0);
    if(screen=="settings")Call("RenderSettings",D("devices",new object[0],"output",@"C:\Users\사용자\Documents\DIANA\결과","roots",new object[]{D("label","바탕화면","path",@"C:\Users\사용자\Desktop"),D("label","문서","path",@"C:\Users\사용자\Documents")},"excluded",new string[0]));
    form.PerformLayout();Call("FitPage");form.PerformLayout();Check(form);
    using(var bitmap=new Bitmap(form.Width,form.Height)){form.DrawToBitmap(bitmap,new Rectangle(Point.Empty,bitmap.Size));bitmap.Save(Path.Combine(args[1],screen+"-"+width+".png"),ImageFormat.Png);}Console.WriteLine(screen+" "+width+": native layout passed");
   }
   Call("Work");var request=(TextBox)type.GetField("request",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form);request.Text="문서 두 개를 요약해줘";
   Call("RenderArchive",D("files",files,"more",false),0);Call("Work");((Timer)type.GetField("timer",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form)).Stop();
   if(((TextBox)type.GetField("request",BindingFlags.Instance|BindingFlags.NonPublic).GetValue(form)).Text!="문서 두 개를 요약해줘")throw new Exception("Unsent request was lost during navigation");
   Console.WriteLine("Unsent request survives navigation");
  }return 0;
 }
}
