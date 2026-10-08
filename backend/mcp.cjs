'use strict';
/* Deliberately tools-only MCP client. No sampling, elicitation, OAuth, or remote
 * instructions are granted. Supports the 2025 tools/lifecycle specifications. */
const os = require('node:os');
const { spawn } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');
const { EventEmitter } = require('node:events');
const { fail, uid, hash, text, endpoint, lines, responseText, aborted, cleanEnvironment } = require('./util.cjs');
const VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26'];
const MAX_MESSAGE = 1024 * 1024;

class McpConnection extends EventEmitter {
  constructor(definition, { fetcher = fetch, spawnProcess = spawn } = {}) {
    super(); this.definition = structuredClone(definition); this.fetch = fetcher; this.spawn = spawnProcess;
    this.pending = new Map(); this.child = null; this.sessionId = ''; this.version = VERSIONS[0]; this.connected = false;
    this.closed = false; this.tools = []; this.inflight = new Set(); this.stderr = '';
  }
  async connect(signal) {
    if (this.closed) throw fail('MCP connection is closed.');
    if (this.definition.transport === 'stdio') this.startProcess();
    try {
      const result = await this.rpc('initialize', { protocolVersion: VERSIONS[0], capabilities: {}, clientInfo: { name: 'June', version: '0.2.0' } }, signal);
      if (!VERSIONS.includes(result.protocolVersion)) throw fail(`MCP protocol ${result.protocolVersion || 'unknown'} is not supported by this tools-only client.`);
      this.version = result.protocolVersion;
      if (!result.capabilities?.tools) throw fail('This MCP server does not advertise tools.');
      // Do not insert the server's optional instructions into the model system prompt.
      this.serverName = String(result.serverInfo?.name || this.definition.name).slice(0, 100);
      await this.notify('notifications/initialized', {}, signal);
      this.connected = true; await this.listTools(signal); return this;
    } catch (e) { await this.close(); throw e; }
  }
  startProcess() {
    const d = this.definition;
    this.child = this.spawn(d.command, d.args, { cwd: os.homedir(), env: cleanEnvironment(d.envNames), shell: false, windowsHide: true, stdio: ['pipe','pipe','pipe'] });
    let pending = ''; const decoder = new StringDecoder('utf8');
    this.child.stdout.on('data', chunk => {
      pending += decoder.write(chunk);
      if (Buffer.byteLength(pending) > MAX_MESSAGE && !pending.includes('\n')) { this.failure(fail('MCP message exceeded limit.')); return; }
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) {
        const line = pending.slice(0, nl).replace(/\r$/, ''); pending = pending.slice(nl+1);
        if (!line.trim()) continue;
        try { if (Buffer.byteLength(line)>MAX_MESSAGE) throw fail('MCP message exceeded limit.'); this.receive(JSON.parse(line)); }
        catch { this.failure(fail('MCP server wrote invalid JSON to stdout. Server logs must go to stderr.')); return; }
      }
    });
    this.child.stderr.setEncoding('utf8');
    // Drain stderr, but neither persist nor expose its potentially sensitive contents.
    this.child.stderr.on('data', () => {});
    this.child.stdin.on('error', () => this.failure(fail('MCP stdin closed.')));
    this.child.once('error', e => this.failure(fail(`Could not start MCP executable (${e.code || 'process error'}).`)));
    this.child.once('exit', code => this.failure(fail(`MCP server exited (${code ?? 'signal'}).`)));
  }
  failure(error) {
    this.connected = false;
    for (const entry of this.pending.values()) entry.reject(error);
    this.pending.clear(); this.emit('disconnected');
    if (this.child && !this.closed) { this.closed = true; this.child.kill(); }
  }
  receive(message) {
    if (!message || message.jsonrpc !== '2.0') throw fail('Invalid MCP JSON-RPC message.');
    if (message.method) {
      if (message.id !== undefined) {
        const reply = message.method === 'ping' ? { jsonrpc: '2.0', id: message.id, result: {} } : { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'June does not grant this client capability.' } };
        if (this.child?.stdin.writable) this.child.stdin.write(JSON.stringify(reply)+'\n');
      }
      return;
    }
    const waiter = this.pending.get(message.id); if (!waiter) return;
    this.pending.delete(message.id);
    if (message.error) waiter.reject(fail(`MCP: ${String(message.error.message || 'request failed').slice(0, 600)}`, 'MCP_ERROR'));
    else waiter.resolve(message.result);
  }
  async notify(method, params, signal) {
    const message = { jsonrpc: '2.0', method, params };
    if (this.definition.transport === 'stdio') {
      if (!this.child?.stdin.writable || this.closed) throw fail('MCP server is disconnected.');
      this.child.stdin.write(JSON.stringify(message)+'\n'); return;
    }
    await this.http(message, signal);
  }
  async rpc(method, params, signal) {
    aborted(signal); if (this.closed) throw fail('MCP server is disconnected.');
    const id = uid(), message = { jsonrpc: '2.0', id, method, params };
    text(JSON.stringify(message), 'MCP request', MAX_MESSAGE);
    if (this.definition.transport === 'http') return this.http(message, signal);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (fn, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', cancel); this.pending.delete(id); fn(value); };
      const cancel = () => { void this.notify('notifications/cancelled', { requestId: id, reason: 'User cancelled' }).catch(()=>{}); finish(reject, signal?.reason || fail('MCP request cancelled.')); };
      const timer = setTimeout(() => { void this.notify('notifications/cancelled', { requestId: id, reason: 'Timed out' }).catch(()=>{}); finish(reject, fail('MCP request timed out.')); }, 60000);
      this.pending.set(id, { resolve: x => finish(resolve,x), reject: e => finish(reject,e) });
      signal?.addEventListener('abort', cancel, { once: true });
      if (signal?.aborted) { cancel(); return; }
      if (!this.child?.stdin.writable) { finish(reject,fail('MCP executable is unavailable.')); return; }
      this.child.stdin.write(JSON.stringify(message)+'\n');
    });
  }
  headers() {
    const headers = { 'Content-Type':'application/json', Accept:'application/json, text/event-stream', 'MCP-Protocol-Version':this.version };
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    const env = this.definition.tokenEnv;
    if (env) { if (!process.env[env]) throw fail('The MCP token environment variable is not set.'); headers.Authorization = 'Bearer ' + process.env[env]; }
    return headers;
  }
  async http(message, signal) {
    const url = endpoint(this.definition.url, { allowRemote: this.definition.allowRemote, name: 'MCP URL' });
    const ctl = new AbortController(); this.inflight.add(ctl);
    const combined = AbortSignal.any([ctl.signal, AbortSignal.timeout(60000), ...(signal?[signal]:[])]);
    try {
      const response = await this.fetch(url, { method:'POST',headers:this.headers(),body:JSON.stringify(message),signal:combined,redirect:'error' });
      if (!response.ok) { await response.body?.cancel(); throw fail(`MCP HTTP ${response.status}${response.status===404?' (session expired; reconnect)':''}.`); }
      if (message.method === 'initialize') {
        const session = response.headers.get('Mcp-Session-Id');
        if (session && (!/^[\x21-\x7e]+$/.test(session) || session.length>500)) throw fail('Invalid MCP session identifier.');
        this.sessionId = session || '';
      }
      if (message.id === undefined) { await response.body?.cancel(); return {}; }
      const type = response.headers.get('content-type') || '';
      let result;
      const handle = async item => {
        if (!item || item.jsonrpc !== '2.0') throw fail('Invalid MCP response.');
        if (item.id === message.id && !item.method) { result = item; return; }
        if (item.method && item.id !== undefined) {
          // Servers cannot cause sampling, UI actions, filesystem reads, or tool calls.
          const reply = item.method === 'ping' ? {jsonrpc:'2.0',id:item.id,result:{}} : {jsonrpc:'2.0',id:item.id,error:{code:-32601,message:'Capability not granted'}};
          const res = await this.fetch(url,{method:'POST',headers:this.headers(),body:JSON.stringify(reply),signal:combined,redirect:'error'}); await res.body?.cancel();
        }
      };
      if (type.includes('application/json')) await handle(JSON.parse(await responseText(response,MAX_MESSAGE)));
      else if (type.includes('text/event-stream')) {
        let data = '', events = 0;
        for await (const line of lines(response.body, combined, MAX_MESSAGE)) {
          if (++events > 10000) throw fail('Too many MCP stream events.');
          if (line === '') { if (data.trim()) await handle(JSON.parse(data)); data = ''; if(result)break; }
          else if (line.startsWith('data:')) { data += line.slice(5).replace(/^ /,'')+'\n'; if(Buffer.byteLength(data)>MAX_MESSAGE)throw fail('MCP SSE response exceeded limit.'); }
        }
        if (!result && data.trim()) await handle(JSON.parse(data));
      } else { await response.body?.cancel(); throw fail('MCP endpoint must return JSON or an SSE stream.'); }
      if (!result) throw fail('MCP response ended before the request completed. No tool calls are retried automatically.');
      if (result.error) throw fail('MCP: '+String(result.error.message||'request failed').slice(0,600),'MCP_ERROR');
      return result.result;
    } finally { this.inflight.delete(ctl); }
  }
  async listTools(signal) {
    const tools = []; let cursor; const cursors = new Set();
    for (let page=0;page<10;page++) {
      const result = await this.rpc('tools/list',cursor?{cursor}:{},signal);
      if (!Array.isArray(result?.tools)) throw fail('MCP returned an invalid tools list.');
      for (const tool of result.tools) {
        text(tool.name,'Tool name',160);
        if (tools.length >= 100) throw fail('This server exposes more than 100 tools. Configure a narrower MCP server.');
        if (tools.some(t=>t.name===tool.name)) throw fail('MCP server returned duplicate tool names.');
        const schema = tool.inputSchema || {type:'object',properties:{}};
        if (schema.type !== 'object' || JSON.stringify(schema).length>20000) throw fail('Unsupported or oversized MCP tool schema.');
        tools.push({name:tool.name,description:String(tool.description||'').slice(0,2000),inputSchema:schema});
      }
      if(!result.nextCursor){this.tools=tools;return tools;}
      if(cursors.has(result.nextCursor))throw fail('MCP repeated its pagination cursor.'); cursors.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw fail('MCP tool pagination limit reached.');
  }
  async call(name,args,signal) {
    if(!this.connected || !this.tools.some(t=>t.name===name))throw fail('MCP tool is not available.');
    return this.rpc('tools/call',{name,arguments:args},signal);
  }
  async close() {
    const wasClosed=this.closed; this.closed=true;this.connected=false;
    for(const ctl of this.inflight)ctl.abort();
    for(const p of this.pending.values())p.reject(fail('MCP disconnected.'));this.pending.clear();
    if(this.child){const child=this.child;this.child=null;child.stdin.end();child.kill('SIGTERM');const t=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},1000);t.unref();}
    if(!wasClosed && this.sessionId && this.definition.transport==='http')try{const r=await this.fetch(this.definition.url,{method:'DELETE',headers:this.headers(),signal:AbortSignal.timeout(3000),redirect:'error'});await r.body?.cancel();}catch{}
    this.sessionId='';
  }
}
class McpManager {
  constructor(options) { this.connections=new Map();this.options=options; }
  async connect(definition,signal) {
    await this.disconnect(definition.id); const c=new McpConnection(definition,this.options);this.connections.set(definition.id,c);
    try{await c.connect(signal);return this.describe(definition);}catch(e){this.connections.delete(definition.id);await c.close();throw e;}
  }
  describe(definition) { const c=this.connections.get(definition.id);return {id:definition.id,name:definition.name,connected:c?.connected===true,tools:(c?.tools||[]).map(t=>({name:t.name,description:t.description,allowed:definition.allowedTools.includes(t.name)}))}; }
  available(definitions) {
    const entries=[];
    for(const d of definitions){const c=this.connections.get(d.id);if(!c?.connected)continue;
      for(const tool of c.tools){if(!d.allowedTools.includes(tool.name))continue;
        const name='mcp_'+hash(d.id+'\0'+tool.name).slice(0,12)+'_'+tool.name.replace(/[^a-zA-Z0-9_]/g,'_').slice(0,35);
        entries.push({name,serverId:d.id,serverName:d.name,toolName:tool.name,description:`MCP ${d.name}: ${tool.description}`,schema:tool.inputSchema,execute:(args,signal)=>c.call(tool.name,args,signal)});
      }
    }return entries;
  }
  async disconnect(id) { const c=this.connections.get(id);this.connections.delete(id);if(c)await c.close();return true; }
  async close() { await Promise.all([...this.connections.keys()].map(id=>this.disconnect(id))); }
}
module.exports={McpConnection,McpManager,VERSIONS};
