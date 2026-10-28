using System;
using System.Runtime.InteropServices;
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
        Console.WriteLine("Native launcher checks passed: quoting, loopback URLs, protocol projection, local paths.");return 0;
    }
}
