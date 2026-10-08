'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os'),net=require('node:net');
const {spawn}=require('node:child_process');
const {DEFAULTS,ConfigStore,validateConfig}=require('../backend/config.cjs');
const {OllamaClient}=require('../backend/ollama.cjs');
const {OllamaManager}=require('../backend/ollama-manager.cjs');
const {setup,collect}=require('./backend-helpers.cjs');

test('legacy token settings become the default performance profile and profile changes remain validated',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'june-performance-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const store=new ConfigStore(dir);await store.init();
  let config=await store.update({contextBudget:16384,maxOutputTokens:4096});
  assert.equal(config.performance.profiles[0].contextBudget,16384);
  const profile={...config.performance.profiles[0],device:'cpu',numThread:6,contextBudget:12000};
  config=await store.update({performance:{activeId:'default',profiles:[profile]}});
  assert.equal(config.contextBudget,12000);assert.equal(config.performance.profiles[0].numThread,6);
  await assert.rejects(store.update({performance:{activeId:'default',profiles:[{...profile,maxOutputTokens:12000}]}}),/smaller/);
  assert.throws(()=>validateConfig({...DEFAULTS,ollamaUrl:'https://example.com',allowRemoteOllama:true,performance:{activeId:'default',profiles:[{...profile,managedOllama:true}]}}),/127.0.0.1/);
});

test('Ollama receives device and advanced options; GPU-only mode refuses a CPU split',async()=>{
  const profile={...validateConfig(DEFAULTS).performance.profiles[0],device:'cpu',numThread:8,numBatch:256,mainGpu:0,useMmap:false};
  let config=validateConfig({...DEFAULTS,performance:{activeId:'default',profiles:[profile]}});
  const requests=[];const fetcher=async(url,request)=>{
    requests.push({route:url.pathname,body:request.body&&JSON.parse(request.body)});
    if(url.pathname==='/api/ps')return Response.json({models:[{name:'model',size:100,size_vram:50}]});
    if(url.pathname==='/api/generate')return Response.json({done:true});
    return new Response(JSON.stringify({message:{role:'assistant',content:'ok'},done:true})+'\n',{headers:{'content-type':'application/x-ndjson'}});
  };
  const client=new OllamaClient(config,fetcher);
  await client.chat([{role:'user',content:'hello'}],{model:'model'});
  assert.deepEqual(requests[0].body.options,{num_ctx:8192,num_predict:2048,temperature:0.2,num_gpu:0,num_thread:8,num_batch:256,main_gpu:0,use_mmap:false});
  config=validateConfig({...config,performance:{activeId:'default',profiles:[{...profile,device:'gpu'}]}});
  const gpuClient=new OllamaClient(config,fetcher);
  await assert.rejects(gpuClient.ensureGpu('model'),/could not fully load/);
  assert.equal(requests.find(r=>r.route==='/api/generate').body.options.num_gpu,-1);
});

test('managed Ollama restarts only its own process and writes startup diagnostics',async t=>{
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'june-managed-'));t.after(()=>fs.rm(dir,{recursive:true,force:true}));
  const socket=net.createServer();await new Promise(resolve=>socket.listen(0,'127.0.0.1',resolve));const port=socket.address().port;await new Promise(resolve=>socket.close(resolve));
  const script="const http=require('node:http');const [host,port]=process.env.OLLAMA_HOST.split(':');http.createServer((req,res)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify({version:'test'}));}).listen(Number(port),host,()=>process.stderr.write('fake server ready\\n'));";
  const manager=new OllamaManager(dir,{spawn:(_command,_args,options)=>spawn(process.execPath,['-e',script],options)});t.after(()=>manager.close());
  const base=validateConfig(DEFAULTS),profile={...base.performance.profiles[0],managedOllama:true};
  let config=validateConfig({...base,ollamaUrl:`http://127.0.0.1:${port}`,performance:{activeId:'default',profiles:[profile]}});
  const first=await manager.apply(config);assert.equal(first.managed,true);assert.ok(first.pid);
  const contender=new OllamaManager(path.join(dir,'other'),{spawn:(_command,_args,options)=>spawn(process.execPath,['-e',script],options)});
  await assert.rejects(contender.apply(config),/already owns this address/);
  assert.match((await contender.diagnostics()).log,/startup_error/);
  assert.equal(manager.status().managed,true);
  config=validateConfig({...config,performance:{activeId:'default',profiles:[{...profile,vulkan:'off'}]}});
  const second=await manager.apply(config);assert.equal(second.managed,true);assert.notEqual(second.pid,first.pid);
  const diagnostics=await manager.diagnostics();assert.match(diagnostics.log,/startup_settings/);assert.match(diagnostics.log,/"vulkan":"off"/);
  await manager.apply(validateConfig({...config,performance:{activeId:'default',profiles:[{...profile,managedOllama:false}]}}));
  assert.equal(manager.status().managed,false);
});

test('runner crash reports the main GPU setting from Ollama diagnostics',async t=>{
  let backend;
  const fixture=await setup(t,{chat:async(_data,res)=>{
    await backend.ollamaManager.log('stderr',{message:'llama_prepare_model_devices: invalid value for main_gpu: 1 (available devices: 1)\n'});
    res.writeHead(500,{'Content-Type':'application/json'});res.end(JSON.stringify({error:'llama-server process has terminated: exit status 1'}));
  }});backend=fixture.backend;
  const run=collect(backend,{});await run.start;
  const result=await run.completion;
  assert.equal(result.type,'error');assert.match(result.message,/Main GPU index 1 is invalid/);assert.match(result.message,/clear Main GPU index/);
});
