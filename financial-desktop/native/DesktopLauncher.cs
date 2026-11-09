using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("DIANA PC")]
[assembly: System.Reflection.AssemblyProduct("DIANA PC Financial Review")]

namespace Diana.Desktop {
    public sealed class Settings {
        public string ConfigPath, EnvFile, DocumentRoot, ApiBaseUrl;
        public bool AutoOpen = true;
        public static string SharedFile {
            get { return Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),"DIANA","financial-desktop","desktop.json"); }
        }
        public static string DefaultFile(string root,string sharedFile) {
            // New bundles never silently read/write another install's profile.
            string demo=Path.Combine(root,".local","가상 체험","desktop.json");
            return File.Exists(demo)?demo:Path.Combine(root,".local","desktop.json");
        }
        public static bool ShouldPrepareAutomatically(string root,string profileFile,bool enabled) {
            return enabled && String.Equals(Path.GetFullPath(profileFile),
                Path.GetFullPath(Path.Combine(root,".local","desktop.json")),StringComparison.OrdinalIgnoreCase)
                && !File.Exists(profileFile) && !Directory.Exists(profileFile);
        }
        public static bool LocalPath(string value) {
            return !String.IsNullOrWhiteSpace(value) && Path.IsPathRooted(value) &&
                Regex.IsMatch(value, @"^[A-Za-z]:[\\/]") && !Regex.IsMatch(value, @"[\x00-\x1f]");
        }
        public void Validate() {
            Uri uri;
            if (!LocalPath(ConfigPath) || !LocalPath(EnvFile) || !LocalPath(DocumentRoot) ||
                !File.Exists(ConfigPath) || !File.Exists(EnvFile) || !Directory.Exists(DocumentRoot) ||
                !Uri.TryCreate(ApiBaseUrl, UriKind.Absolute, out uri) || !String.IsNullOrEmpty(uri.UserInfo) ||
                !String.IsNullOrEmpty(uri.Query) || !String.IsNullOrEmpty(uri.Fragment) || uri.AbsolutePath != "/" ||
                !(uri.Scheme == "https" || uri.Scheme == "http" && (uri.Host == "127.0.0.1" || uri.Host == "localhost" || uri.Host == "[::1]")))
                throw new InvalidOperationException("SETTINGS_INVALID");
        }
        public Dictionary<string, object> Data() {
            return new Dictionary<string, object> { {"schema_version",1}, {"configPath",ConfigPath},
                {"envFile",EnvFile}, {"documentRoot",DocumentRoot}, {"apiBaseUrl",ApiBaseUrl}, {"autoOpen",AutoOpen} };
        }
        public static Settings Read(string filename) {
            if (new FileInfo(filename).Length > 16384) throw new InvalidOperationException();
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(filename, Encoding.UTF8));
            if (data.Count != 6 || Convert.ToInt32(data["schema_version"]) != 1 || !(data["autoOpen"] is bool)) throw new InvalidOperationException();
            var value = new Settings { ConfigPath=(string)data["configPath"], EnvFile=(string)data["envFile"],
                DocumentRoot=(string)data["documentRoot"], ApiBaseUrl=(string)data["apiBaseUrl"], AutoOpen=(bool)data["autoOpen"] };
            value.Validate(); return value;
        }
        public void Save(string filename) {
            Validate(); Directory.CreateDirectory(Path.GetDirectoryName(filename));
            string temporary = Path.Combine(Path.GetDirectoryName(filename), "desktop-"+Guid.NewGuid().ToString("N")+".tmp");
            try {
                using (var stream = new FileStream(temporary, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                using (var writer = new StreamWriter(stream, new UTF8Encoding(false))) { writer.Write(new JavaScriptSerializer().Serialize(Data())); }
                if (File.Exists(filename)) File.Replace(temporary, filename, null); else File.Move(temporary, filename);
            } finally { if (File.Exists(temporary)) File.Delete(temporary); }
        }
    }

    public sealed class WorkerSession : IDisposable {
        private Process process;
        public event Action<Dictionary<string, object>> Message;
        public event Action<int> Exited;
        public bool Running { get { return process != null; } }
        public static string Quote(string argument) {
            // CommandLineToArgvW/CRT quoting, including trailing backslashes.
            var output=new StringBuilder("\""); int slashes=0;
            foreach(char character in argument) {
                if(character=='\\') { slashes++; continue; }
                if(character=='"')output.Append('\\',slashes*2+1); else output.Append('\\',slashes);
                output.Append(character); slashes=0;
            }
            output.Append('\\',slashes*2); output.Append('"'); return output.ToString();
        }
        public static bool ReviewUrl(string value) {
            Uri uri;
            return value != null && Regex.IsMatch(value, @"\Ahttp://127\.0\.0\.1:[1-9][0-9]{0,4}/(?:chat)?#view=[a-f0-9]{64}\z") &&
                Uri.TryCreate(value,UriKind.Absolute,out uri) && uri.Port > 0 && uri.Port <= 65535;
        }
        public static bool AdminUrl(string value) {
            Uri uri;
            return value != null && Regex.IsMatch(value, @"\Ahttp://127\.0\.0\.1:[1-9][0-9]{0,4}/admin(?:#setup=[a-f0-9]{64})?\z") &&
                Uri.TryCreate(value,UriKind.Absolute,out uri) && uri.Port > 0 && uri.Port <= 65535;
        }
        public static Dictionary<string, object> Parse(string line) {
            if (line == null || line.Length > 1024) return null;
            try {
                var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(line);
                string type = (string)data["type"];
                if (type == "ready" && data.Count == 2 && ReviewUrl((string)data["url"])) return data;
                if (type == "securityReady" && data.Count == 2 && AdminUrl((string)data["url"])) return data;
                if (type == "connection" && data.Count == 2 && data["connected"] is bool) return data;
                if (type == "saved" && data.Count == 2 && data["saved"] is bool) return data;
                if (type == "job" && data.Count == 2 && Regex.IsMatch((string)data["state"], @"\A(?:QUEUED|PROCESSING|PC_REVIEW_REQUIRED|WAITING_FOR_INFORMATION|LOCAL_SAVING|LOCAL_SAVE_COMPLETED|REVIEW_COMPLETED|CANCELLED|BLOCKED|FAILED|UNCERTAIN)\z")) return data;
                if (type == "error" && data.Count == 2 && Regex.IsMatch((string)data["code"], @"\A(?:WORKER_ALREADY_RUNNING|WORKER_LOCK_UNCERTAIN|INVALID_SERVER_CONFIG|DESKTOP_SETTINGS_INVALID|DESKTOP_ENV_INVALID|FILE_DENIED|PATH_DENIED|PYTHON_PATH_INVALID|INVALID_WORKER_CONFIG|FINANCE_STATE_OVERLAP|FINANCE_CATALOG_OVERLAP|DESKTOP_START_FAILED)\z")) return data;
                if ((type == "stopping" || type == "stopped" || type == "commandRejected") && data.Count == 1) return data;
            } catch { } return null;
        }
        public void Start(string root, string settingsFile) {
            if (process != null) throw new InvalidOperationException();
            string node = Path.Combine(root,"runtime","node","node.exe"), worker = Path.Combine(root,"app","financial-desktop","worker.mjs");
            if (!File.Exists(node) || !File.Exists(worker)) throw new InvalidOperationException("RUNTIME_MISSING");
            bool demo=String.Equals(Path.GetFullPath(settingsFile),Path.Combine(root,".local","가상 체험","desktop.json"),StringComparison.OrdinalIgnoreCase);
            var info = new ProcessStartInfo(node, Quote(worker)+(demo?" --demo-settings ":" --settings ")+Quote(settingsFile)) {
                WorkingDirectory=Path.Combine(root,"app"), UseShellExecute=false, CreateNoWindow=true,
                RedirectStandardInput=true, RedirectStandardOutput=true, RedirectStandardError=true,
                StandardOutputEncoding=new UTF8Encoding(false), StandardErrorEncoding=new UTF8Encoding(false)
            };
            // Do not inherit NODE_OPTIONS, proxy settings, AI credentials or Python paths.
            info.EnvironmentVariables.Clear();
            foreach (string name in new [] {"SystemRoot","WINDIR","SystemDrive","TEMP","TMP"}) {
                string value = Environment.GetEnvironmentVariable(name); if (value != null) info.EnvironmentVariables[name]=value;
            }
            process = new Process { StartInfo=info, EnableRaisingEvents=true };
            var owned = process;
            owned.OutputDataReceived += delegate(object sender, DataReceivedEventArgs args) { var data=Parse(args.Data); if(data!=null && Message!=null) Message(data); };
            owned.ErrorDataReceived += delegate { /* Drain without logging source paths, runtime diagnostics or credentials. */ };
            owned.Exited += delegate { ThreadPool.QueueUserWorkItem(delegate { int code=1; try { owned.WaitForExit(); code=owned.ExitCode; } catch { } if (Exited!=null) Exited(code); }); };
            try { owned.Start(); owned.StandardInput.AutoFlush=true; owned.BeginOutputReadLine(); owned.BeginErrorReadLine(); }
            catch { process=null; owned.Dispose(); throw; }
        }
        public void Stop() { var owned=process; if(owned==null)return; try { owned.StandardInput.WriteLine("{\"command\":\"stop\"}"); } catch { } }
        public void Dispose() { var owned=process; process=null; if(owned!=null)owned.Dispose(); }
    }

    internal class Surface : Panel {
        public Surface() { DoubleBuffered=true; }
        protected override void OnPaintBackground(PaintEventArgs e) {
            using(var brush=new LinearGradientBrush(ClientRectangle,Color.FromArgb(26,43,65),Color.FromArgb(14,24,40),28))e.Graphics.FillRectangle(brush,ClientRectangle);
        }
    }
    internal class ActionButton : Button {
        public ActionButton(string text, bool primary) {
            Text=text; Height=46; Width=142; Margin=new Padding(0,0,12,0); FlatStyle=FlatStyle.Flat;
            FlatAppearance.BorderSize=1; FlatAppearance.BorderColor=primary?Color.FromArgb(87,222,218):Color.FromArgb(61,79,105);
            BackColor=primary?Color.FromArgb(32,91,106):Color.FromArgb(29,43,64); ForeColor=Color.FromArgb(227,240,248);
            Font=new Font("맑은 고딕",10,FontStyle.Bold); Cursor=Cursors.Hand; UseVisualStyleBackColor=false;
        }
    }

    internal sealed class SettingsDialog : Form {
        private readonly TextBox config=new TextBox(), env=new TextBox(), catalog=new TextBox(), server=new TextBox();
        private readonly CheckBox auto=new CheckBox { Text="연결하면 검토 화면 자동으로 열기", Checked=true, AutoSize=true };
        public Settings Value;
        public SettingsDialog(Settings value, bool demo=false) {
            Text=demo?BuildVersion.DemoSettingsTitle:BuildVersion.SettingsTitle; ClientSize=new Size(710,410); MinimumSize=Size; MaximumSize=Size;
            StartPosition=FormStartPosition.CenterParent; FormBorderStyle=FormBorderStyle.FixedDialog; MaximizeBox=false; MinimizeBox=false;
            Font=new Font("맑은 고딕",10); BackColor=Color.FromArgb(15,25,42); ForeColor=Color.FromArgb(225,234,246);
            AddField(demo?"자동 준비된 가상 작업 설정":"금융 작업 설정 (worker.json)",config,24,false);
            AddField(demo?"가상 체험 모드 파일 · 연결 키 없음":"연결 키가 있는 .env 파일",env,102,false);
            AddField(demo?"가상 일반 폴더 · 실제 사용자 자료 없음":"일반 DIANA 파일 폴더 (기존 sample-documents)",catalog,180,true);
            var label=new Label { Text=demo?"이 PC에서만 체험 · 서버에 연결하지 않음":"중계 서버", Left=24, Top=261, AutoSize=true }; Controls.Add(label);
            server.SetBounds(24,288,650,26); server.Text=value==null?"https://diana-pzw3.onrender.com":value.ApiBaseUrl; Controls.Add(server);
            auto.SetBounds(24,331,390,28); auto.ForeColor=ForeColor; Controls.Add(auto);
            var save=new ActionButton("설정 저장",true); save.SetBounds(534,337,140,44); save.Click+=delegate { SaveValue(); }; Controls.Add(save); AcceptButton=save;
            if(value!=null) { config.Text=value.ConfigPath; env.Text=value.EnvFile; catalog.Text=value.DocumentRoot; auto.Checked=value.AutoOpen; }
            if(demo) { foreach(Control c in Controls)if(c is TextBox)((TextBox)c).ReadOnly=true; else if(c is Button && c!=save)c.Enabled=false; save.Text="설정 확인"; }
        }
        private void AddField(string text, TextBox box, int top, bool folder) {
            Controls.Add(new Label { Text=text, Left=24, Top=top, AutoSize=true }); box.SetBounds(24,top+29,540,28); Controls.Add(box);
            var browse=new ActionButton("찾아보기",false); browse.SetBounds(574,top+27,100,32);
            browse.Click+=delegate {
                if(folder) { using(var dialog=new FolderBrowserDialog())if(dialog.ShowDialog(this)==DialogResult.OK)box.Text=dialog.SelectedPath; }
                else { using(var dialog=new OpenFileDialog { Filter="모든 파일|*.*",CheckFileExists=true })if(dialog.ShowDialog(this)==DialogResult.OK)box.Text=dialog.FileName; }
            }; Controls.Add(browse);
        }
        private void SaveValue() {
            try { Value=new Settings { ConfigPath=config.Text.Trim(), EnvFile=env.Text.Trim(), DocumentRoot=catalog.Text.Trim(), ApiBaseUrl=server.Text.Trim(), AutoOpen=auto.Checked }; Value.Validate(); DialogResult=DialogResult.OK; }
            catch { MessageBox.Show(this,"설정 파일·.env·일반 파일 폴더가 실제로 있는지 확인해 주세요.\n서버에는 기본 HTTPS 주소를 사용해 주세요.","설정 확인",MessageBoxButtons.OK,MessageBoxIcon.Information); }
        }
    }

    public sealed class LauncherForm : Form {
        private readonly string root, sharedProfile;
        private readonly bool automaticSetup;
        private string settingsFile;
        private bool IsDemo { get { return String.Equals(Path.GetFullPath(settingsFile),Path.Combine(root,".local","가상 체험","desktop.json"),StringComparison.OrdinalIgnoreCase); } }
        private readonly WorkerSession worker=new WorkerSession();
        private Settings settings;
        private string viewUrl, adminUrl;
        private bool stopping, closing, hadError, profileRemembered;
        private readonly Label status=new Label(), note=new Label(), recent=new Label(), profile=new Label();
        private readonly ListBox history=new ListBox();
        private readonly TextBox reviewAddress=new TextBox { ReadOnly=true };
        private readonly ActionButton open=new ActionButton("검토 화면 열기",true), start=new ActionButton("연결 시작",false), stop=new ActionButton("연결 종료",false), configure=new ActionButton("연결 설정",false), demo=new ActionButton("가상 자료 준비",false);
        private readonly ActionButton securityAdmin=new ActionButton("보안 관리자",false);
        public LauncherForm(string baseDirectory,string profileFile,string rememberFile=null,bool automaticSetup=false) {
            root=baseDirectory; settingsFile=profileFile; sharedProfile=rememberFile; this.automaticSetup=automaticSetup; Text=BuildVersion.MainTitle; ClientSize=new Size(760,632); MinimumSize=Size;
            AutoScaleMode=AutoScaleMode.Dpi; StartPosition=FormStartPosition.CenterScreen; Font=new Font("맑은 고딕",10);
            BackColor=Color.FromArgb(10,18,32); ForeColor=Color.FromArgb(224,234,246);
            using(var iconStream=typeof(LauncherForm).Assembly.GetManifestResourceStream("diana.ico"))if(iconStream!=null)Icon=new Icon(iconStream);
            var header=new Surface { Dock=DockStyle.Top, Height=145 }; Controls.Add(header);
            using(var logoStream=typeof(LauncherForm).Assembly.GetManifestResourceStream("diana.png"))if(logoStream!=null) {
                var image=Image.FromStream(logoStream); var logo=new PictureBox { Image=new Bitmap(image), SizeMode=PictureBoxSizeMode.Zoom, Left=24, Top=24, Width=94, Height=94 }; image.Dispose(); header.Controls.Add(logo);
            }
            header.Controls.Add(new Label { Text="DIANA", Left=140, Top=22, AutoSize=true, Font=new Font("Segoe UI",24,FontStyle.Bold), BackColor=Color.Transparent });
            header.Controls.Add(new Label { Text="PC 금융 문서 검토", Left=143, Top=72, AutoSize=true, BackColor=Color.Transparent, ForeColor=Color.FromArgb(154,179,204) });
            header.Controls.Add(new Label { Text="LOCAL WORKSPACE", Left=550, Top=44, Width=184, ForeColor=Color.FromArgb(116,217,218), BackColor=Color.Transparent, Font=new Font("Segoe UI",10,FontStyle.Bold) });
            status.SetBounds(32,174,690,34); status.Font=new Font("맑은 고딕",16,FontStyle.Bold); Controls.Add(status);
            note.SetBounds(34,217,690,47); note.ForeColor=Color.FromArgb(154,177,202); Controls.Add(note);
            var actions=new FlowLayoutPanel { Left=32,Top=278,Width=710,Height=52,Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right };
            actions.Controls.AddRange(new Control[]{open,start,stop,configure}); Controls.Add(actions);
            demo.SetBounds(32,336,220,42); demo.Click+=delegate { PrepareDemo(); }; Controls.Add(demo);
            recent.SetBounds(274,347,260,28); recent.Font=new Font("맑은 고딕",10,FontStyle.Bold); recent.Text="최근 상태"; recent.AutoEllipsis=true; Controls.Add(recent);
            securityAdmin.SetBounds(550,336,178,42); securityAdmin.Click+=delegate { if(!stopping && worker.Running && WorkerSession.AdminUrl(adminUrl))try { Process.Start(new ProcessStartInfo(adminUrl) { UseShellExecute=true }); }catch { AddHistory("관리자 페이지를 열 수 없어요. 기본 브라우저를 확인해 주세요."); } }; Controls.Add(securityAdmin);
            history.SetBounds(32,389,696,110); history.BackColor=Color.FromArgb(16,28,46); history.ForeColor=Color.FromArgb(185,204,224); history.BorderStyle=BorderStyle.FixedSingle; history.IntegralHeight=false; history.TabStop=false; history.Anchor=AnchorStyles.Top|AnchorStyles.Left|AnchorStyles.Right; Controls.Add(history);
            profile.SetBounds(34,516,690,26); profile.ForeColor=Color.FromArgb(130,151,178); profile.AutoEllipsis=true; Controls.Add(profile);
            Controls.Add(new Label { Text="검토 화면 주소",Left=34,Top=550,Width=130,Height=25 });
            reviewAddress.SetBounds(166,547,562,28);reviewAddress.AccessibleName="검토 화면 주소";Controls.Add(reviewAddress);
            Controls.Add(new Label { Text="주소는 이 PC에서만 열며 다른 사람에게 공유하지 마세요. 원문은 PC에 보관합니다.", Left=34,Top=590,Width=695,Height=25,ForeColor=Color.FromArgb(101,210,208) });
            open.Click+=delegate { OpenReview(); }; start.Click+=delegate { StartWorker(); }; stop.Click+=delegate { StopWorker(); }; configure.Click+=delegate { Configure(); };
            worker.Message+=data=>Dispatch(()=>OnMessage(data)); worker.Exited+=code=>Dispatch(()=>OnExited(code));
            try { settings=Settings.Read(settingsFile); } catch { settings=null; }
            SetState("연결을 기다리고 있어요.",settings==null?"처음이라면 ‘가상 자료 준비’를 눌러 주세요. 설정은 이 실행 폴더에만 저장돼요.":"이 실행 폴더의 설정이 있어요. ‘연결 시작’을 눌러 주세요.",false); ControlsState();
            FormClosing+=OnClosing;
            Shown+=delegate { if(settings==null)EnsureAutomaticSetup(); };
        }
        private void Dispatch(Action action) { if(!IsDisposed && IsHandleCreated)try { BeginInvoke(action); } catch(InvalidOperationException) { } }
        private void AddHistory(string text) { history.Items.Insert(0,DateTime.Now.ToString("HH:mm:ss")+"   "+text); while(history.Items.Count>40)history.Items.RemoveAt(history.Items.Count-1); }
        private void SetState(string title,string detail,bool connected) { status.Text=title; status.ForeColor=connected?Color.FromArgb(101,225,215):Color.FromArgb(223,232,246); note.Text=detail; }
        private void ControlsState() { open.Enabled=worker.Running && viewUrl!=null && !stopping; securityAdmin.Enabled=worker.Running && adminUrl!=null && !stopping; reviewAddress.Text=open.Enabled?viewUrl:""; start.Enabled=!worker.Running; stop.Enabled=worker.Running && !stopping; configure.Enabled=!worker.Running; demo.Enabled=!worker.Running; profile.Text=settings==null?"아직 연결한 PC 설정이 없어요.":"작업 설정  ·  "+settings.ConfigPath; }
        private bool EnsureAutomaticSetup() {
            if(settings!=null)return true;
            if(!Settings.ShouldPrepareAutomatically(root,settingsFile,automaticSetup))return false;
            return PrepareDemo(false);
        }
        private bool PrepareDemo(bool ask=true) {
            if(worker.Running)return false;
            if(ask && MessageBox.Show(this,"이 실행 폴더에 별도 가상 자료와 출력 폴더를 준비합니다. 실제 사용자 문서를 복사하지 않습니다.\n추론·검토·승인·저장은 각 화면에서 직접 진행합니다.","가상 자료 준비",MessageBoxButtons.OKCancel,MessageBoxIcon.Information)!=DialogResult.OK)return false;
            try {
                var info=new ProcessStartInfo(Path.Combine(root,"runtime","node","node.exe"),WorkerSession.Quote(Path.Combine(root,"app","financial-desktop","synthetic-demo.mjs"))+" "+WorkerSession.Quote(root)) { UseShellExecute=false,CreateNoWindow=true,RedirectStandardOutput=true,RedirectStandardError=true };
                info.EnvironmentVariables.Clear(); foreach(string name in new[]{"SystemRoot","WINDIR","SystemDrive","TEMP","TMP"}) { string v=Environment.GetEnvironmentVariable(name);if(v!=null)info.EnvironmentVariables[name]=v; }
                using(var p=Process.Start(info)) { string result=p.StandardOutput.ReadToEnd();p.StandardError.ReadToEnd();p.WaitForExit();if(p.ExitCode!=0||result.Trim()!="DEMO_READY")throw new InvalidOperationException(); }
                settingsFile=Path.Combine(root,".local","가상 체험","desktop.json");settings=Settings.Read(settingsFile);profileRemembered=true;
                AddHistory("가상 자료 준비 완료 · 업무 결과 파일은 아직 만들지 않았어요.");
                SetState("가상 자료와 경로를 자동 지정했어요.","경로를 고를 필요 없이 ‘연결 시작’을 누르세요. 이 실행 폴더의 가상 자료만 사용합니다.",false);ControlsState();return true;
            } catch { MessageBox.Show(this,"가상 자료를 준비하지 못했습니다. 쓰기 가능한 폴더에 압축을 풀었는지 확인해 주세요. 기존 가상 폴더는 삭제·덮어쓰지 않았습니다.","가상 자료 준비 확인");return false; }
        }
        private bool Configure() {
            if(settings==null)EnsureAutomaticSetup();
            using(var dialog=new SettingsDialog(settings,IsDemo))if(dialog.ShowDialog(this)==DialogResult.OK) {
                try { dialog.Value.Save(settingsFile); settings=dialog.Value; profileRemembered=false; AddHistory("PC 연결 설정을 저장했어요."); ControlsState(); return true; }
                catch { MessageBox.Show(this,"실행 폴더에 설정을 저장할 수 없어요. 쓰기 가능한 폴더에 압축을 풀어 주세요.","설정 저장 확인"); }
            }
            return false;
        }
        private void StartWorker() {
            if(worker.Running)return; if(settings==null && !EnsureAutomaticSetup() && !Configure())return;
            try { settings.Validate(); stopping=false; hadError=false; viewUrl=null; adminUrl=null; worker.Start(root,settingsFile); SetState("PC 연결을 준비하고 있어요.","등록한 작업과 로컬 정책을 확인하고 있어요.",false); AddHistory("연결을 시작했어요."); }
            catch { SetState("연결을 시작하지 못했어요.","연결 설정과 압축을 푼 실행 파일을 확인해 주세요.",false); AddHistory("시작 실패 · 연결 설정을 확인해 주세요."); }
            ControlsState();
        }
        private void OpenReview() {
            if(stopping || !worker.Running || !WorkerSession.ReviewUrl(viewUrl))return;
            try { Process.Start(new ProcessStartInfo(viewUrl) { UseShellExecute=true }); }
            catch { AddHistory("기본 브라우저를 열 수 없어요. Windows 기본 브라우저를 확인해 주세요."); }
        }
        private void StopWorker() {
            if(!worker.Running || stopping)return; stopping=true; viewUrl=null;
            SetState("진행 중인 작업을 정리하고 있어요.","현재 처리를 마친 뒤 연결을 종료해요. 저장 중에는 잠시 기다려 주세요.",false);
            AddHistory("연결 종료를 요청했어요."); ControlsState(); worker.Stop();
        }
        private void OnMessage(Dictionary<string,object> data) {
            string type=(string)data["type"];
            if(type=="ready" && !stopping) { viewUrl=(string)data["url"]; AddHistory("PC 검토 화면을 준비했어요."); ControlsState(); if(settings.AutoOpen)OpenReview(); }
            if(type=="securityReady" && !stopping && viewUrl!=null && new Uri((string)data["url"]).Authority==new Uri(viewUrl).Authority) { adminUrl=(string)data["url"]; ControlsState(); }
            if(type=="connection" && !stopping) {
                bool connected=(bool)data["connected"];
                if(IsDemo) { SetState("가상 체험 준비 완료 · 이 PC 전용","‘검토 화면 열기’에서 대화로 요청하세요. 자료 확인과 저장 승인은 PC에서 진행합니다.",true);return; }
                string title=connected?"모바일 요청을 받을 준비가 됐어요.":"서버에 다시 연결하고 있어요.";
                if(connected && !profileRemembered && sharedProfile!=null) {
                    profileRemembered=true;
                    try { if(!String.Equals(Path.GetFullPath(settingsFile),Path.GetFullPath(sharedProfile),StringComparison.OrdinalIgnoreCase))settings.Save(sharedProfile); AddHistory("이 PC의 연결 설정을 기억했어요. 다음 실행부터 자동 연결돼요."); }
                    catch { AddHistory("공통 설정을 저장하지 못했어요. 현재 실행 폴더에서는 자동 연결돼요."); }
                }
                if(status.Text!=title)AddHistory(connected?"중계 서버에 연결됐어요.":"연결이 끊겼어요. 자동으로 다시 시도해요.");
                SetState(title,connected?"검토 화면에서 원문과 근거를 확인하고 승인할 수 있어요.":"검토 화면은 PC에 유지돼요. 네트워크와 서버 상태를 확인해 주세요.",connected);
            }
            if(type=="job") {
                string state=(string)data["state"], text=state=="PC_REVIEW_REQUIRED"?"수정안이 준비됐어요. PC 검토 화면에서 확인해 주세요.":state=="LOCAL_SAVING"?"승인한 결과를 PC에 저장하고 있어요.":state=="LOCAL_SAVE_COMPLETED"?"PC 저장을 완료했어요.":state=="PROCESSING"?"요청을 처리하고 있어요.":state=="WAITING_FOR_INFORMATION"?"검토에 추가 자료가 필요해요.":state=="REVIEW_COMPLETED"?"검토를 완료했어요.":"작업 상태 · "+state;
                if(recent.Text!=text)AddHistory(text); recent.Text=text;
            }
            if(type=="saved")AddHistory((bool)data["saved"]?"파일 저장과 재읽기를 확인했어요.":"저장 결과 확인이 필요해요. 검토 화면을 열어 주세요.");
            if(type=="error") {
                hadError=true; string code=(string)data["code"], detail;
                if(code=="WORKER_ALREADY_RUNNING")detail="같은 작업공간이 이미 사용 중이에요. 기존 작업을 종료하지 말고 다른 전용 설정을 선택해 주세요.";
                else if(code=="WORKER_LOCK_UNCERTAIN")detail="이전 실행 기록을 안전하게 확인하지 못했어요. 잠금 파일을 임의로 지우지 말고 점검해 주세요.";
                else if(code=="DESKTOP_ENV_INVALID" || code=="INVALID_SERVER_CONFIG")detail="선택한 .env의 AGENT_TOKEN과 서버 주소를 확인해 주세요.";
                else if(code=="PYTHON_PATH_INVALID")detail="금융 코어 설정에 등록한 Python 실행 경로를 확인해 주세요.";
                else detail="연결 설정과 로컬 파일 권한을 확인해 주세요. 오류 코드: "+code;
                SetState("PC 연결을 확인해 주세요.",detail,false); AddHistory("연결 확인 필요 · "+code);
            }
        }
        private void OnExited(int code) {
            bool requested=stopping; worker.Dispose(); viewUrl=null; stopping=false;
            if(!hadError && requested && code==0) { SetState("PC 연결을 종료했어요.","다시 연결하려면 ‘연결 시작’을 눌러 주세요.",false); AddHistory("연결을 종료했어요."); }
            else if(!hadError) { SetState("PC 연결이 예상치 않게 종료됐어요.","연결 설정과 PC 상태를 확인한 뒤 다시 연결해 주세요.",false); AddHistory("실행 상태 확인 필요 · 종료 코드 "+code); }
            ControlsState(); if(closing)Close();
        }
        private void OnClosing(object sender,FormClosingEventArgs args) {
            if(worker.Running) { args.Cancel=true; closing=true; StopWorker(); }
        }
        public void BringForward() { if(WindowState==FormWindowState.Minimized)WindowState=FormWindowState.Normal; Show(); Activate(); Native.SetForegroundWindow(Handle); }
        protected override void Dispose(bool disposing) { if(disposing)worker.Dispose(); base.Dispose(disposing); }
    }

    internal static class Native { [DllImport("user32.dll")]internal static extern bool SetForegroundWindow(IntPtr handle); }
    public static class Program {
        [STAThread] public static int Main(string[] args) {
            Application.EnableVisualStyles(); Application.SetCompatibleTextRenderingDefault(false);
            string root=AppDomain.CurrentDomain.BaseDirectory;
            string shared=null,settings=Settings.DefaultFile(root,Settings.SharedFile);
            bool paired=args.Length==0 || (args.Length==2 && args[0]=="--fixture" && Settings.LocalPath(args[1]));
            if(!paired && args.Length!=0) {
                if(args.Length!=2 || args[0]!="--settings" || !Settings.LocalPath(args[1]))return 2;
                settings=Path.GetFullPath(args[1]);
                shared=null; // Explicit test/operator profiles never replace the default PC connection.
            }
            bool owns=false;
            string channel=paired?"Local\\DIANA.PairedDesktop.v1":"Local\\DIANA.FinancialDesktop.v1";
            if(paired&&args.Length==2){
                using(var hash=System.Security.Cryptography.SHA256.Create())
                    channel+="."+BitConverter.ToString(hash.ComputeHash(Encoding.UTF8.GetBytes(Path.GetFullPath(args[1]).ToUpperInvariant())));
            }
            string activation=paired?channel+".Activate":"Local\\DIANA.FinancialDesktop.Activate.v1";
            using(var mutex=new Mutex(false,channel))
            using(var activate=new EventWaitHandle(false,EventResetMode.AutoReset,activation)) {
                try { owns=mutex.WaitOne(0); } catch(AbandonedMutexException) { owns=true; }
                if(!owns) { activate.Set(); return 0; }
                try {
                    if(paired){
                        using(var app=new PairedForm(root,args.Length==2?args[1]:null)){
                            var registration=ThreadPool.RegisterWaitForSingleObject(activate,delegate {
                                if(app.IsHandleCreated&&!app.IsDisposed)try{app.BeginInvoke(new Action(delegate {
                                    if(app.WindowState==FormWindowState.Minimized)app.WindowState=FormWindowState.Normal;
                                    app.Activate();Native.SetForegroundWindow(app.Handle);
                                }));}catch(InvalidOperationException){}
                            },null,-1,false);
                            try{Application.Run(app);}finally{registration.Unregister(null);}
                        }
                        return 0;
                    }
                    using(var form=new LauncherForm(root,settings,shared,args.Length==0)) {
                        var registration=ThreadPool.RegisterWaitForSingleObject(activate,delegate { if(form.IsHandleCreated&&!form.IsDisposed)try { form.BeginInvoke(new Action(form.BringForward)); } catch(InvalidOperationException) { } },null,-1,false);
                        try { Application.Run(form); } finally { registration.Unregister(null); }
                    }
                } finally { mutex.ReleaseMutex(); }
            }
            return 0;
        }
    }
}

