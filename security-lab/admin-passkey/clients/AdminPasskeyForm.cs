using System;
using System.Diagnostics;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;
namespace Diana.Lab.Passkey {
    public sealed class AdminPasskeyForm:Form {
        private readonly Label status=new Label();
        public AdminPasskeyForm(AdminPasskeyClient client) {
            Text="DIANA LAB PASSKEY · 관리자 인증";ClientSize=new Size(600,275);StartPosition=FormStartPosition.CenterParent;
            status.SetBounds(20,20,560,90);status.Text="관리자 인증은 PC 문서 접근·최종 승인과 별개입니다.\n서버 연결 실패 시 관리자 세션을 사용할 수 없습니다.";Controls.Add(status);
            Add("관리자 패스키 로그인",20,async()=>{await client.Login(url=>Process.Start(new ProcessStartInfo(url){UseShellExecute=true}));return "관리자 인증 완료 · "+await client.Status()+" · 문서 권한 별도";});
            Add("관리자 세션 확인",210,async()=>"현재 서버 확인: "+await client.Status()+" · 문서 권한 별도");
            Add("관리자 로그아웃",400,async()=>{await client.Logout();return "관리자 세션을 종료했습니다.";});
        }
        private void Add(string text,int left,Func<Task<string>> work) {
            var button=new Button{Text=text,Left=left,Top=150,Width=170,Height=48};Controls.Add(button);
            button.Click+=async delegate {button.Enabled=false;try{status.Text=await work();}catch{status.Text="인증 거부·취소·세션 폐기 또는 서버 연결 실패.\n관리자 권한을 사용할 수 없습니다.";}finally{button.Enabled=true;}};
        }
    }
}
