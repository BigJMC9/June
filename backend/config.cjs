'use strict';
const path = require('node:path');
const { fail, text, integer, object, endpoint, atomicJSON, readJSON } = require('./util.cjs');
const DEFAULTS = Object.freeze({
  version: 1, ollamaUrl: 'http://127.0.0.1:11434', allowRemoteOllama: false, ollamaTokenEnv: '',
  chatModel: '', embeddingModel: '', contextBudget: 8192, maxOutputTokens: 2048, temperature: 0.2,
  keepAlive: '5m', performance: null, maxAgentSteps: 8, requestTimeoutMs: 600000, writesEnabled: false, terminalEnabled: false,
  rag: { enabled: false, mode: 'lexical', topK: 5, maxFiles: 1500, maxChunks: 5000 }, mcpServers: []
});
const profileDefaults = { id: 'default', name: 'Default', device: 'auto', contextBudget: 8192, maxOutputTokens: 2048, temperature: 0.2, keepAlive: '5m', numThread: null, numBatch: null, mainGpu: null, useMmap: null, vulkan: 'auto', flashAttention:'auto', managedOllama: false };
function validateProfile(value) {
  object(value, 'Performance profile'); const p = { ...profileDefaults }; for(const key of Object.keys(profileDefaults)) if(value[key]!==undefined)p[key]=value[key];
  p.id = text(p.id, 'Profile ID', 60); p.name = text(p.name, 'Profile name', 80);
  if (!/^[A-Za-z0-9_-]+$/.test(p.id)) throw fail('Invalid performance profile ID.');
  if (!['auto','cpu','gpu'].includes(p.device)) throw fail('Device must be GPU + CPU, CPU only, or GPU only.');
  integer(p.contextBudget, 2048, 262144, 'Context budget'); integer(p.maxOutputTokens, 128, 32768, 'Output limit');
  if (p.maxOutputTokens >= p.contextBudget) throw fail('Output limit must be smaller than the context budget.');
  if (!Number.isFinite(p.temperature) || p.temperature < 0 || p.temperature > 2) throw fail('Temperature must be between 0 and 2.');
  if (!['0', '1m', '5m', '10m', '30m'].includes(p.keepAlive)) throw fail('Invalid model keep-alive duration.');
  for (const [key,min,max] of [['numThread',1,256],['numBatch',1,4096],['mainGpu',0,31]]) if (p[key] !== null) integer(p[key],min,max,key);
  if (p.useMmap !== null && typeof p.useMmap !== 'boolean') throw fail('Memory mapping must be automatic, on, or off.');
  if (!['auto','on','off'].includes(p.vulkan)) throw fail('Vulkan must be automatic, on, or off.');
  if (!['auto','on','off'].includes(p.flashAttention)) throw fail('Flash Attention must be automatic, on, or off.');
  if (typeof p.managedOllama !== 'boolean') throw fail('Managed Ollama must be on or off.');
  return p;
}
const envName = name => name === '' || /^[A-Za-z_][A-Za-z0-9_]{0,100}$/.test(name);
function validateServer(v) {
  object(v, 'MCP server'); const s = { id: text(v.id, 'Server ID', 60), name: text(v.name, 'Server name', 80), transport: v.transport,
    command: v.command || '', args: v.args || [], url: v.url || '', allowRemote: v.allowRemote === true,
    tokenEnv: v.tokenEnv || '', envNames: v.envNames || [], allowedTools: v.allowedTools || [] };
  if (!/^[A-Za-z0-9_-]+$/.test(s.id)) throw fail('Server ID must use letters, numbers, underscores, or hyphens.');
  if (!['stdio', 'http'].includes(s.transport)) throw fail('MCP transport must be stdio or http.');
  if (!Array.isArray(s.allowedTools) || s.allowedTools.length > 100) throw fail('Select at most 100 MCP tools.');
  s.allowedTools = [...new Set(s.allowedTools.map(x => text(x, 'Tool name', 160)))];
  if (!Array.isArray(s.envNames) || s.envNames.length > 30 || !s.envNames.every(x => typeof x === 'string' && envName(x) && x && !['NODE_OPTIONS','ELECTRON_RUN_AS_NODE'].includes(x))) throw fail('Invalid environment variable names.');
  if (typeof s.tokenEnv !== 'string' || !envName(s.tokenEnv)) throw fail('Use an environment-variable name, not a secret value.');
  if (s.transport === 'stdio') {
    text(s.command, 'Executable', 2000);
    if (/[\r\n]/.test(s.command) || /\.(cmd|bat)$/i.test(s.command)) throw fail('Use a real executable (node.exe, python.exe, etc.), not a .cmd/.bat wrapper.');
    if (!Array.isArray(s.args) || s.args.length > 80) throw fail('MCP arguments must be an array of at most 80 strings.');
    s.args = s.args.map(a => text(a, 'Argument', 8000, true));
  } else { s.url = endpoint(s.url, { allowRemote: s.allowRemote, name: 'MCP endpoint' }).href; s.command = ''; s.args = []; }
  return s;
}
function validateConfig(raw) {
  object(raw, 'Settings'); const c = structuredClone(DEFAULTS);
  for (const key of Object.keys(c)) if (raw[key] !== undefined) c[key] = raw[key];
  for (const k of ['allowRemoteOllama', 'writesEnabled', 'terminalEnabled']) if (typeof c[k] !== 'boolean') throw fail(`${k} must be a boolean.`);
  c.ollamaUrl = endpoint(c.ollamaUrl, { allowRemote: c.allowRemoteOllama, name: 'Ollama URL' }).href.replace(/\/$/, '');
  if (/\/(api|v1)$/.test(c.ollamaUrl)) throw fail('Use the Ollama base URL without /api or /v1.');
  for (const k of ['chatModel', 'embeddingModel']) text(c[k], k, 200, true);
  if (typeof c.ollamaTokenEnv !== 'string' || !envName(c.ollamaTokenEnv)) throw fail('Invalid Ollama token environment-variable name.');
  if (c.performance === null) c.performance = { activeId: 'default', profiles: [{ ...profileDefaults, contextBudget:c.contextBudget, maxOutputTokens:c.maxOutputTokens, temperature:c.temperature, keepAlive:c.keepAlive }] };
  object(c.performance, 'Performance settings');
  if (!Array.isArray(c.performance.profiles) || !c.performance.profiles.length || c.performance.profiles.length > 12) throw fail('Keep between 1 and 12 performance profiles.');
  c.performance = { activeId: c.performance.activeId, profiles: c.performance.profiles.map(validateProfile) };
  if (new Set(c.performance.profiles.map(p=>p.id)).size !== c.performance.profiles.length) throw fail('Performance profile IDs must be unique.');
  const active = c.performance.profiles.find(p=>p.id===c.performance.activeId);
  if (!active) throw fail('Select an existing performance profile.');
  for (const key of ['contextBudget','maxOutputTokens','temperature','keepAlive']) c[key] = active[key];
  if (active.managedOllama) {
    const url = new URL(c.ollamaUrl);
    if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.pathname !== '/' || url.username || url.password || c.ollamaTokenEnv) throw fail('Managed Ollama requires a 127.0.0.1 HTTP URL without authentication.');
  }
  integer(c.maxAgentSteps, 1, 20, 'Agent steps'); integer(c.requestTimeoutMs, 10000, 1800000, 'Timeout');
  if (!['0', '1m', '5m', '10m', '30m'].includes(c.keepAlive)) throw fail('Invalid model keep-alive duration.');
  object(c.rag, 'RAG settings'); c.rag = { ...DEFAULTS.rag, ...c.rag };
  if (typeof c.rag.enabled !== 'boolean' || !['lexical', 'hybrid'].includes(c.rag.mode)) throw fail('Invalid retrieval mode.');
  integer(c.rag.topK, 1, 12, 'Retrieved chunks'); integer(c.rag.maxFiles, 1, 10000, 'Index file limit'); integer(c.rag.maxChunks, 1, 10000, 'Index chunk limit');
  if (!Array.isArray(c.mcpServers) || c.mcpServers.length > 12) throw fail('Add at most 12 MCP servers.');
  c.mcpServers = c.mcpServers.map(validateServer);
  if (new Set(c.mcpServers.map(s => s.id)).size !== c.mcpServers.length) throw fail('MCP server IDs must be unique.');
  c.version = 1; return c;
}
class ConfigStore {
  constructor(dir) { this.file = path.join(dir, 'backend-settings.json'); this.value = structuredClone(DEFAULTS); this.queue = Promise.resolve(); }
  async init() { this.value = validateConfig(await readJSON(this.file, DEFAULTS)); }
  get() { return structuredClone(this.value); }
  update(patch) {
    object(patch, 'Settings'); const task = async () => { const merged = { ...this.value, ...patch, rag: { ...this.value.rag, ...patch.rag } }; if (!Object.hasOwn(patch,'performance') && ['contextBudget','maxOutputTokens','temperature','keepAlive'].some(k=>Object.hasOwn(patch,k))) { merged.performance=structuredClone(this.value.performance); const p=merged.performance.profiles.find(p=>p.id===merged.performance.activeId); for(const key of ['contextBudget','maxOutputTokens','temperature','keepAlive']) if(Object.hasOwn(patch,key))p[key]=patch[key]; } const next = validateConfig(merged); await atomicJSON(this.file, next); this.value = next; return this.get(); };
    this.queue = this.queue.then(task, task); return this.queue;
  }
}
module.exports = { DEFAULTS, ConfigStore, validateConfig, validateServer };
