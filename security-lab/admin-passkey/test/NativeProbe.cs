using System;
using System.Net;
using System.Net.Http;
using Diana.Lab.Passkey;
class Probe {
    static int Main(string[] args){ServicePointManager.SecurityProtocol=SecurityProtocolType.Tls12;try{return Run(args).GetAwaiter().GetResult();}catch{Console.WriteLine("DENIED");return 1;}}
    static async System.Threading.Tasks.Task<int> Run(string[] args){
        if(AdminPasskeyClient.Challenge("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")!="E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM")throw new Exception();
        if(args[0]=="--https-selftest"){
            if(new Uri(AdminPasskeyClient.Origin).Scheme!="https")throw new Exception();
            using(var h=new HttpClientHandler{UseProxy=false,AllowAutoRedirect=false})using(var c=new HttpClient(h)){
                c.Timeout=TimeSpan.FromSeconds(60);var response=await c.GetAsync(AdminPasskeyClient.Origin+"/healthz");if(response.StatusCode!=HttpStatusCode.OK)throw new Exception();
            }Console.WriteLine("HTTPS READINESS CHECK PASSED");return 0;
        }
        if(args[0]=="--selftest"){
            string s=AdminPasskeyClient.Random(),c=AdminPasskeyClient.Random();
            AdminPasskeyClient.ParseCallback("/oauth2/callback?code="+c+"&state="+s,s);
            foreach(string path in new[]{"/evil?code="+c+"&state="+s,"/oauth2/callback?code="+c+"&state=wrong","/oauth2/callback?code="+c+"&state="+s+"&state="+s,"/oauth2/callback?code="+c+"&state="+s+"#fragment"}){bool denied=false;try{AdminPasskeyClient.ParseCallback(path,s);}catch{denied=true;}if(!denied)throw new Exception();}
            Console.WriteLine("NATIVE CALLBACK CHECKS PASSED");return 0;
        }
        var client=new AdminPasskeyClient(args[0]);
        if(args.Length>1&&args[1]=="restore"){Console.WriteLine("RESTORED "+await client.Status());return 0;}
        await client.Login(url=>Console.WriteLine("BEGIN "+url));Console.WriteLine("CONNECTED "+await client.Status());
        string command;while((command=Console.ReadLine())!=null){
            if(command=="status"){try{Console.WriteLine("STATUS "+await client.Status());}catch{Console.WriteLine("STATUS DENIED");}}
            if(command=="exit")return 0;
        }return 0;
    }
}
