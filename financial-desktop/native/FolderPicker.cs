using System;
using System.Text;
using System.IO;
using System.Drawing;
using System.Web.Script.Serialization;
using System.Windows.Forms;

class DianaFolderPicker {
    private sealed class PickerWindow : Form {
        public string SelectedFolder;
        public PickerWindow() {
            Text=Diana.Desktop.BuildVersion.PickerTitle;
            ClientSize=new Size(570,125);StartPosition=FormStartPosition.CenterScreen;
            FormBorderStyle=FormBorderStyle.FixedDialog;MaximizeBox=false;MinimizeBox=false;
            ShowInTaskbar=true;
            Controls.Add(new Label {Text="문서를 찾을 폴더를 선택해 주세요.\n선택한 폴더 안에서만 TXT·MD·JSON 파일을 확인합니다.",Dock=DockStyle.Fill,Padding=new Padding(20),AutoSize=false});
            Shown+=delegate {
                // A real visible owner gives the shell dialog its own message
                // loop and keeps it above a worker launched without a console.
                using(var picker=new FolderBrowserDialog()) {
                    picker.Description="DIANA가 문서를 찾을 PC 폴더를 선택하세요.";
                    picker.ShowNewFolderButton=false;
                    if(picker.ShowDialog(this)==DialogResult.OK)SelectedFolder=picker.SelectedPath;
                }
                Close();
            };
        }
    }
    [STAThread] static int Main() {
        Application.EnableVisualStyles();Application.SetCompatibleTextRenderingDefault(false);
        using(var window=new PickerWindow()) {
            Application.Run(window);
            object result=window.SelectedFolder!=null?
                (object)new {folder=window.SelectedFolder}:new {cancelled=true};
            using(var output=new StreamWriter(Console.OpenStandardOutput(),new UTF8Encoding(false))) {
                output.WriteLine(new JavaScriptSerializer().Serialize(result));output.Flush();
            }
        }
        return 0;
    }
}
