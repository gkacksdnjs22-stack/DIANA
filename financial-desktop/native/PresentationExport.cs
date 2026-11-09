using System;
using System.IO;
using System.Text;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;

namespace DianaOffice {
 static class PresentationExport {
  static object Get(object value,string name,params object[] args){return value.GetType().InvokeMember(name,BindingFlags.GetProperty|BindingFlags.InvokeMethod,null,value,args);}
  static object Call(object value,string name,params object[] args){return value.GetType().InvokeMember(name,BindingFlags.InvokeMethod,null,value,args);}
  static void Set(object value,string name,object arg){value.GetType().InvokeMember(name,BindingFlags.SetProperty,null,value,new object[]{arg});}
  static int Count(object value){return Convert.ToInt32(Get(value,"Count"));}
  static string Snapshot(object presentation){
   var text=new StringBuilder();object slides=Get(presentation,"Slides");
   for(int i=1;i<=Count(slides);i++){object slide=Get(slides,"Item",i),shapes=Get(slide,"Shapes");for(int j=1;j<=Count(shapes);j++){object shape=Get(shapes,"Item",j);if(Convert.ToInt32(Get(shape,"HasTextFrame"))==-1){object range=Get(Get(shape,"TextFrame"),"TextRange");text.Append(Convert.ToString(Get(range,"Text")).Replace("\r\n","\n").Replace("\r","\n")).Append('\n');}}}return text.ToString();
  }
  [STAThread]static int Main(string[] args){
   Console.OutputEncoding=new UTF8Encoding(false);object app=null,presentations=null,source=null,check=null;bool owned=false;object result;string stage="input";
   try{
    if(args.Length!=2)throw new InvalidOperationException("변환할 파일을 확인하세요.");
    string input=Path.GetFullPath(args[0]),output=Path.GetFullPath(args[1]),folder=Path.GetDirectoryName(input);
    if(Path.GetDirectoryName(output)!=folder||!Path.GetFileName(folder).StartsWith("diana-presentation-")||Path.GetFileName(input)!="source.pptx"||Path.GetFileName(output)!="result.ppt"||File.Exists(output)||(File.GetAttributes(folder)&FileAttributes.ReparsePoint)!=0||new FileInfo(input).Length>8000000)throw new InvalidOperationException("변환할 임시 파일을 확인하세요.");
    object running=null;try{running=Marshal.GetActiveObject("PowerPoint.Application");}catch(COMException){}
    if(running!=null)throw new InvalidOperationException("열려 있는 PowerPoint를 닫은 뒤 다시 시도하세요. PDF 파일은 그대로 사용할 수 있습니다.");
    stage="start";Type type=Type.GetTypeFromProgID("PowerPoint.Application");if(type==null)throw new InvalidOperationException("PPT 변환에는 이 PC에 설치된 PowerPoint가 필요합니다. PDF 파일은 그대로 사용할 수 있습니다.");
    app=Activator.CreateInstance(type);presentations=Get(app,"Presentations");if(Count(presentations)!=0)throw new InvalidOperationException("열려 있는 PowerPoint를 닫은 뒤 다시 시도하세요.");owned=true;
    Set(app,"AutomationSecurity",3);Set(app,"DisplayAlerts",1);
    stage="open";source=Call(presentations,"Open",input,-1,0,0);stage="snapshot";string before=Snapshot(source);int slides=Count(Get(source,"Slides"));
    stage="save";Call(source,"SaveAs",output,1,0);Call(source,"Close");source=null;
    byte[] signature=new byte[8];using(var stream=File.OpenRead(output))if(stream.Read(signature,0,8)!=8)throw new IOException();
    if(BitConverter.ToString(signature)!="D0-CF-11-E0-A1-B1-1A-E1")throw new IOException();
    stage="verify";check=Call(presentations,"Open",output,-1,0,0);if(Count(Get(check,"Slides"))!=slides||Snapshot(check)!=before)throw new InvalidOperationException("PPT 변환 결과의 본문이 일치하지 않습니다.");
    result=new{ok=true,slides=slides,characters=before.Length};
   }catch(InvalidOperationException e){result=new{ok=false,error=e.Message,stage=stage};}
   catch(Exception e){result=new{ok=false,error="PPT 변환을 마치지 못했습니다. PowerPoint 설치·초기 설정을 확인하거나 PDF를 사용하세요.",stage=stage,code=(e.InnerException??e).GetType().Name,hresult=(e.InnerException??e).HResult};}
   finally{try{if(check!=null)Call(check,"Close");}catch{}try{if(source!=null)Call(source,"Close");}catch{}try{if(owned&&presentations!=null&&Count(presentations)==0)Call(app,"Quit");}catch{}check=source=presentations=app=null;GC.Collect();GC.WaitForPendingFinalizers();}
   Console.Write(new JavaScriptSerializer().Serialize(result));return 0;
  }
 }
}
