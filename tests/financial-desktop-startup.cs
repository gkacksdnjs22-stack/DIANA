using System;
using System.Windows.Forms;
using Diana.Desktop;
class StartupHarness {
    [STAThread] static int Main(string[] args) {
        if(args.Length!=2)return 2;
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        // Use the production form and resolver, with a test-only common profile.
        // No test actions, control manipulation, or user profile replacement.
        using(var form=new LauncherForm(args[0],Settings.DefaultFile(args[0],args[1]),args[1]))Application.Run(form);
        return 0;
    }
}
