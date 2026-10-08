'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {setup,collect,chatReply,fixture}=require('./backend-helpers.cjs');
const {Workspace,relativePath,parseStatus,runCommand}=require('../backend/workspace.cjs');
const {validateConfig,DEFAULTS}=require('../backend/config.cjs');
const {lines,cleanEnvironment}=require('../backend/util.cjs');
const {serve}=require('../backend/server.cjs');
const {validateRequest}=require('../backend/service.cjs');
const {searchConversation,readConversation}=require('../backend/conversation.cjs');

test('Archived conversation search returns numbered matches and supports paged reading',()=>{
 const archive=[{index:1,role:'user',content:'The auth token expires after seven minutes.'},{index:2,role:'assistant',content:'A different topic.'}];
 assert.deepEqual(searchConversation(archive,'auth token',3).map(item=>item.index),[1]);
 assert.deepEqual(searchConversation(archive,'no matching phrase',3),[]);
 const first=readConversation(archive,1,0,12);assert.equal(first.hasMore,true);assert.equal(first.content,'The auth tok');
 assert.match(readConversation(archive,1,12,100).content,/expires after seven minutes/);
 assert.match(readConversation(archive,99).error,/not found/);
});

test('Agent can search and read only the archived messages supplied for its chat',async t=>{
 const {backend,ollama}=await setup(t,{chat:(data,res)=>{
   const toolResults=data.messages.filter(item=>item.role==='tool');
   if(!toolResults.length)return chatReply(res,{tool_calls:[{function:{name:'search_conversation',arguments:{query:'auth token'}}}]});
   if(toolResults.length===1)return chatReply(res,{tool_calls:[{function:{name:'read_conversation',arguments:{index:7}}}]});
   return chatReply(res,{content:'The token expires after seven minutes; see conversation message #7.'});
 }});
 const archive=[{index:7,role:'user',content:'The auth token expires after seven minutes.'}];
 const run=collect(backend,{mode:'agent',messages:[{role:'user',content:'What did we decide about the auth token?'}],conversationArchive:archive});
 await run.start;assert.equal((await run.completion).type,'done');
 const calls=ollama.calls.filter(item=>item.url==='/api/chat');
 assert.equal(calls.length,3);assert.ok(calls[0].data.tools.some(tool=>tool.function.name==='search_conversation'));
 assert.ok(!JSON.stringify(calls[0].data.messages).includes('expires after seven minutes'));
 assert.match(calls[1].data.messages.find(item=>item.role==='tool').content,/conversation|excerpt|auth token/i);
 assert.match(calls[2].data.messages.filter(item=>item.role==='tool')[1].content,/expires after seven minutes/);
 assert.equal(run.events.some(item=>item.type==='approval_required'),false);
});

test('Models without tool support receive relevant archived excerpts automatically',async t=>{
 const {backend,ollama}=await setup(t,{noTools:true});
 const run=collect(backend,{mode:'chat',conversationArchive:[{index:3,role:'user',content:'The deployment window is Tuesday at noon.'}],messages:[{role:'user',content:'When is the deployment window?'}]});
 await run.start;assert.equal((await run.completion).type,'done');
 const sent=ollama.calls.find(item=>item.url==='/api/chat').data;
 assert.ok(!sent.tools);assert.match(JSON.stringify(sent.messages),/Tuesday at noon/);
 assert.deepEqual(run.events.find(item=>item.type==='conversation_sources').sources.map(item=>item.index),[3]);
});
test('A printed conversation search request is executed as a read-only tool call',async t=>{
 const {backend}=await setup(t,{chat:(data,res)=>data.messages.some(item=>item.role==='tool')?chatReply(res,{content:'The decision is in conversation message #2.'}):chatReply(res,{content:'I should search the older conversation. {"name":"search_conversation","arguments":{"query":"token expiry"}}'})});
 const run=collect(backend,{conversationArchive:[{index:2,role:'user',content:'Token expiry is one hour.'}],messages:[{role:'user',content:'What was the token expiry?'}]});
 await run.start;assert.equal((await run.completion).type,'done');
 assert.equal(run.events.find(item=>item.type==='tool_done').name,'search_conversation');
 assert.equal(run.events.filter(item=>item.type==='content_reset').length,1);
});

