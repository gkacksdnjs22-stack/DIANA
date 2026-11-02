using System;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading.Tasks;
using System.Collections.Generic;
using System.Web.Script.Serialization;

namespace Diana.Lab.Passkey {
    public sealed class AdminPasskeyClient {
        public const string Origin="http://localhost:43871";
        private readonly string store;
        public AdminPasskeyClient(string storeFile) {store=storeFile;}
        public static string Random() {var b=new byte[32];using(var r=RandomNumberGenerator.Create())r.GetBytes(b);return B64(b);}
        private static string B64(byte[] b) {return Convert.ToBase64String(b).TrimEnd('=').Replace('+','-').Replace('/','_');}
        public static string Challenge(string verifier) {using(var h=SHA256.Create())return B64(h.ComputeHash(Encoding.ASCII.GetBytes(verifier)));}
        private static string Q(string s) {return Uri.EscapeDataString(s);}
        public static string AuthorizationUrl(string redirect,string state,string verifier) {
            return Origin+"/authorize?response_type=code&client_id=diana-lab-desktop&code_challenge_method=S256&redirect_uri="+Q(redirect)+"&state="+Q(state)+"&code_challenge="+Challenge(verifier);
        }
        public static Dictionary<string,string> ParseCallback(string path,string state) {
            var uri=new Uri("http://127.0.0.1"+path);if(uri.AbsolutePath!="/oauth2/callback"||uri.Fragment!="")throw new Exception("CALLBACK_DENIED");
            var data=new Dictionary<string,string>();foreach(string part in uri.Query.TrimStart('?').Split('&')){var p=part.Split(new[]{'='},2);if(p.Length!=2||data.ContainsKey(p[0]))throw new Exception("CALLBACK_DENIED");data.Add(p[0],Uri.UnescapeDataString(p[1]));}
            if(data.Count!=2||!data.ContainsKey("code")||!data.ContainsKey("state")||data["state"]!=state||!System.Text.RegularExpressions.Regex.IsMatch(data["code"],"^[A-Za-z0-9_-]{43}$"))throw new Exception("CALLBACK_DENIED");return data;
        }
        private async Task<Dictionary<string,object>> Post(string path,object body,string token=null) {
            using(var handler=new HttpClientHandler {UseProxy=false,AllowAutoRedirect=false})using(var client=new HttpClient(handler)) {
                client.Timeout=TimeSpan.FromSeconds(8);var request=new HttpRequestMessage(HttpMethod.Post,Origin+path);
                request.Content=new StringContent(new JavaScriptSerializer().Serialize(body),Encoding.UTF8,"application/json");
                if(token!=null)request.Headers.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",token);
                using(var response=await client.SendAsync(request)) {if(!response.IsSuccessStatusCode)throw new Exception("AUTH_DENIED");var text=await response.Content.ReadAsStringAsync();if(text.Length>32768)throw new Exception("AUTH_DENIED");return new JavaScriptSerializer().Deserialize<Dictionary<string,object>>(text);}
            }
        }
        public async Task Login(Action<string> openBrowser) {
            var listener=new TcpListener(IPAddress.Loopback,0);listener.Start(1);
            try {
                int port=((IPEndPoint)listener.LocalEndpoint).Port;string redirect="http://127.0.0.1:"+port+"/oauth2/callback",state=Random(),verifier=Random();
                openBrowser(AuthorizationUrl(redirect,state,verifier));
                var accept=listener.AcceptTcpClientAsync();if(await Task.WhenAny(accept,Task.Delay(120000))!=accept)throw new Exception("AUTH_EXPIRED");
                using(var peer=await accept)using(var stream=peer.GetStream()) {
                    var buffer=new byte[8192];int used=0;
                    while(used<buffer.Length) {
                        var read=stream.ReadAsync(buffer,used,buffer.Length-used);if(await Task.WhenAny(read,Task.Delay(5000))!=read)throw new Exception("CALLBACK_DENIED");
                        int count=await read;if(count==0)throw new Exception("CALLBACK_DENIED");used+=count;
                        if(Encoding.ASCII.GetString(buffer,0,used).Contains("\r\n\r\n"))break;
                    }
                    string header=Encoding.ASCII.GetString(buffer,0,used);var line=header.Split(new[]{"\r\n"},StringSplitOptions.None)[0].Split(' ');
                    if(line.Length!=3||line[0]!="GET"||!line[1].StartsWith("/oauth2/callback?"))throw new Exception("CALLBACK_DENIED");
                    var callback=ParseCallback(line[1],state);
                    var result=await Post("/api/native/token",new {grant_type="authorization_code",client_id="diana-lab-desktop",redirect_uri=redirect,code=callback["code"],code_verifier=verifier});
                    string access=(string)result["access_token"];if(!System.Text.RegularExpressions.Regex.IsMatch(access,"^[A-Za-z0-9_-]{43}$"))throw new Exception("AUTH_DENIED");
                    Directory.CreateDirectory(Path.GetDirectoryName(store));var encrypted=ProtectedData.Protect(Encoding.UTF8.GetBytes(access),null,DataProtectionScope.CurrentUser);
                    string temp=store+"."+Guid.NewGuid().ToString("N");File.WriteAllBytes(temp,encrypted);if(File.Exists(store))File.Replace(temp,store,null);else File.Move(temp,store);
                    var bytes=Encoding.UTF8.GetBytes("HTTP/1.1 200 OK\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\nConnection: close\r\n\r\nDIANA LAB: 앱으로 돌아가세요.");await stream.WriteAsync(bytes,0,bytes.Length);
                }
            }finally{listener.Stop();}
        }
        public async Task<string> Status() {
            if(!File.Exists(store))throw new Exception("AUTH_REQUIRED");
            string access=Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(store),null,DataProtectionScope.CurrentUser));
            var status=await Post("/api/native/status",new {},access);
            if(!status.ContainsKey("documentAccess")||(bool)status["documentAccess"])throw new Exception("BOUNDARY_DENIED");
            return (string)status["role"];
        }
        public async Task Logout() {
            if(File.Exists(store)) {
                string access=Encoding.UTF8.GetString(ProtectedData.Unprotect(File.ReadAllBytes(store),null,DataProtectionScope.CurrentUser));
                // Native clients use the same-origin header for the protected logout route.
                using(var handler=new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false})using(var client=new HttpClient(handler)){
                    client.Timeout=TimeSpan.FromSeconds(8);var r=new HttpRequestMessage(HttpMethod.Post,Origin+"/api/logout");r.Headers.Add("Origin",Origin);r.Headers.Authorization=new System.Net.Http.Headers.AuthenticationHeaderValue("Bearer",access);r.Content=new StringContent("{}",Encoding.UTF8,"application/json");using(var response=await client.SendAsync(r)){if(!response.IsSuccessStatusCode)throw new Exception("AUTH_DENIED");}
                }
                File.Delete(store);
            }
        }
    }
}
