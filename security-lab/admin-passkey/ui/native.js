const requestId=new URL(location.href).searchParams.get('request');
const button=document.getElementById('authenticate'),status=document.getElementById('status');
async function post(action,body,token){const r=await fetch('/api/'+action,{method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});if(!r.ok)throw Error();return r.json();}
button.onclick=async()=>{button.disabled=true;try{
  const begin=await post('login/begin',{});
  const response=await SimpleWebAuthnBrowser.startAuthentication({optionsJSON:begin.options});
  const login=await post('login/finish',{ceremonyId:begin.ceremonyId,response});
  const result=await post('native/approve',{requestId},login.sessionToken);
  location.replace(result.redirect);
}catch{status.textContent='인증이 취소되었거나 요청이 만료되었습니다. 시험 앱에서 다시 시작하세요.';button.disabled=false;}};
