'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path');
const {execFile}=require('node:child_process');const {promisify}=require('node:util');const exec=promisify(execFile);
const {setup,collect}=require('./backend-helpers.cjs');const {chunksOf,cosine}=require('../backend/rag.cjs');
async function index(backend,project,id='index-run'){const r=collect(backend,{id,action:'rag.index',projectPath:project});await r.start;const end=await r.completion;assert.equal(end.type,'done',JSON.stringify(end));return end.result;}
test('Line-aware chunking retains exact line spans and overlapping context',()=>{const s=Array.from({length:100},(_,i)=>'line '+(i+1)).join('\n'),chunks=chunksOf(s,'a.js');assert.equal(chunks[0].start,1);assert.equal(chunks[0].end,45);for(const c of chunks)assert.equal(c.text,s.split('\n').slice(c.start-1,c.end).join('\n'));assert.ok(chunks[1].start<45);assert.equal(cosine([1,0],[1,0]),1);});
test('RAG index excludes credential files, generated folders, binary and links',async t=>{
 const {backend,project}=await setup(t);await fs.writeFile(path.join(project,'.env'),'SECRET=abc');await fs.mkdir(path.join(project,'node_modules'));await fs.writeFile(path.join(project,'node_modules','secret.js'),'password');await fs.writeFile(path.join(project,'binary.js'),Buffer.from([0,1,2]));
 await fs.symlink(path.join(project,'readme.md'),path.join(project,'alias.md'));
 const r=await index(backend,project);assert.equal(r.files,1);assert.equal(backend.rag.rows(project)[0].path,'readme.md');
});
test('Git ignore rules are honored by indexing',async t=>{
 const {backend,project}=await setup(t);await exec('git',['init','-q',project]);await fs.writeFile(path.join(project,'.gitignore'),'ignored.js\n');await fs.writeFile(path.join(project,'ignored.js'),'sensitive source');
 const result=await index(backend,project);assert.equal(result.respectsGitignore,true);assert.ok(!backend.rag.rows(project).some(r=>r.path==='ignored.js'));
});
test('Keyword retrieval sends cited matching source text into chat',async t=>{
 const {backend,project,ollama}=await setup(t);await backend.invoke('config.update',{rag:{enabled:true}});await index(backend,project);
 const r=collect(backend,{projectPath:project,messages:[{role:'user',content:'How is authentication handled?'}]});await r.start;assert.equal((await r.completion).type,'done');
 assert.equal(r.events.find(e=>e.type==='sources').sources[0].path,'readme.md');const data=ollama.calls.find(c=>c.url==='/api/chat').data;assert.ok(data.messages.some(m=>m.content.includes('[readme.md:L1-L4]')||m.content.includes('[readme.md:L1-L3]')));assert.ok(data.messages.some(m=>m.content.includes('Authentication token flow.')));
});
test('Conversation excerpts join project RAG only when the agent enables the connection',async t=>{
 const {backend,project,ollama}=await setup(t);await backend.invoke('config.update',{rag:{enabled:true}});await index(backend,project);
 const archive=[{index:4,role:'user',content:'The authentication rollout must keep the old token valid for 24 hours.'}];
 const query=[{role:'user',content:'What was the authentication rollout decision?'}];
 let run=collect(backend,{id:'rag-chat-1',projectPath:project,messages:query,conversationArchive:archive,conversationRetrieval:{enabled:true,includeInRag:true,maxResults:2}});
 await run.start;assert.equal((await run.completion).type,'done');
 const first=ollama.calls.filter(item=>item.url==='/api/chat')[0].data;
 assert.match(JSON.stringify(first.messages),/old token valid for 24 hours/);
 assert.match(JSON.stringify(first.messages),/Authentication token flow/);
 assert.equal(run.events.find(item=>item.type==='conversation_sources').sources[0].index,4);
 run=collect(backend,{id:'rag-chat-2',projectPath:project,messages:query,conversationArchive:archive,conversationRetrieval:{enabled:true,includeInRag:false,maxResults:2}});
 await run.start;assert.equal((await run.completion).type,'done');
 const second=ollama.calls.filter(item=>item.url==='/api/chat')[1].data;
 assert.ok(!JSON.stringify(second.messages).includes('old token valid for 24 hours'));
});
test('Hybrid retrieval uses real HTTP /api/embed and persists vectors',async t=>{
 const {backend,project,ollama}=await setup(t);await fs.writeFile(path.join(project,'db.sql'),'SELECT * FROM database;');await backend.invoke('config.update',{rag:{enabled:true,mode:'hybrid'}});await index(backend,project);
 assert.ok(backend.rag.rows(project).every(r=>r.vector?.length>0));
 const r=collect(backend,{projectPath:project,messages:[{role:'user',content:'Where is the database query?'}]});await r.start;assert.equal((await r.completion).type,'done');assert.equal(r.events.find(e=>e.type==='sources').sources[0].path,'db.sql');assert.ok(ollama.calls.filter(c=>c.url==='/api/embed').length>=2);
});
test('Incremental indexing reuses unchanged vectors and prunes deleted files',async t=>{
 const {backend,project,ollama}=await setup(t);await fs.writeFile(path.join(project,'other.js'),'export const ui = true;');await backend.invoke('config.update',{rag:{mode:'hybrid'}});await index(backend,project);
 const first=ollama.calls.filter(c=>c.url==='/api/embed').length;let r=await index(backend,project);assert.equal(r.reused,2);assert.equal(ollama.calls.filter(c=>c.url==='/api/embed').length,first);
 await fs.rm(path.join(project,'other.js'));r=await index(backend,project);assert.equal(r.files,1);assert.ok(!backend.rag.rows(project).some(x=>x.path==='other.js'));
});
test('Changed and deleted source chunks are not used before a reindex',async t=>{
 const {backend,project,ollama}=await setup(t);await backend.invoke('config.update',{rag:{enabled:true}});await index(backend,project);await fs.writeFile(path.join(project,'readme.md'),'The current content is different.');
 const r=collect(backend,{projectPath:project,messages:[{role:'user',content:'Authentication'}]});await r.start;await r.completion;assert.equal(r.events.find(e=>e.type==='sources').sources.length,0);assert.ok(r.events.some(e=>e.type==='warning'&&e.message.includes('changed')));assert.ok(!JSON.stringify(ollama.calls.find(c=>c.url==='/api/chat').data).includes('Authentication token flow.'));
});
test('Model digest changes require a rebuild rather than mixing vector spaces',async t=>{
 const {backend,project,ollama}=await setup(t);await backend.invoke('config.update',{rag:{enabled:true,mode:'hybrid'}});await index(backend,project);ollama.setDigest('embedding-v2');
 const r=collect(backend,{projectPath:project});await r.start;assert.match((await r.completion).message,/embedding model changed/i);
});
test('Failed limit checks keep the previous index intact',async t=>{
 const {backend,project}=await setup(t);await index(backend,project);await fs.writeFile(path.join(project,'second.js'),'file 2');await backend.invoke('config.update',{rag:{maxFiles:1}});
 const r=collect(backend,{action:'rag.index',projectPath:project});await r.start;assert.equal((await r.completion).type,'error');assert.equal(backend.rag.status(project).files,1);
});
test('RAG is project-scoped and clear leaves source files untouched',async t=>{
 const {backend,project,dir}=await setup(t);const other=path.join(dir,'other');await fs.mkdir(other);await backend.workspace.addProject(other);await index(backend,project);
 assert.equal(backend.rag.status(other).indexed,false);await backend.invoke('rag.clear',{projectPath:project});assert.equal(backend.rag.status(project).indexed,false);assert.ok(await fs.stat(path.join(project,'readme.md')));
});
test('Temporary requests cannot start persistent indexing',async t=>{const {backend,project}=await setup(t);await assert.rejects(backend.invoke('rag.index',{id:'temp-index',projectPath:project,temporary:true}),/temporary/);});
