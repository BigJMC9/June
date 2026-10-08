'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http');
const {McpConnection,McpManager}=require('../backend/mcp.cjs');const {validateServer}=require('../backend/config.cjs');const {setup,collect,chatReply}=require('./backend-helpers.cjs');
const definition=extra=>validateServer({id:'fixture',name:'Fixture MCP',transport:'stdio',command:process.execPath,args:[path.join(__dirname,'fixtures','mcp-server.cjs')],...extra});
test('MCP stdio performs initialize, discovers tools and calls tools over JSON-RPC',async t=>{const c=new McpConnection(definition());t.after(()=>c.close());await c.connect();assert.equal(c.tools.length,2);assert.equal((await c.call('echo',{text:'hello'})).content[0].text,'hello');});
test('MCP stdio does not forward secret environment values without opt-in',async t=>{
 process.env.JUNE_TEST_SECRET='private';process.env.JUNE_ALLOWED='allowed';const c=new McpConnection(definition({envNames:['JUNE_ALLOWED']}));t.after(async()=>{await c.close();delete process.env.JUNE_TEST_SECRET;delete process.env.JUNE_ALLOWED;});await c.connect();const data=JSON.parse((await c.call('environment',{})).content[0].text);assert.equal(data.secret,null);assert.equal(data.allowed,'allowed');
});
test('MCP tools are absent until connected and explicitly allowlisted',async t=>{const d=definition(),m=new McpManager();t.after(()=>m.close());assert.equal(m.available([d]).length,0);await m.connect(d);assert.equal(m.available([d]).length,0);d.allowedTools=['echo'];assert.equal(m.available([d]).length,1);await m.disconnect(d.id);assert.equal(m.available([d]).length,0);});
test('Every MCP call requires approval even with readOnlyHint=true',async t=>{
 const {backend}=await setup(t,{chat:(d,res)=>{if(d.messages.some(m=>m.role==='tool'))return chatReply(res,{content:'MCP result received.'});const name=d.tools.find(t=>t.function.name.startsWith('mcp_')).function.name;return chatReply(res,{tool_calls:[{function:{name,arguments:{text:'hello tools'}}}]});}});
 const d=definition({allowedTools:['echo']});await backend.invoke('config.update',{mcpServers:[d]});await backend.invoke('mcp.connect',{id:d.id});
 const r=collect(backend,{mode:'agent'});await r.start;const a=await r.wait('approval_required');assert.equal(a.kind,'mcp');assert.equal(a.args.text,'hello tools');await backend.invoke('run.approve',{id:a.id,approvalId:a.approvalId,approved:true},'test');assert.equal((await r.completion).type,'done');
});
test('Temporary sessions do not offer connected MCP tools',async t=>{
 const {backend,ollama}=await setup(t);const d=definition({allowedTools:['echo']});await backend.invoke('config.update',{mcpServers:[d]});await backend.invoke('mcp.connect',{id:d.id});
 const r=collect(backend,{mode:'agent',temporary:true});await r.start;await r.completion;assert.ok(!ollama.calls.find(c=>c.url==='/api/chat').data.tools);
});
for(const stream of [false,true])test(`MCP Streamable HTTP supports ${stream?'SSE':'JSON'} replies and session headers`,async t=>{
 const seen=[];const server=http.createServer(async(req,res)=>{
  if(req.method==='DELETE'){seen.push({delete:true,session:req.headers['mcp-session-id']});res.writeHead(200);res.end();return;}
  let raw='';for await(const c of req)raw+=c;const m=JSON.parse(raw);seen.push({m,headers:req.headers});
  if(m.id===undefined){res.writeHead(202);res.end();return;}
  const result=m.method==='initialize'?{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'http-fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}:{content:[{type:'text',text:m.params.arguments.text}]};
  const body=JSON.stringify({jsonrpc:'2.0',id:m.id,result});const headers={'Content-Type':stream?'text/event-stream':'application/json'};if(m.method==='initialize')headers['Mcp-Session-Id']='fixture-session';res.writeHead(200,headers);res.end(stream?'event: message\r\ndata: '+body+'\r\n\r\n':body);
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.closeAllConnections();server.close(r);}));
 const d=validateServer({id:'http',name:'HTTP fixture',transport:'http',url:'http://127.0.0.1:'+server.address().port+'/mcp'}),c=new McpConnection(d);await c.connect();assert.equal((await c.call('echo',{text:'HTTP hello'})).content[0].text,'HTTP hello');await c.close();
 assert.ok(seen.some(x=>x.m?.method==='notifications/initialized'));assert.ok(seen.filter(x=>x.m&&x.m.method!=='initialize').every(x=>x.headers['mcp-session-id']==='fixture-session'));assert.ok(seen.at(-1).delete);
});
test('MCP discovery rejects unsupported protocol versions without exposing tools',async()=>{const d=validateServer({id:'http',name:'Bad version',transport:'http',url:'http://127.0.0.1:1/mcp'});const c=new McpConnection(d,{fetcher:async(_url,opts)=>new Response(JSON.stringify({jsonrpc:'2.0',id:JSON.parse(opts.body).id,result:{protocolVersion:'1900-01-01',capabilities:{tools:{}}}}),{headers:{'content-type':'application/json'}})});await assert.rejects(c.connect(),/not supported/);assert.equal(c.connected,false);});
