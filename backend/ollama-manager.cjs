'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { fail } = require('./util.cjs');

const selected = config => config.performance.profiles.find(p=>p.id===config.performance.activeId);
function explainLog(log, since=0) {
  const entries=[];
  for(const line of log.split('\n')){let entry;try{entry=JSON.parse(line);}catch{continue;}if(entry.event==='stderr'&&Date.parse(entry.time)>=since)entries.push(entry);}
  const output=entries.map(entry=>entry.message||'').join('');
  const matches=[...output.matchAll(/invalid value for main_gpu:\s*(\d+)\s*\(available devices:\s*(\d+)\)/gi)];
  if(matches.length){const last=matches.at(-1),count=Number(last[2]);return {time:entries.at(-1)?.time||'',message:`Main GPU index ${last[1]} is invalid for the GPU group Ollama selected (${count} available ${count===1?'device':'devices'}). In Settings > Performance > Advanced Ollama options, clear Main GPU index to let Ollama choose automatically${count?`, or use an index from 0 to ${count-1}`:''}.`};}
  return null;
}
class OllamaManager {
  constructor(dir, options={}) { this.file=path.join(dir,'ollama-diagnostics.log'); this.spawn=options.spawn||spawn; this.fetch=options.fetch||fetch; this.child=null; this.signature=''; this.lastError=''; this.queue=Promise.resolve(); this.logging=Promise.resolve(); }
  log(event, detail={}) {
    const line=JSON.stringify({time:new Date().toISOString(),event,...detail})+'\n';
    this.logging=this.logging.then(async()=>{await fs.mkdir(path.dirname(this.file),{recursive:true});try{if((await fs.stat(this.file)).size>1024*1024)await fs.truncate(this.file,0);}catch(e){if(e.code!=='ENOENT')throw e;}await fs.appendFile(this.file,line,{mode:0o600});}).catch(()=>{});
    return this.logging;
  }
  async probe(url) { try { const response=await this.fetch(url+'/api/version',{signal:AbortSignal.timeout(1500)});return response.ok; } catch { return false; } }
  async portBusy(port){return new Promise(resolve=>{const socket=net.connect({host:'127.0.0.1',port:Number(port)});socket.setTimeout(1500);socket.once('connect',()=>{socket.destroy();resolve(true);});socket.once('error',()=>resolve(false));socket.once('timeout',()=>{socket.destroy();resolve(false);});});}
  async stop() {
    const child=this.child;this.child=null;this.signature='';if(!child)return;
    await this.log('stop_requested',{pid:child.pid});
    if(child.exitCode!==null||child.signalCode!==null)return;
    await new Promise(resolve=>{const timer=setTimeout(()=>{try{child.kill('SIGKILL');}catch{}resolve();},5000);child.once('exit',()=>{clearTimeout(timer);resolve();});try{child.kill();}catch{clearTimeout(timer);resolve();}});
  }
  async apply(config) {
    const task=async()=>{
      const profile=selected(config);
      const signature=JSON.stringify({url:config.ollamaUrl,vulkan:profile.vulkan,flashAttention:profile.flashAttention,managed:profile.managedOllama});
      if(!profile.managedOllama){await this.stop();return this.status();}
      if(this.child&&this.signature===signature&&this.child.exitCode===null)return this.status();
      await this.stop();this.lastError='';
      const url=new URL(config.ollamaUrl),host=`127.0.0.1:${url.port||11434}`;
      const startup={url:config.ollamaUrl,host,profile:profile.name,device:profile.device,vulkan:profile.vulkan,flashAttention:profile.flashAttention,contextBudget:profile.contextBudget,maxOutputTokens:profile.maxOutputTokens,numThread:profile.numThread,numBatch:profile.numBatch,mainGpu:profile.mainGpu,useMmap:profile.useMmap,platform:process.platform,arch:process.arch,cpus:os.cpus().length,totalMemory:os.totalmem()};
      await this.log('startup_settings',startup);
      if(await this.portBusy(url.port||11434)){this.lastError='Another process already owns this address. Quit it or choose an unused local port before enabling managed Ollama.';await this.log('startup_error',{message:this.lastError});throw fail(this.lastError,'OLLAMA_OWNERSHIP');}
      const env={...process.env,OLLAMA_HOST:host};
      if(profile.vulkan!=='auto')env.OLLAMA_VULKAN=profile.vulkan==='on'?'1':'0';
      if(profile.flashAttention!=='auto')env.OLLAMA_FLASH_ATTENTION=profile.flashAttention==='on'?'1':'0';
      let child;
      try{child=this.spawn('ollama',['serve'],{env,windowsHide:true,stdio:['ignore','pipe','pipe'],shell:false});}
      catch(e){this.lastError=`Could not launch Ollama: ${e.message}`;await this.log('startup_error',{message:this.lastError});throw fail(this.lastError,'OLLAMA_START_FAILED');}
      this.child=child;this.signature=signature;
      for(const [name,stream] of [['stdout',child.stdout],['stderr',child.stderr]])stream?.on('data',chunk=>{
        let value=String(chunk);
        const secret=config.ollamaTokenEnv&&process.env[config.ollamaTokenEnv];if(secret)value=value.split(secret).join('[redacted]');
        value=value.replace(/(Authorization:\s*Bearer\s+)\S+/gi,'$1[redacted]').replace(/([A-Z_]*(?:TOKEN|KEY|PASSWORD|SECRET)[A-Z_]*:)[^\s\]]+/g,'$1[redacted]').replace(/\b(https?:\/\/)[^\s/@]+@/gi,'$1[redacted]@');
        for(let offset=0;offset<value.length;offset+=4000)void this.log(name,{pid:child.pid,message:value.slice(offset,offset+4000)});
      });
      child.on('error',e=>{this.lastError=`Ollama process error: ${e.message}`;void this.log('process_error',{pid:child.pid,message:this.lastError});});
      child.on('exit',(code,signal)=>{if(this.child===child){this.child=null;this.signature='';this.lastError=`Ollama exited (${signal||code}).`;}void this.log('process_exit',{pid:child.pid,code,signal});});
      await this.log('process_started',{pid:child.pid});
      const until=Date.now()+20000;
      while(Date.now()<until){if(child.exitCode!==null||child.signalCode!==null||this.lastError)break;if(await this.probe(config.ollamaUrl)){await this.log('ready',{pid:child.pid,url:config.ollamaUrl});return this.status();}await new Promise(r=>setTimeout(r,300));}
      this.lastError=this.lastError||'Ollama did not become ready within 20 seconds.';await this.log('startup_error',{pid:child.pid,message:this.lastError});await this.stop();throw fail(this.lastError,'OLLAMA_START_FAILED');
    };
    this.queue=this.queue.then(task,task);return this.queue;
  }
  status(){return {managed:Boolean(this.child),pid:this.child?.pid||null,lastError:this.lastError,logPath:this.file};}
  async readLog(){await this.logging;try{return await fs.readFile(this.file,'utf8');}catch(e){if(e.code==='ENOENT')return '';throw e;}}
  async recentFailure(since=Date.now()-30000){return explainLog(await this.readLog(),since);}
  async diagnostics(){const log=await this.readLog();return {...this.status(),recentIssue:explainLog(log,Date.now()-86400000),log:log.slice(-40000),externalLogPath:!this.child&&process.platform==='win32'&&process.env.LOCALAPPDATA?path.join(process.env.LOCALAPPDATA,'Ollama','server.log'):null};}
  async close(){await this.queue.catch(()=>{});await this.stop();await this.logging;}
}
module.exports={OllamaManager,explainLog};
