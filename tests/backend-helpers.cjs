'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),http=require('node:http');
const {createBackend}=require('../backend/service.cjs');
async function fixture(){return fs.mkdtemp(path.join(os.tmpdir(),'june-backend-test-'));}
async function ollamaFixture(t, chatHandler, extra={}) {
  const calls=[];let digest='embedding-v1';
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;
    const data=body?JSON.parse(body):null;calls.push({url:req.url,data});
    const json=v=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify(v));};
    if(req.url==='/api/tags')return json({models:[{name:'test-coder',digest:'coder-v1',size:1024,details:{parameter_size:'test'}},{name:'test-embed',digest,size:512}]});
    if(req.url==='/api/show')return json({capabilities:data.model==='test-embed'?['embedding']:extra.noTools?['completion']:['completion','tools']});
    if(req.url==='/api/embed')return json({embeddings:data.input.map(s=>{const text=s.toLowerCase();return [1+(text.match(/auth|login|token/g)||[]).length,1+(text.match(/database|query|sql/g)||[]).length,1+(text.match(/render|ui|button/g)||[]).length,1]})});
    if(req.url==='/api/chat'){
      if(chatHandler)return chatHandler(data,res);
      res.writeHead(200,{'Content-Type':'application/x-ndjson'});
      const stream=Buffer.from(JSON.stringify({message:{role:'assistant',content:'Hello, world!'}})+'\n'+JSON.stringify({message:{role:'assistant',content:' Done.'},done:true,eval_count:4,eval_duration:1e9})+'\n');
      for(let i=0;i<stream.length;i+=7)res.write(stream.subarray(i,i+7));res.end();return;
    }
    res.writeHead(404);res.end();
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));t.after(()=>new Promise(resolve=>{server.closeAllConnections();server.close(resolve);}));
  return {url:`http://127.0.0.1:${server.address().port}`,calls,setDigest:d=>{digest=d;}};
}
function chatReply(res,message,stats={}){res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end(JSON.stringify({message:{role:'assistant',...message},done:true,eval_count:3,eval_duration:1e9,...stats})+'\n');}
async function setup(t, options={}) {
  const dir=await fixture(t),project=path.join(dir,'project'),dataDir=path.join(dir,'data');await fs.mkdir(project);await fs.writeFile(path.join(project,'readme.md'),'# Project\nAuthentication token flow.\n');
  const ollama=await ollamaFixture(t,options.chat,options),backend=await createBackend(dataDir,options.backendOptions);
  t.after(async()=>{await backend.close();await fs.rm(dir,{recursive:true,force:true});});await backend.workspace.addProject(project);
  await backend.invoke('config.update',{ollamaUrl:ollama.url,chatModel:'test-coder',embeddingModel:'test-embed'});
  return {dir,project,dataDir,backend,ollama};
}
function collect(backend, data, owner='test') {
  const events=[];let done;
  const completion=new Promise(resolve=>{done=resolve;});
  const start=backend.invoke(data.action||'run.start',{id:data.id||'test-run',mode:'chat',model:'test-coder',messages:[{role:'user',content:'Hello'}],...data},owner,e=>{events.push(e);if(['done','error','cancelled'].includes(e.type))done(e);});
  return {events,start,completion,wait:async type=>{const began=Date.now();for(;;){const event=events.find(e=>e.type===type);if(event)return event;if(Date.now()-began>5000)throw Error(`Timeout waiting for ${type}: ${JSON.stringify(events)}`);await new Promise(r=>setTimeout(r,5));}}};
}
module.exports={fixture,setup,ollamaFixture,chatReply,collect};
