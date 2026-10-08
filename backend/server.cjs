'use strict';
/* Optional headless transport. The desktop uses IPC and opens no HTTP port. */
const http = require('node:http');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { createBackend } = require('./service.cjs');
const { fail } = require('./util.cjs');
async function serve({dataDir,token,port=8765,backend}) {
  if(typeof token!=='string'||token.length<32)throw fail('Set JUNE_API_TOKEN to a random secret of at least 32 characters.');
  const service=backend||await createBackend(dataDir); const owners=new Set();
  const json=(res,status,payload)=>{res.writeHead(status,{'Content-Type':'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(payload));};
  const authorized=req=>{const value=req.headers.authorization; if(typeof value!=='string'||!value.startsWith('Bearer '))return false;const a=Buffer.from(value.slice(7)),b=Buffer.from(token);return a.length===b.length&&crypto.timingSafeEqual(a,b);};
  const server=http.createServer(async(req,res)=>{
    const actualPort=server.address().port;
    if(req.headers.origin!==undefined||!['127.0.0.1:'+actualPort,'localhost:'+actualPort].includes(req.headers.host)){json(res,403,{error:'Origin or Host not allowed.'});return;}
    if(req.method==='GET'&&req.url==='/health'){json(res,200,{ok:true,service:'June',version:'0.2.0'});return;}
    if(!authorized(req)){json(res,401,{error:'Authentication required.'});return;}
    if(req.method!=='POST'||!['/api/invoke','/api/stream'].includes(req.url)){json(res,404,{error:'Endpoint not found.'});return;}
    if(!(req.headers['content-type']||'').startsWith('application/json')){json(res,415,{error:'Use application/json.'});return;}
    try{
      let size=0;const chunks=[];for await(const chunk of req){size+=chunk.length;if(size>2300000)throw fail('Request body exceeds 2.3 MB.');chunks.push(chunk);}
      const {action,data={}}=JSON.parse(Buffer.concat(chunks).toString('utf8'));
      // One API owner per authenticated headless server. The bearer token is a privileged capability.
      const owner='headless';
      if(req.url==='/api/stream'){
        if(!['run.start','rag.index'].includes(action))throw fail('Only chat and indexing jobs can stream.');
        const events=[];let started=false;
        const emit=event=>{if(!started){events.push(event);return;}if(res.destroyed||res.writableLength>1048576){service.cancelOwner(owner);return;}res.write('data: '+JSON.stringify(event)+'\n\n');if(['done','error','cancelled'].includes(event.type))res.end();};
        await service.invoke(action,data,owner,emit);
        res.writeHead(200,{'Content-Type':'text/event-stream','Cache-Control':'no-store','Connection':'keep-alive','X-Content-Type-Options':'nosniff'});res.flushHeaders();started=true;events.forEach(emit);
        owners.add(owner);const heartbeat=setInterval(()=>{if(!res.destroyed)res.write(': keep-alive\n\n');},15000);
        res.once('close',()=>{clearInterval(heartbeat);owners.delete(owner);service.cancelOwner(owner);});
      } else {
        if(['run.start','rag.index'].includes(action))throw fail('Start streaming jobs at /api/stream.');
        const result=await service.invoke(action,data,owner);json(res,200,{ok:true,result});
      }
    }catch(e){if(!res.headersSent)json(res,400,{ok:false,error:String(e.message||'Request failed.'),code:e.code||'BAD_REQUEST'});else res.end();}
  });
  server.requestTimeout=30000;server.headersTimeout=10000;
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(port,'127.0.0.1',resolve);});
  return {server,service,close:async()=>{for(const owner of owners)service.cancelOwner(owner);await service.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
if(require.main===module){
  const args=process.argv.slice(2),rootArg=args.indexOf('--project');
  serve({dataDir:process.env.JUNE_DATA_DIR||path.join(os.homedir(),'.june-backend'),token:process.env.JUNE_API_TOKEN,port:Number(process.env.JUNE_PORT||8765)}).then(async host=>{
    try { if(rootArg!==-1){if(!args[rootArg+1])throw fail('--project requires a directory.');await host.service.workspace.addProject(path.resolve(args[rootArg+1]));} } catch(error) { await host.close();throw error; }
    console.log(`June backend listening on 127.0.0.1:${host.server.address().port}. Requests require the configured bearer token.`);
    for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>void host.close().then(()=>process.exit(0)));
  }).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={serve};
