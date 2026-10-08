'use strict';
const { fail, text, lines, responseText, aborted, endpoint } = require('./util.cjs');
class OllamaClient {
  constructor(config, fetcher = fetch, diagnostic = () => {}) { this.config = config; this.fetch = fetcher; this.diagnostic = diagnostic; }
  async request(route, body, signal, timeout = this.config.requestTimeoutMs) {
    const base = endpoint(this.config.ollamaUrl, { allowRemote: this.config.allowRemoteOllama });
    const url = new URL(base.href.replace(/\/$/, '') + '/api/' + route);
    const headers = { Accept: 'application/json', 'Content-Type': 'application/json' };
    if (this.config.ollamaTokenEnv) { const token = process.env[this.config.ollamaTokenEnv]; if (!token) throw fail('The configured Ollama token environment variable is not set.'); headers.Authorization = 'Bearer ' + token; }
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(timeout)]);
    let response;
    try { response = await this.fetch(url, { method: body === undefined ? 'GET' : 'POST', headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: combined }); }
    catch (e) { if (combined.aborted) {if(!signal?.aborted)void this.diagnostic('request_timeout',{route,origin:base.origin,timeoutMs:timeout});throw combined.reason;} const error=fail(`Cannot reach Ollama at ${base.origin}. Start Ollama and check the URL.`, 'OLLAMA_UNAVAILABLE');void this.diagnostic('request_error',{route,origin:base.origin,code:error.code,message:error.message});throw error; }
    if (!response.ok) {
      const raw = await responseText(response, 20000); let message = raw; try { message = JSON.parse(raw).error || raw; } catch {}
      const error=fail(`Ollama HTTP ${response.status}: ${String(message).slice(0, 1200)}`, 'OLLAMA_ERROR');void this.diagnostic('request_error',{route,origin:base.origin,status:response.status,code:error.code,message:error.message});throw error;
    }
    return response;
  }
  async json(route, body, signal, timeout = 30000) { return JSON.parse(await responseText(await this.request(route, body, signal, timeout), 16 * 1024 * 1024)); }
  async models(signal) {
    const data = await this.json('tags', undefined, signal); if (!Array.isArray(data.models)) throw fail('Ollama returned an invalid model list.');
    return data.models.slice(0, 500).map(m => ({ name: String(m.name || m.model), size: Number(m.size) || 0, digest: String(m.digest || ''), family: m.details?.family || '', parameters: m.details?.parameter_size || '', quantization: m.details?.quantization_level || '' }));
  }
  async show(model, signal) { text(model, 'Model', 200); return this.json('show', { model }, signal); }
  options(contextBudget = this.config.contextBudget, maxOutputTokens = this.config.maxOutputTokens) {
    const p = this.config.performance.profiles.find(x=>x.id===this.config.performance.activeId);
    const options = { num_ctx: contextBudget, num_predict: maxOutputTokens, temperature: p.temperature };
    if (p.device === 'cpu') options.num_gpu = 0;
    if (p.device === 'gpu') options.num_gpu = -1;
    if (p.numThread !== null) options.num_thread = p.numThread;
    if (p.numBatch !== null) options.num_batch = p.numBatch;
    if (p.mainGpu !== null) options.main_gpu = p.mainGpu;
    if (p.useMmap !== null) options.use_mmap = p.useMmap;
    return options;
  }
  async ensureGpu(model, signal, contextBudget = this.config.contextBudget, maxOutputTokens = this.config.maxOutputTokens) {
    const p = this.config.performance.profiles.find(x=>x.id===this.config.performance.activeId);
    if (p.device !== 'gpu') return;
    await this.json('generate', { model, prompt:'', stream:false, keep_alive:p.keepAlive==='0'?'1m':p.keepAlive, options:this.options(contextBudget,maxOutputTokens) }, signal, this.config.requestTimeoutMs);
    const running = await this.json('ps', undefined, signal);
    const loaded = running.models?.find(x=>x.name===model || x.model===model);
    if (!loaded || !Number.isFinite(loaded.size) || loaded.size<=0 || !Number.isFinite(loaded.size_vram) || loaded.size_vram<loaded.size) {const error=fail(`GPU-only profile could not fully load ${model} in GPU memory. Choose GPU + CPU or a smaller model.`, 'GPU_OFFLOAD_INCOMPLETE');void this.diagnostic('gpu_offload_error',{model,size:loaded?.size,sizeVram:loaded?.size_vram,message:error.message});throw error;}
  }
  async embed(model, input, signal) {
    const result = await this.json('embed', { model, input, truncate: false, keep_alive: this.config.keepAlive, options:this.options() }, signal, this.config.requestTimeoutMs);
    const vectors = result.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== input.length) throw fail('Ollama returned the wrong number of embeddings.');
    const dims = vectors[0]?.length;
    if (!dims || dims > 8192 || !vectors.every(v => Array.isArray(v) && v.length === dims && v.every(Number.isFinite) && v.some(x => x !== 0))) throw fail('Invalid embedding vectors returned by Ollama.');
    return vectors;
  }
  async chat(messages, { model, tools = [], contextBudget, maxOutputTokens, signal, onChunk = () => {} }) {
    const payload = { model, messages, stream: true, keep_alive: this.config.keepAlive, options: this.options(contextBudget || this.config.contextBudget, maxOutputTokens || this.config.maxOutputTokens) };
    if (tools.length) payload.tools = tools;
    const response = await this.request('chat', payload, signal);
    let content = '', thinking = '', done = false, stats = {}; const calls = [];
    for await (const line of lines(response.body, signal)) {
      if (!line.trim()) continue;
      let chunk; try { chunk = JSON.parse(line); } catch { throw fail('Ollama returned malformed streaming JSON.', 'STREAM_ERROR'); }
      if (chunk.error) throw fail(String(chunk.error).slice(0, 1200), 'OLLAMA_ERROR');
      const m = chunk.message || {};
      if (typeof m.content === 'string') { content += m.content; onChunk({ type: 'token', content: m.content }); }
      if (typeof m.thinking === 'string') { thinking += m.thinking; onChunk({ type: 'thinking' }); }
      if (content.length + thinking.length > 1000000) throw fail('Model output limit exceeded.');
      if (Array.isArray(m.tool_calls)) {
        for (const call of m.tool_calls) {
          if (calls.length >= 32) throw fail('Too many tools in one model response.');
          if (!call?.function || typeof call.function.name !== 'string') throw fail('Malformed tool call.');
          let args = call.function.arguments;
          if (typeof args === 'string') { try { args = JSON.parse(args); } catch { throw fail('Tool arguments are not valid JSON.'); } }
          if (!args || typeof args !== 'object' || Array.isArray(args)) throw fail('Tool arguments must be an object.');
          // Ollama's native endpoint emits complete calls, not OpenAI string deltas.
          const normalized = { function: { name: call.function.name, arguments: args } };
          const i = call.function.index ?? call.index;
          if (Number.isInteger(i) && i >= 0 && i < 32) calls[i] = normalized; else calls.push(normalized);
        }
      }
      if (chunk.done) { done = true; stats = { promptTokens: chunk.prompt_eval_count || 0, outputTokens: chunk.eval_count || 0, evalDurationNs: chunk.eval_duration || 0, tokensPerSecond: chunk.eval_duration > 0 ? (chunk.eval_count || 0) * 1e9 / chunk.eval_duration : 0, doneReason: chunk.done_reason || 'stop' }; }
    }
    aborted(signal); if (!done) throw fail('Ollama disconnected before completing the response.', 'STREAM_INTERRUPTED');
    return { message: { role: 'assistant', content, ...(thinking ? { thinking } : {}), ...(calls.filter(Boolean).length ? { tool_calls: calls.filter(Boolean) } : {}) }, stats };
  }
}
module.exports = { OllamaClient };