test('Agent prompts and summary output cap reach Ollama without converting chat history to system messages',async t=>{
 const {backend,ollama}=await setup(t);
 const run=collect(backend,{agentSystemPrompt:'Be concise.',agentInstructions:'Use file paths.',maxOutputTokens:256,messages:[{role:'system',content:'Prior reviewed context'},{role:'user',content:'Explain this'}]});
 await run.start;assert.equal((await run.completion).type,'done');
 const call=ollama.calls.find(item=>item.url==='/api/chat').data;
 assert.equal(call.options.num_predict,256);
 assert.match(call.messages[0].content,/Be concise/);assert.match(call.messages[0].content,/Use file paths/);
 assert.equal(call.messages.filter(item=>item.role==='system').length,1);
 assert.match(call.messages.find(item=>item.content.includes('Prior reviewed context')).content,/User-reviewed context/);
 assert.throws(()=>validateRequest({mode:'chat',model:'test-coder',messages:[{role:'user',content:'x'}],maxOutputTokens:999999},DEFAULTS),/Output token budget/);
});

test('Ollama HTTP model discovery and streaming work through the real backend',async t=>{
 const {backend,ollama}=await setup(t);const models=await backend.invoke('models');assert.equal(models.models[0].name,'test-coder');
 const r=collect(backend,{});await r.start;assert.equal((await r.completion).type,'done');assert.equal(r.events.filter(x=>x.type==='token').map(x=>x.content).join(''),'Hello, world! Done.');
 assert.equal(ollama.calls.find(c=>c.url==='/api/chat').data.stream,true);assert.ok(!ollama.calls.find(c=>c.url==='/api/chat').data.tools);
});
test('UTF-8 stream decoder tolerates multibyte characters split across bytes',async()=>{
 const b=Buffer.from('hello \u65e5\u672c\nlast');const body=new ReadableStream({start(c){for(const byte of b)c.enqueue(Uint8Array.of(byte));c.close();}});const out=[];for await(const s of lines(body))out.push(s);assert.deepEqual(out,['hello \u65e5\u672c','last']);
});
test('Malformed or incomplete Ollama streams are errors, never fake completed replies',async t=>{
 const {backend}=await setup(t,{chat:(_d,res)=>{res.writeHead(200,{'Content-Type':'application/x-ndjson'});res.end('{"message":{"content":"partial"}}\n');}});
 const r=collect(backend,{});await r.start;assert.equal((await r.completion).type,'error');assert.equal(r.events.find(e=>e.type==='token').content,'partial');
});
test('Chat model capability mismatch is actionable and executes no tools',async t=>{
 const {backend,project,ollama}=await setup(t,{noTools:true});const r=collect(backend,{mode:'agent',projectPath:project});await r.start;
 assert.equal((await r.completion).code,'TOOLS_UNSUPPORTED');assert.ok(!ollama.calls.some(c=>c.url==='/api/chat'));
});
test('Chat without model tool support still uses the project overview',async t=>{
 const {backend,project,ollama}=await setup(t,{noTools:true,chat:(_d,res)=>chatReply(res,{content:'The project documents an authentication token flow.'})});
 const r=collect(backend,{mode:'chat',projectPath:project,messages:[{role:'user',content:'Explain what this repo does?'}]});await r.start;
 assert.equal((await r.completion).type,'done');
 const payload=ollama.calls.find(c=>c.url==='/api/chat').data;
 assert.equal(payload.tools,undefined);
 assert.match(payload.messages.find(m=>m.content.includes('Retrieved project data')).content,/Authentication token flow/);
 assert.ok(r.events.some(e=>e.type==='warning'&&/cannot call file tools/.test(e.message)));
});
test('Embedding-only model is rejected for chat',async t=>{const {backend}=await setup(t);const r=collect(backend,{model:'test-embed'});await r.start;assert.match((await r.completion).message,/embedding/);});
test('Agent read tools return real project text to Ollama and continue the loop',async t=>{
 const {backend,project,ollama}=await setup(t,{chat:(d,res)=>d.messages.some(m=>m.role==='tool')?chatReply(res,{content:'I read readme.md.'}):chatReply(res,{content:'Inspecting.',tool_calls:[{function:{name:'read_file',arguments:{path:'readme.md'}}}]})});
 const r=collect(backend,{mode:'agent',projectPath:project});await r.start;assert.equal((await r.completion).type,'done');
 const second=ollama.calls.filter(c=>c.url==='/api/chat')[1];assert.match(second.data.messages.find(m=>m.role==='tool').content,/Authentication token flow/);assert.equal(r.events.filter(e=>e.type==='tool_done').length,1);
});
test('Chat inspects an open repo through read-only tools and answers from the files',async t=>{
 const {backend,project,ollama}=await setup(t,{chat:(d,res)=>{
   const results=d.messages.filter(m=>m.role==='tool');
   if(results.length===0)return chatReply(res,{tool_calls:[{function:{name:'list_directory',arguments:{}}}]});
   if(results.length===1)return chatReply(res,{tool_calls:[{function:{name:'read_file',arguments:{path:'readme.md'}}}]});
   return chatReply(res,{content:'This project documents an authentication token flow.'});
 }});
 await backend.invoke('config.update',{writesEnabled:true,terminalEnabled:true});
 const r=collect(backend,{mode:'chat',projectPath:project,messages:[{role:'user',content:'Explain what this repo does?'}]});
 await r.start;assert.equal((await r.completion).type,'done');
 const requests=ollama.calls.filter(c=>c.url==='/api/chat');
 assert.equal(requests.length,3);
 assert.equal(r.events.find(e=>e.type==='metrics').outputTokens,9);
 assert.deepEqual(requests[0].data.tools.map(t=>t.function.name),['list_directory','read_file','search_files']);
 assert.match(requests[1].data.messages.find(m=>m.role==='tool').content,/readme\.md/);
 assert.match(requests[2].data.messages.filter(m=>m.role==='tool')[1].content,/Authentication token flow/);
 assert.equal(r.events.filter(e=>e.type==='tool_done'&&e.ok).length,2);
 assert.equal(r.events.some(e=>e.type==='approval_required'),false);
 assert.match(r.events.filter(e=>e.type==='token').map(e=>e.content).join(''),/authentication token flow/);
});
test('Repo overview context includes README without requiring a model tool call or RAG',async t=>{
 const {backend,project,ollama}=await setup(t,{chat:(_d,res)=>chatReply(res,{content:'This project documents an authentication token flow.'})});
 await fs.writeFile(path.join(project,'package.json'),'{"name":"auth-demo"}');
 const r=collect(backend,{mode:'chat',projectPath:project,useRag:false,messages:[{role:'user',content:'Explain what this repo does?'}]});
 await r.start;assert.equal((await r.completion).type,'done');
 const sent=ollama.calls.find(c=>c.url==='/api/chat').data.messages;
 assert.match(sent.find(m=>m.content.includes('Retrieved project data')).content,/Authentication token flow/);
 assert.match(sent.find(m=>m.content.includes('Retrieved project data')).content,/auth-demo/);
 assert.deepEqual(r.events.find(e=>e.type==='sources').sources.map(s=>s.path),['readme.md','package.json']);
 assert.equal(r.events.some(e=>e.type==='tool_start'),false);
});
test('Printed read-tool requests from a local model run as read-only calls',async t=>{
 const printed='To understand what this repo does, I need to list the project files and directories. Please run the following command:\n\n{"name": "list_directory", "arguments": {}}';
 const {backend,project,ollama}=await setup(t,{chat:(d,res)=>d.messages.some(m=>m.role==='tool')?chatReply(res,{content:'The repository contains readme.md.'}):chatReply(res,{content:printed})});
 const r=collect(backend,{mode:'chat',projectPath:project,messages:[{role:'user',content:'Explain what this repo does?'}]});
 await r.start;assert.equal((await r.completion).type,'done');
 assert.equal(r.events.filter(e=>e.type==='content_reset').length,1);
 assert.equal(r.events.find(e=>e.type==='tool_done').name,'list_directory');
 assert.equal(ollama.calls.filter(c=>c.url==='/api/chat').length,2);
});
test('Printed read-tool request with a different lead-in is recognized',async t=>{
 const {backend,project}=await setup(t,{chat:(d,res)=>d.messages.some(m=>m.role==='tool')?chatReply(res,{content:'Found the README.'}):chatReply(res,{content:'Let us start by listing the directory contents.\n\n{"name":"list_directory","arguments":{"path":""}}'})});
 const r=collect(backend,{mode:'chat',projectPath:project});await r.start;assert.equal((await r.completion).type,'done');
 assert.equal(r.events.find(e=>e.type==='tool_done').name,'list_directory');
});
test('Printed write requests are never converted into tool calls',async t=>{
 const {backend,project}=await setup(t,{chat:(_d,res)=>chatReply(res,{content:'{"name":"write_file","arguments":{"path":"no.js","expectedSha":"new","content":"no"}}'})});
 await backend.invoke('config.update',{writesEnabled:true});
 const r=collect(backend,{mode:'agent',projectPath:project});await r.start;assert.equal((await r.completion).type,'done');
 assert.equal(r.events.some(e=>e.type==='tool_start'||e.type==='content_reset'),false);
 await assert.rejects(fs.stat(path.join(project,'no.js')),{code:'ENOENT'});
});
test('Plan is read-only even when write and terminal tools are configured',async t=>{
 const {backend,project,ollama}=await setup(t);await backend.invoke('config.update',{writesEnabled:true,terminalEnabled:true});const r=collect(backend,{mode:'plan',projectPath:project});await r.start;await r.completion;
 const names=ollama.calls.find(c=>c.url==='/api/chat').data.tools.map(t=>t.function.name);assert.ok(names.includes('read_file'));assert.ok(!names.includes('write_file'));assert.ok(!names.includes('run_command'));
});
test('Writes wait for explicit same-owner approval and cannot reuse an approval',async t=>{
 const {backend,project}=await setup(t,{chat:(d,res)=>d.messages.some(m=>m.role==='tool')?chatReply(res,{content:'Done'}):chatReply(res,{tool_calls:[{function:{name:'write_file',arguments:{path:'new.js',expectedSha:'new',content:'export const ok = true;'}}}]})});
 await backend.invoke('config.update',{writesEnabled:true});const r=collect(backend,{mode:'agent',projectPath:project});await r.start;const a=await r.wait('approval_required');
 await assert.rejects(fs.stat(path.join(project,'new.js')),{code:'ENOENT'});
 await assert.rejects(backend.invoke('run.approve',{id:a.id,approvalId:a.approvalId,approved:true},'foreign'),/not found/);
 await backend.invoke('run.approve',{id:a.id,approvalId:a.approvalId,approved:true},'test');assert.equal((await r.completion).type,'done');assert.equal(await fs.readFile(path.join(project,'new.js'),'utf8'),'export const ok = true;');
 await assert.rejects(backend.invoke('run.approve',{id:a.id,approvalId:a.approvalId,approved:true},'test'),/not found/);
});
test('Deny and cancellation never apply a pending edit',async t=>{
 const {backend,project}=await setup(t,{chat:(d,res)=>d.messages.some(m=>m.role==='tool')?chatReply(res,{content:'Denied'}):chatReply(res,{tool_calls:[{function:{name:'write_file',arguments:{path:'no.js',expectedSha:'new',content:'no'}}}]})});
 await backend.invoke('config.update',{writesEnabled:true});const r=collect(backend,{mode:'agent',projectPath:project});await r.start;const a=await r.wait('approval_required');await backend.invoke('run.approve',{id:a.id,approvalId:a.approvalId,approved:false},'test');await r.completion;
 await assert.rejects(fs.stat(path.join(project,'no.js')),{code:'ENOENT'});
 const c=collect(backend,{id:'cancel-edit',mode:'agent',projectPath:project});await c.start;await c.wait('approval_required');await backend.invoke('job.cancel',{id:'cancel-edit'},'test');assert.equal((await c.completion).type,'cancelled');await assert.rejects(fs.stat(path.join(project,'no.js')),{code:'ENOENT'});
});
test('External file changes between approval and write prevent overwrite',async t=>{
 const {backend,project}=await setup(t);const old=await backend.workspace.readFile(project,'readme.md');
 const p=await backend.workspace.prepareWrite(project,{path:'readme.md',expectedSha:old.sha,content:'new'});await fs.writeFile(path.join(project,'readme.md'),'external change');
 await assert.rejects(backend.workspace.commitWrite(project,p),/changed/);assert.equal(await fs.readFile(path.join(project,'readme.md'),'utf8'),'external change');
});
test('Temporary requests exclude memories, approved skills, RAG, MCP and backend persistence',async t=>{
 const {backend,project,dataDir,ollama}=await setup(t);await backend.invoke('config.update',{rag:{enabled:true}});
 const marker='private-'+Date.now();const r=collect(backend,{temporary:true,projectPath:project,mode:'agent',messages:[{role:'user',content:marker}],memories:[{content:'DO_NOT_SEND_MEMORY',enabled:true}],skills:[{title:'Skill',how:'DO_NOT_SEND_SKILL',approved:true}]});await r.start;await r.completion;
 const payload=JSON.stringify(ollama.calls.find(c=>c.url==='/api/chat').data);assert.ok(payload.includes(marker));assert.ok(!payload.includes('DO_NOT_SEND'));assert.ok(!r.events.some(e=>e.type==='sources'));
 async function check(dir){for(const entry of await fs.readdir(dir,{withFileTypes:true})){const full=path.join(dir,entry.name);if(entry.isDirectory())await check(full);else assert.ok(!(await fs.readFile(full)).includes(Buffer.from(marker)),full);}}await check(dataDir);
});
test('Unknown tool names never reach filesystem execution',async t=>{
 const {backend,project}=await setup(t,{chat:(d,res)=>d.messages.some(m=>m.role==='tool')?chatReply(res,{content:'Cannot'}):chatReply(res,{tool_calls:[{function:{name:'delete_everything',arguments:{}}}]})});
 const r=collect(backend,{mode:'agent',projectPath:project});await r.start;await r.completion;assert.equal(r.events.find(e=>e.type==='tool_done').ok,false);
});
test('Bounded agent loop stops repetitive tools',async t=>{
 const {backend,project}=await setup(t,{chat:(_d,res)=>chatReply(res,{tool_calls:[{function:{name:'list_directory',arguments:{}}}]})});await backend.invoke('config.update',{maxAgentSteps:2});
 const r=collect(backend,{mode:'agent',projectPath:project});await r.start;assert.equal((await r.completion).code,'STEP_LIMIT');
});
test('Root authorization, traversal, symlinks, hardlinks and credential exclusions',async t=>{
 const {backend,project,dir}=await setup(t);const ws=backend.workspace;
 await assert.rejects(ws.readFile(dir,'package.json'),/Open this project/);
 for(const p of ['../x','/etc/passwd','C:\\Windows\\x','foo/../../bar','x:stream'])assert.throws(()=>relativePath(p));
 assert.equal(relativePath('..config/test.js'),'..config/test.js');
 await fs.writeFile(path.join(project,'.env'),'SECRET=yes');await assert.rejects(ws.readFile(project,'.env',2000,true),/Credential/);
 await fs.writeFile(path.join(dir,'outside.txt'),'secret');await fs.symlink(path.join(dir,'outside.txt'),path.join(project,'linked.txt'));await assert.rejects(ws.readFile(project,'linked.txt'),/links/);
 await fs.link(path.join(dir,'outside.txt'),path.join(project,'hard.txt'));await assert.rejects(ws.readFile(project,'hard.txt'),/linked/);
});
test('Binary and oversized files are not returned as source text',async t=>{
 const {backend,project}=await setup(t);await fs.writeFile(path.join(project,'binary.bin'),Buffer.from([0,1,2]));await fs.writeFile(path.join(project,'large.txt'),'x'.repeat(2000));
 assert.equal((await backend.workspace.readFile(project,'binary.bin')).binary,true);assert.equal((await backend.workspace.readFile(project,'large.txt',1024)).tooLarge,true);
});
test('Git NUL parser preserves spaces, newlines and rename targets',()=>{const r=parseStatus('## main...origin/main\0 M file with space.txt\0R  new\nname.txt\0old name.txt\0');assert.equal(r.branch,'main');assert.equal(r.files[1].path,'new\nname.txt');assert.equal(r.files[1].originalPath,'old name.txt');});
test('Configuration validates remote URLs, limits and MCP argument types',()=>{
 for(const patch of [{ollamaUrl:'http://evil.test'},{ollamaUrl:'https://x.test',allowRemoteOllama:false},{maxAgentSteps:0},{contextBudget:2048,maxOutputTokens:4096},{ollamaTokenEnv:'secret value'},{mcpServers:[{id:'x',name:'X',transport:'stdio',command:'npx.cmd',args:[]}]}])assert.throws(()=>validateConfig({...structuredClone(DEFAULTS),...patch}));
 assert.equal(validateConfig({...structuredClone(DEFAULTS),ollamaUrl:'https://example.test',allowRemoteOllama:true}).allowRemoteOllama,true);
});
test('Subprocesses inherit no secret environment implicitly',()=>{process.env.JUNE_TEST_SECRET='do-not-leak';process.env.NODE_OPTIONS='--trace-warnings';try{assert.equal(cleanEnvironment().JUNE_TEST_SECRET,undefined);assert.equal(cleanEnvironment().NODE_OPTIONS,undefined);assert.equal(cleanEnvironment(['JUNE_TEST_SECRET']).JUNE_TEST_SECRET,'do-not-leak');}finally{delete process.env.JUNE_TEST_SECRET;delete process.env.NODE_OPTIONS;}});
test('Approved command execution uses actual argv and captures output',async t=>{
 const {backend,project}=await setup(t);const r=await runCommand(backend.workspace,project,{executable:process.execPath,args:['-e','process.stdout.write(JSON.stringify(process.argv.slice(1)))','a; echo not-a-shell'],cwd:''},new AbortController().signal);
 assert.equal(r.code,0);assert.match(r.stdout,/a; echo not-a-shell/);
});
test('Headless API is loopback-bound, authenticated and rejects browser origins',async t=>{
 const {backend}=await setup(t);const token='x'.repeat(40),host=await serve({backend,token,port:0});t.after(()=>host.close());const base='http://127.0.0.1:'+host.server.address().port;
 assert.equal((await fetch(base+'/health')).status,200);
 assert.equal((await fetch(base+'/api/invoke',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"state"}'})).status,401);
 assert.equal((await fetch(base+'/api/invoke',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token,origin:'https://evil.test'},body:'{"action":"state"}'})).status,403);
 const response=await fetch(base+'/api/invoke',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+token},body:'{"action":"models"}'});assert.equal(response.status,200);assert.equal((await response.json()).result.models[0].name,'test-coder');
});
