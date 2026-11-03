import {isAdminRequest} from './router.mjs';
const mounted=new WeakSet();

/** Mount before listen; preserve the same server, legacy listener and close hooks. */
export function mountAdminConsole(server,consoleHandler){
  const listeners=server.listeners('request');
  if(server.listening||mounted.has(server)||listeners.length!==1||typeof consoleHandler?.handle!=='function')throw Error('ADMIN_MOUNT_REQUIRES_ONE_UNSTARTED_HANDLER');
  const legacy=listeners[0];server.removeListener('request',legacy);
  server.on('request',function(req,res){
    if(isAdminRequest(req.url)){
      void consoleHandler.handle(req,res).catch(()=>{if(!res.headersSent)res.writeHead(503,{'Content-Type':'application/json','Cache-Control':'no-store'});res.end('{"code":"ADMIN_UNAVAILABLE"}');});
    }else legacy.call(this,req,res);
  });
  mounted.add(server);
  return server;
}
