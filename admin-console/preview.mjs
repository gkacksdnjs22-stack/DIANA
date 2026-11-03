import {createServer} from 'node:http';
import {createAdminConsole,isAdminRequest} from './router.mjs';
const consoleHandler=createAdminConsole();
const port=Number(process.env.ADMIN_PREVIEW_PORT||43879);
if(!Number.isInteger(port)||port<1024||port>65535)throw Error('PREVIEW_PORT_INVALID');
const server=createServer((req,res)=>{
  if(isAdminRequest(req.url))void consoleHandler.handle(req,res);
  else{res.writeHead(302,{Location:'/admin/','Cache-Control':'no-store'});res.end();}
});
server.listen(port,'127.0.0.1',()=>console.log('DIANA 관리자 미리보기: http://127.0.0.1:'+port+'/admin/ · 인증 연결 꺼짐'));
