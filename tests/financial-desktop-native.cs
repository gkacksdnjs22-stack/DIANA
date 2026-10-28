using System;
using System.Runtime.InteropServices;
using System.IO;
using Diana.Desktop;
class NativeTests {
    [DllImport("shell32.dll",SetLastError=true)]static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)]string command,out int count);
    [DllImport("kernel32.dll")]static extern IntPtr LocalFree(IntPtr handle);
    static void Check(bool value,string message) { if(!value)throw new Exception(message); }
    static int Main() {
        foreach(string argument in new[]{"","plain",@"C:\한글 폴더\worker.json",@"C:\last\", "with\"quote",@"slashes\\""quote", "a & b $(payload)"}) {
            int count;var result=CommandLineToArgvW("program.exe "+WorkerSession.Quote(argument),out count);
            try { Check(count==2,"argument count");Check(Marshal.PtrToStringUni(Marshal.ReadIntPtr(result,IntPtr.Size))==argument,"argument roundtrip"); } finally { LocalFree(result); }
        }
        string url="http://127.0.0.1:12345/#view="+new string('a',64);
        Check(WorkerSession.ReviewUrl(url),"loopback URL");
        foreach(string invalid in new[]{url.Replace("127.0.0.1","evil.example"),url.Replace(":12345",":65536"),url+"&file=secret",url.Replace("http:","file:"),url.Replace(":12345",":0")})Check(!WorkerSession.ReviewUrl(invalid),"invalid URL");
        Check(WorkerSession.Parse("{\"type\":\"connection\",\"connected\":true}")!=null,"connection");
        Check(WorkerSession.Parse("{\"type\":\"connection\",\"connected\":true,\"body\":\"SECRET\"}")==null,"extra field");
        Check(WorkerSession.Parse("{\"type\":\"job\",\"state\":\"SECRET\"}")==null,"invalid state");
        Check(WorkerSession.Parse("{\"type\":\"error\",\"code\":\"SECRET\"}")==null,"invalid error");
        Check(!Settings.LocalPath(@"\\server\file"),"UNC path");Check(!Settings.LocalPath("relative.json"),"relative path");
        string fixture=Path.Combine(Path.GetTempPath(),"diana-profile-test-"+Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(fixture);
        try {
            string oldRoot=Path.Combine(fixture,"old"),nextRoot=Path.Combine(fixture,"new"),shared=Path.Combine(fixture,"shared","desktop.json");
            Directory.CreateDirectory(oldRoot);Directory.CreateDirectory(nextRoot);
            string config=Path.Combine(fixture,"worker.json"),env=Path.Combine(fixture,"connection.env");
            File.WriteAllText(config,"{}");File.WriteAllText(env,"AGENT_TOKEN=FAKE_TEST_ONLY");
            var value=new Settings {ConfigPath=config,EnvFile=env,DocumentRoot=fixture,ApiBaseUrl="http://127.0.0.1:12345",AutoOpen=false};
            string portable=Path.Combine(oldRoot,".local","desktop.json");value.Save(portable);value.Save(shared);
            Check(Settings.DefaultFile(oldRoot,shared)==portable,"portable settings take priority");
            string selected=Settings.DefaultFile(nextRoot,shared);Check(selected==shared,"new app version uses shared profile");
            var restored=Settings.Read(selected);Check(restored.ConfigPath==config&&restored.EnvFile==env&&!restored.AutoOpen,"existing paths and preference retained");
            string json=File.ReadAllText(shared);Check(!json.Contains("FAKE_TEST_ONLY"),"connection secret is not copied into profile");
            File.WriteAllText(portable,"invalid");bool rejected=false;try { Settings.Read(Settings.DefaultFile(oldRoot,shared)); } catch { rejected=true; }
            Check(rejected,"invalid explicit portable profile never switches to a different connection");
        } finally { Directory.Delete(fixture,true); }
        Console.WriteLine("Native launcher checks passed: quoting, loopback URLs, protocol projection, local paths, cross-version profile reuse, profile priority and fail-closed validation.");return 0;
    }
}
