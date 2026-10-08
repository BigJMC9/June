'use strict';
// Protocol fixture, not an LLM: used only by backend_ui.py.
const {setup,chatReply}=require('./backend-helpers.cjs');
const {serve}=require('../backend/server.cjs');
const cleanup=[];const t={after:fn=>cleanup.unshift(fn)};
(async()=>{
 const ctx=await setup(t,{chat:(d,res)=>{
   const q=[...d.messages].reverse().find(m=>m.role==='user')?.content||'';
   if(d.messages.some(m=>m.role==='tool'))return chatReply(res,{content:'Tool completed. The requested action was processed.'});
   if(q.includes('slow stream')){res.writeHead(200,{'Content-Type':'application/x-ndjson'});let n=0;const timer=setInterval(()=>{res.write(JSON.stringify({message:{content:'working '}})+'\n');if(++n===100){clearInterval(timer);res.end(JSON.stringify({message:{content:'finished'},done:true})+'\n');}},80);res.once('close',()=>clearInterval(timer));return;}
   if(q.includes('write a file')&&d.tools?.some(t=>t.function.name==='write_file'))return chatReply(res,{content:'Proposing a file.',tool_calls:[{function:{name:'write_file',arguments:{path:'new-test.js',expectedSha:'new',content:'export const tested = true;\n'}}}]});
   if(q.includes('MCP echo')){const mcp=d.tools?.find(t=>t.function.name.startsWith('mcp_'));if(mcp)return chatReply(res,{tool_calls:[{function:{name:mcp.function.name,arguments:{text:'hello from June'}}}]});}
   res.writeHead(200,{'Content-Type':'application/x-ndjson'});const words=['A streamed ', 'Ollama fixture response. ', 'The source describes authentication.'];let i=0;
   const timer=setInterval(()=>{if(i<words.length)res.write(JSON.stringify({message:{role:'assistant',content:words[i++]}})+'\n');else{clearInterval(timer);res.end(JSON.stringify({message:{content:''},done:true,eval_count:15,eval_duration:1e9})+'\n');}},20);res.once('close',()=>clearInterval(timer));
 }});
 const token='test-only-token-'+require('node:crypto').randomBytes(24).toString('hex');const host=await serve({backend:ctx.backend,token,port:0});cleanup.unshift(()=>host.close());
 console.log(JSON.stringify({url:'http://127.0.0.1:'+host.server.address().port,token,project:ctx.project,ollama:ctx.ollama.url,node:process.execPath,mcp:require('node:path').join(__dirname,'fixtures','mcp-server.cjs')}));
 process.once('SIGTERM',async()=>{for(const fn of cleanup)await fn().catch(()=>{});process.exit(0);});
})().catch(e=>{console.error(e);process.exit(1);});
