using System;
using System.Collections.Generic;
using System.Threading;
using System.Web.Script.Serialization;
using Diana.Desktop;

// Compile against the actual release DIANA.exe. This exercises its public
// WorkerSession and packaged worker without automating an unrelated browser.
class DesktopIntegration {
    static readonly object OutputLock = new object();
    static int Main(string[] args) {
        if (args.Length != 2) return 2;
        Settings.Read(args[1]).Validate();
        using (var ended = new ManualResetEvent(false))
        using (var session = new WorkerSession()) {
            int exitCode = 1;
            session.Message += delegate(Dictionary<string,object> message) {
                lock(OutputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(message)); Console.Out.Flush(); }
            };
            session.Exited += delegate(int code) { exitCode=code; ended.Set(); };
            session.Start(args[0], args[1]);
            while (!ended.WaitOne(0)) {
                string command=Console.ReadLine();
                if (command == null || command == "stop") { session.Stop(); break; }
            }
            if (!ended.WaitOne(45000)) return 3;
            return exitCode;
        }
    }
}
