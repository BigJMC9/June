/* Renderer adapter for the native, transport-independent June backend. */
import { resolveAgentConfig, condensationTriggerTokens } from './workspace-data.mjs';
import { renderMarkdown } from './chat-format.mjs';
export function installBackend(host) {
  const { $, $$, el, icon, state, desktop, native, toast, store, currentChat, rootPath, isTemporary,
    saveMessage, saveChats, renderConversation, renderChats, openSettings, openFile, ask, extras } = host;
  const available = typeof desktop?.backendCall === 'function' && typeof desktop?.onBackendEvent === 'function';
  let config = null, servers = [], models = [], active = null, modelSeq = 0, statusSeq = 0, lastContext = '';
  let useRag = true, initializing, persistTimer, sending = false;
  const rpc = (action, data = {}) => native('backendCall', action, data);
  const effectiveBudget = () => {const value=currentChat()?.contextBudget;return Number.isInteger(value)&&value>config.maxOutputTokens+1024?Math.min(value,config.contextBudget):config.contextBudget;};
  const guard = fn => async event => { try { await fn(event); } catch (e) { toast(e.message || 'Backend operation failed.'); } };
  const busy = () => Boolean(active||sending);
  function canNavigate() { if (!busy()) return true; toast('Stop the current response, summary draft, or indexing job before continuing.'); return false; }
  function persist() { if (active?.kind === 'chat' && !active.chat.temporary) saveChats(); }
  function persistSoon() { clearTimeout(persistTimer); persistTimer = setTimeout(persist, 400); }
  function status(message, type = '') { const s = $('#runStatus'); s.hidden = !message; s.textContent = message; s.dataset.state = type; }
  function formatDuration(ms){const seconds=Math.max(0,Math.floor(ms/1000)),minutes=Math.floor(seconds/60),hours=Math.floor(minutes/60);return hours?`${hours}:${String(minutes%60).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`:`${minutes}:${String(seconds%60).padStart(2,'0')}`;}
  function tickResponse(run){
    if(active!==run)return;
    run.message.note=`${run.message.model} / ${formatDuration(Date.now()-run.message.startedAt)} elapsed`;
    const article=$$('[data-message-id]').find(node=>node.dataset.messageId===run.message.id);
    if(article){const note=article.querySelector('.message-note');if(note)note.textContent=run.message.note;else article.append(el('p','message-note',run.message.note));}
    updateContextMeter();
  }
  function updateContextMeter(){
    const meter=$('#contextMeter');if(available&&!config){meter.hidden=true;return;}meter.hidden=false;
    const chat=currentChat(),budget=config?effectiveBudget():state.settings.contextBudget||8192;
    const output=config?.maxOutputTokens||2048;
    const selected=chat||{agentOverride:state.pendingAgentId?{agentId:state.pendingAgentId}:{}};
    const policy=resolveAgentConfig(state.agentStore,rootPath(),selected).condensation;
    const used=extras.contextEstimate(host.composer.value.trim());
    const threshold=condensationTriggerTokens(budget,output,policy.triggerPercent);
    meter.setAttribute('aria-valuemax',String(budget));meter.setAttribute('aria-valuenow',String(Math.min(used,budget)));
    meter.dataset.state=used>=budget?'over':threshold&&used>=threshold?'near':'';
    $('#contextMeterCount').textContent=`≈${used.toLocaleString()} / ${budget.toLocaleString()} tokens`;
    $('#contextMeterFill').style.width=Math.min(100,used/budget*100)+'%';
    $('#contextMeterThreshold').hidden=!threshold;
    if(threshold)$('#contextMeterThreshold').style.left=Math.min(100,threshold/budget*100)+'%';
    $('#contextMeterThresholdLabel').textContent=threshold?`Condense at ≈${threshold.toLocaleString()}`:'Auto condensation off';
    meter.title=`Estimated input context. ${threshold?`Automatic condensation starts near ${threshold.toLocaleString()} tokens.`:'Automatic condensation is off.'}`;
  }
  function formFromConfig() {
    if (!config) return;
    const values = {settingBackendUrl:'ollamaUrl',ollamaTokenEnv:'ollamaTokenEnv',agentStepLimit:'maxAgentSteps'};
    Object.entries(values).forEach(([id,key]) => { $('#'+id).value = config[key]; });
    $('#allowRemoteOllama').checked = config.allowRemoteOllama;
    $('#agentWrites').checked = config.writesEnabled; $('#agentTerminal').checked = config.terminalEnabled;
    $('#ragEnabled').checked = config.rag.enabled; $('#ragMode').value = config.rag.mode;
    $('#ragTopK').value = config.rag.topK; $('#ragMaxFiles').value = config.rag.maxFiles; $('#ragMaxChunks').value = config.rag.maxChunks;
    renderPerformance();
    renderModelOptions(); renderServers(); sync();
  }
  function renderPerformance(id=config.performance.activeId){
    const select=$('#performanceProfileSelect');select.replaceChildren();
    for(const p of config.performance.profiles){const option=el('option','',p.name+(p.id===config.performance.activeId?' (active)':''));option.value=p.id;select.append(option);}
    const p=config.performance.profiles.find(p=>p.id===id)||config.performance.profiles[0];select.value=p.id;
    $('#performanceName').value=p.name;$('#performanceDevice').value=p.device;
    $('#ollamaContext').value=p.contextBudget;$('#ollamaOutput').value=p.maxOutputTokens;$('#ollamaTemperature').value=p.temperature;$('#ollamaKeepAlive').value=p.keepAlive;
    $('#performanceThreads').value=p.numThread??'';$('#performanceBatch').value=p.numBatch??'';$('#performanceMainGpu').value=p.mainGpu??'';
    $('#performanceMmap').value=p.useMmap===null?'auto':p.useMmap?'on':'off';$('#performanceVulkan').value=p.vulkan;$('#performanceFlashAttention').value=p.flashAttention;$('#performanceManaged').checked=p.managedOllama;
    $('#performanceDelete').disabled=config.performance.profiles.length===1;
  }
  const optionalNumber=id=>$('#'+id).value===''?null:Number($('#'+id).value);
  function editedPerformance(){const id=$('#performanceProfileSelect').value,original=config.performance.profiles.find(p=>p.id===id);return {...original,name:$('#performanceName').value.trim(),device:$('#performanceDevice').value,contextBudget:Number($('#ollamaContext').value),maxOutputTokens:Number($('#ollamaOutput').value),temperature:Number($('#ollamaTemperature').value),keepAlive:$('#ollamaKeepAlive').value,numThread:optionalNumber('performanceThreads'),numBatch:optionalNumber('performanceBatch'),mainGpu:optionalNumber('performanceMainGpu'),useMmap:$('#performanceMmap').value==='auto'?null:$('#performanceMmap').value==='on',vulkan:$('#performanceVulkan').value,flashAttention:$('#performanceFlashAttention').value,managedOllama:$('#performanceManaged').checked};}
  async function refreshDiagnostics(){
    const data=await rpc('ollama.diagnostics');
    $('#performanceStatus').textContent=data.recentIssue?`Last Ollama issue (${new Date(data.recentIssue.time).toLocaleString()}): ${data.recentIssue.message}`:data.lastError|| (data.managed?`June manages Ollama (PID ${data.pid}).`:'Using an external Ollama server.');
    $('#performanceDiagnostics').textContent=`June diagnostic log: ${data.logPath}${data.externalLogPath?`\nWindows Ollama log: ${data.externalLogPath}`:''}\n\n${data.log||'No June diagnostic events yet. External Ollama servers write to their own logs.'}`;
  }
  async function openOllamaDiagnostics(){openSettings('performance');$('#performanceDiagnosticsDetails').open=true;await refreshDiagnostics();$('#performanceDiagnosticsDetails').scrollIntoView({block:'nearest'});}
  function renderModelOptions() {
    const current = currentChat()?.model || state.settings.defaultModel || config?.chatModel || '';
    const select = $('#chatModelSelect'), embedding = $('#ragEmbeddingModel');
    select.replaceChildren(); embedding.replaceChildren();
    const add = (node, value, label) => { const o = el('option','',label); o.value=value;node.append(o); };
    add(select, '', models.length?'Choose a model':config?'Connect Ollama / refresh models':'Backend unavailable');
    add(embedding,'','Choose an embedding model');
    for (const model of models) { add(select,model.name,model.name);add(embedding,model.name,model.name); }
    // Never silently swap to a different installed model when the selection disappears.
    if (current && !models.some(m=>m.name===current)) add(select,current,current+' (not in current list)');
    select.value=current;
    if (config?.embeddingModel && !models.some(m=>m.name===config.embeddingModel)) add(embedding,config.embeddingModel,config.embeddingModel+' (not in current list)');
    embedding.value=config?.embeddingModel||'';
    const list=$('#installedModelList');list.replaceChildren();
    for(const model of models){const row=el('div','installed-model');row.append(el('strong','',model.name),el('small','',[model.parameters,model.quantization,model.size?`${(model.size/1073741824).toFixed(1)} GB`:null].filter(Boolean).join(' / ')));list.append(row);}
  }
  async function refreshModels() {
    if (!available) throw new Error('Restart June with the updated desktop files to connect Ollama.');
    const seq=++modelSeq;$('#backendTestResult').textContent='Connecting to Ollama...';$('#backendTestResult').dataset.status='';
    try {
      const response=await rpc('models');if(seq!==modelSeq)return;
      models=response.models||[];renderModelOptions();
      $('#backendTestResult').textContent=`Ollama connected. ${models.length} installed model(s).`;
      $('#backendTestResult').dataset.status='ok';
      if(!models.length)status('Ollama has no installed models. Pull a model, then refresh.');
      else if(!active)status('');
    }catch(e){if(seq!==modelSeq)return;models=[];renderModelOptions();$('#backendTestResult').textContent=e.message;$('#backendTestResult').dataset.status='error';throw e;}
    finally{sync();}
  }
  async function saveProvider() {
    if(!config)throw new Error('Backend is not ready.');
    const patch={ollamaUrl:$('#settingBackendUrl').value.trim(),allowRemoteOllama:$('#allowRemoteOllama').checked,ollamaTokenEnv:$('#ollamaTokenEnv').value.trim(),maxAgentSteps:Number($('#agentStepLimit').value),writesEnabled:$('#agentWrites').checked,terminalEnabled:$('#agentTerminal').checked,chatModel:$('#chatModelSelect').value||config.chatModel};
    if(patch.allowRemoteOllama&&!config.allowRemoteOllama&&!await ask('Allow a remote Ollama server?','Messages, selected memories, skills, and retrieved code may be sent to the configured HTTPS server. Only use a service you trust.',undefined,'Allow remote server'))return;
    config=await rpc('config.update',patch);state.settings.contextBudget=config.contextBudget;store('june.settings',state.settings);formFromConfig();await refreshModels();
  }
  async function refreshState(){const result=await rpc('state');config=result.config;servers=result.mcp||[];formFromConfig();return result;}
  function sync() {
    const chat=currentChat();
    const agentSelect=$('#agentProfileSelect'),agent=resolveAgentConfig(state.agentStore,rootPath(),chat);
    agentSelect.replaceChildren();for(const profile of state.agentStore.profiles){const item=el('option','',profile.name);item.value=profile.id;agentSelect.append(item);}
    agentSelect.value=chat?agent.id:state.pendingAgentId||agent.id;
    agentSelect.disabled=busy();
    updateContextMeter();
    if(!available)return;
    const model=chat?.model||state.settings.defaultModel||config?.chatModel||'';
    if([...$('#chatModelSelect').options].some(o=>o.value===model))$('#chatModelSelect').value=model;
    $('#chatModeSelect').value=chat?.mode==='chat'?'ask':chat?.mode||state.settings.agentMode||'ask';
    $('#chatModelSelect').disabled=$('#chatModeSelect').disabled=!config||busy();
    const ragOn=Boolean(config?.rag.enabled&&useRag&&!isTemporary()&&rootPath());
    $('#ragComposerToggle').setAttribute('aria-pressed',String(ragOn));
    $('#ragComposerToggle').disabled=busy()||isTemporary();
    $('#ragComposerToggle').title=isTemporary()?'RAG is off in temporary mode':config?.rag.enabled?'Toggle retrieved project context':'Configure and index project RAG in Settings';
    $('#ragEmbeddingModel').disabled=$('#ragMode').value!=='hybrid';
    $('#stopRunBtn').hidden=!(active?.kind==='chat'||(sending&&active?.kind==='compact'));$('#sendBtn').hidden=active?.kind==='chat'||(sending&&active?.kind==='compact');$('#sendBtn').disabled=busy();
    $('#stopRunBtn').setAttribute('aria-label',active?.kind==='compact'?'Stop summary':'Stop response');
    $('#sendBtn').title='Send to Ollama (Enter)';$('#sendBtn').setAttribute('aria-label','Send to Ollama');
    $('#draftLabel').textContent=isTemporary()?'Temporary':'Ollama';
    $('#composerHint').textContent=isTemporary()?'Not saved by June. Memories, skills, RAG, and MCP are off. The model server may retain requests.':'Chat can inspect an open project. Agent can request edits and external actions with approval.';
    $('#ragProjectLabel').textContent=state.project?.name||'Select a project';$('#ragProjectLabel').title=rootPath();
    $('#indexProjectBtn').disabled=$('#clearIndexBtn').disabled=!rootPath()||isTemporary()||busy();
    $('#cancelIndexBtn').hidden=active?.kind!=='index';
    const key=rootPath()+'\0'+(chat?.id||'')+'\0'+isTemporary();
    if(key!==lastContext){lastContext=key;if(!active)status('');void refreshIndexStatus();}
  }
  async function refreshIndexStatus(){
    const seq=++statusSeq,project=rootPath();
    if(!project){$('#ragIndexStatus').textContent='No project selected.';return;}
    if(!available||!config)return;
    try{const r=await rpc('rag.status',{projectPath:project});if(seq!==statusSeq||active?.kind==='index')return;$('#ragIndexStatus').textContent=r.indexed?`${r.files} files / ${r.chunks} chunks / ${r.mode}\nUpdated ${new Date(r.indexedAt).toLocaleString()}${r.skipped?`\n${r.skipped} file(s) excluded or unreadable`:''}`:'No index for this project.';}catch(e){if(seq===statusSeq)$('#ragIndexStatus').textContent=e.message;}
  }
  function renderMessageExtras(article,message) {
    if(message.status)article.dataset.status=message.status;
    if(message.note)article.append(el('p','message-note',message.note));
    if(message.activity?.length){const details=el('details','tool-activity'),summary=el('summary','',`Agent activity (${message.activity.length})`),list=el('ul');for(const item of message.activity)list.append(el('li','',item));details.append(summary,list);article.append(details);}
    if(message.conversationSources?.length){const details=el('details','tool-activity'),summary=el('summary','',`Older conversation used (${message.conversationSources.length})`),list=el('ul');for(const item of message.conversationSources)list.append(el('li','',`Message #${item.index} (${item.role})`));details.append(summary,list);article.append(details);}
    if(message.sources?.length){const sources=el('div','message-sources');for(const s of message.sources){const b=el('button','source-chip',`${s.path}:L${s.start}-${s.end}`);b.title='Open source file';b.addEventListener('click',guard(()=>openFile(s.path)));sources.append(b);}article.append(sources);}
    if(message.status==='error'&&/^(OLLAMA|GPU_|STREAM_)/.test(message.errorCode||'')){const button=el('button','quiet-button message-diagnostics','View Ollama diagnostics');button.type='button';button.addEventListener('click',guard(openOllamaDiagnostics));article.append(button);}
  }
  function updateStream(force=false) {
    const job=active;if(!job||job.kind!=='chat'||currentChat()!==job.chat)return;
    if(!force&&job.lastRenderAt!==undefined&&performance.now()-job.lastRenderAt<80){if(!job.renderTimer)job.renderTimer=setTimeout(()=>{job.renderTimer=null;updateStream(true);},80);return;}
    job.lastRenderAt=performance.now();
    const article=$$('[data-message-id]').find(n=>n.dataset.messageId===job.message.id);
    if(!article)return;
    const history=$('#chatHistory'),atBottom=history.scrollHeight-history.scrollTop-history.clientHeight<100;
    article.querySelector('.message-body').replaceChildren(renderMarkdown(job.message.content));
    article.dataset.status=job.message.status;
    article.querySelectorAll('.message-note,.tool-activity,.message-sources,.message-diagnostics').forEach(n=>n.remove());renderMessageExtras(article,job.message);
    if(atBottom)history.scrollTop=history.scrollHeight;
  }
  function showApproval(event){
    const card=$('#approvalCard');card.replaceChildren();card.hidden=false;
    card.append(el('h3','',`Approve ${event.label}?`),el('p','',event.warning));
    if(event.kind==='write'){
      card.append(el('strong','',event.args.path));
      for(const [name,content]of [['Current file',event.args.before],['Proposed replacement',event.args.content]]){const details=el('details');details.open=name==='Proposed replacement';details.append(el('summary','',name),el('pre','',content||'(empty)'));card.append(details);}
    } else card.append(el('pre','',JSON.stringify(event.args,null,2)));
    const buttons=el('div','backend-actions');
    for(const [label,approved]of [['Deny',false],['Approve once',true]]){const button=el('button',approved?'secondary-button':'quiet-button',label);button.type='button';button.addEventListener('click',guard(async()=>{buttons.querySelectorAll('button').forEach(b=>{b.disabled=true;});try{await rpc('run.approve',{id:event.id,approvalId:event.approvalId,approved});card.hidden=true;}catch(e){buttons.querySelectorAll('button').forEach(b=>{b.disabled=false;});throw e;}}));buttons.append(button);}
    card.append(buttons);status('Waiting for your approval.','working');
  }
  function onEvent(event){
    if(!active||event.id!==active.id)return;
    if(active.kind==='compact'){
      const run=active;
      if(event.type==='token'){run.content+=event.content;run.onProgress(run.content);}
      if(['done','error','cancelled'].includes(event.type)){
        active=null;sync();
        if(event.type==='done'&&run.content.trim())run.resolve(run.content.trim());
        else run.reject(new Error(event.type==='done'?'The model returned an empty summary.':event.message||'Summary generation stopped.'));
      }
      return;
    }
    if(active.kind==='index'){
      if(event.type==='index_progress')$('#ragIndexStatus').textContent=event.message+(event.total?` (${event.files}/${event.total}; ${event.chunks} chunks)`: '');
      if(event.type==='index_done')$('#ragIndexStatus').textContent=`Indexed ${event.files} files / ${event.chunks} chunks. Reused ${event.reused} unchanged files.`;
      if(['done','error','cancelled'].includes(event.type)){if(event.type!=='done')$('#ragIndexStatus').textContent=event.message;active=null;sync();if(event.type==='done')void refreshIndexStatus();}
      return;
    }
    const message=active.message;
    if(event.type==='token'){message.content+=event.content;updateStream();persistSoon();}
    if(event.type==='content_reset'){message.content='';updateStream();}
    if(event.type==='thinking')status('Model is thinking...','working');
    if(event.type==='status')status(event.message,'working');
    if(event.type==='sources'){message.sources=event.sources;updateStream();}
    if(event.type==='conversation_sources'){message.conversationSources=event.sources;updateStream();}
    if(event.type==='context'){message.context=event;}
    if(event.type==='warning'){message.activity.push(event.message);updateStream();}
    if(event.type==='tool_start'){message.activity.push(`Started: ${event.label||event.name}`);status(`Using ${event.label||event.name}...`,'working');updateStream();}
    if(event.type==='tool_done'){message.activity.push(`${event.ok?'Completed':'Failed/denied'}: ${event.name}${event.message?' - '+event.message:''}`);updateStream();}
    if(event.type==='approval_required')showApproval(event);
    if(event.type==='metrics'){message.metrics={promptTokens:event.promptTokens,outputTokens:event.outputTokens,tokensPerSecond:event.tokensPerSecond};}
    if(event.type==='file_written'){message.activity.push('Saved '+event.path);if(state.inspector==='changes')void host.renderChanges();else if(state.inspector==='files')void host.renderFiles();}
    if(['done','error','cancelled'].includes(event.type)){
      clearTimeout(persistTimer);clearTimeout(active.renderTimer);clearInterval(active.timer);message.status=event.type==='done'?'complete':event.type;
      message.errorCode=event.type==='error'?event.code||'':'';
      message.durationMs=Math.max(0,Date.now()-message.startedAt);
      const elapsed=`${formatDuration(message.durationMs)} total`;
      message.note=event.type==='done'?(message.metrics?`${message.model} / ${message.metrics.outputTokens} tokens / ${message.metrics.tokensPerSecond.toFixed(1)} tokens/s / ${elapsed}`:`${message.model} / ${elapsed}`):`${event.message||'Stopped'} / ${elapsed}`;
      if(!message.content)message.content=event.type==='done'?'(The model returned no text.)':'';
      active.chat.updatedAt=Date.now();persist();updateStream(true);$('#approvalCard').hidden=true;
      active=null;sync();status(event.type==='error'?event.message:event.type==='cancelled'?'Response stopped.':'',event.type==='error'?'error':'');
      if(event.type==='error'&&/^(OLLAMA|GPU_|STREAM_)/.test(event.code||'')){const button=el('button','quiet-button','View Ollama diagnostics');button.type='button';button.addEventListener('click',guard(openOllamaDiagnostics));$('#runStatus').append(button);}
    }
  }
  async function send(){
    if(!available)return;
    await initializing;if(!config)throw new Error('Backend is unavailable. Restart June.');if(busy())throw new Error('Stop the current response before sending another message.');
    const model=$('#chatModelSelect').value,mode=$('#chatModeSelect').value;
    if(!model)throw new Error('Select an installed Ollama model first. Connect it in Settings > Ollama.');
    if(!host.composer.value.trim())return;
    sending=true;sync();
    try{await extras.autoCondenseBeforeSend({model,contextBudget:effectiveBudget(),maxOutputTokens:config.maxOutputTokens,pendingText:host.composer.value.trim(),onStatus:message=>status(message,'working')});}
    catch(error){status(error.message,'error');throw error;}
    finally{sending=false;sync();}
    // Persist the user's message using the existing normal/temporary chat rules.
    const chat=saveMessage({preventDefault(){}});if(!chat)return;
    chat.model=model;chat.mode=mode;
    const context=extras.requestContext();
    const agent=resolveAgentConfig(state.agentStore,rootPath(),chat);
    const request={...context,projectPath:rootPath(),model,mode,useRag,temporary:isTemporary(),contextBudget:effectiveBudget(),agentSystemPrompt:agent.systemPrompt,agentInstructions:agent.instructions};
    const assistant={id:crypto.randomUUID(),role:'assistant',content:'',createdAt:Date.now(),startedAt:Date.now(),model,status:'running',note:`${model} / 0:00 elapsed`,activity:[],sources:[]};chat.messages.push(assistant);
    active={id:crypto.randomUUID(),kind:'chat',chat,message:assistant};
    renderConversation();renderChats();persist();sync();status('Connecting to Ollama...','working');
    const run=active;run.timer=setInterval(()=>tickResponse(run),1000);
    try{await rpc('run.start',{...request,id:active.id});}catch(e){if(active)onEvent({id:active.id,type:'error',message:e.message});}
  }
  async function cancel(){if(active)await rpc('job.cancel',{id:active.id});}
  async function generateCompaction(prompt,onProgress=()=>{},{model:requestedModel,maxOutputTokens}={}){
    await initializing;if(!config)throw new Error('Backend is unavailable. Restart June.');
    if(active)throw new Error('Stop the current operation before generating a summary.');
    const model=requestedModel||$('#chatModelSelect').value||currentChat()?.model||config.chatModel;
    if(!model)throw new Error('Select an installed Ollama model before generating a summary.');
    let resolve,reject;const completion=new Promise((yes,no)=>{resolve=yes;reject=no;});
    const run={id:crypto.randomUUID(),kind:'compact',content:'',onProgress,resolve,reject,started:false,cancelRequested:false};active=run;sync();
    try{await rpc('run.start',{id:run.id,mode:'chat',model,projectPath:'',messages:[{role:'user',content:prompt}],temporary:true,useRag:false,contextBudget:effectiveBudget(),maxOutputTokens:maxOutputTokens?Math.min(maxOutputTokens,config.maxOutputTokens):undefined});run.started=true;if(active===run&&run.cancelRequested)await rpc('job.cancel',{id:run.id});}
    catch(error){if(active===run){active=null;sync();reject(error);}}
    return completion;
  }
  async function cancelCompaction(){if(active?.kind!=='compact')return;if(!active.started){active.cancelRequested=true;return;}await rpc('job.cancel',{id:active.id});}
  function resetServerForm(){ $('#mcpServerForm').reset();$('#mcpServerId').value='';$('#mcpArgs').value='[]';mcpTransport(); }
  function mcpTransport(){const stdio=$('#mcpTransport').value==='stdio';$('#mcpStdioFields').hidden=!stdio;$('#mcpHttpFields').hidden=stdio;$('#mcpCommand').required=stdio;$('#mcpUrl').required=!stdio;}
  function editServer(s){$('#mcpServerId').value=s.id;$('#mcpServerName').value=s.name;$('#mcpTransport').value=s.transport;$('#mcpCommand').value=s.command;$('#mcpArgs').value=JSON.stringify(s.args);$('#mcpEnvNames').value=s.envNames.join(', ');$('#mcpUrl').value=s.url;$('#mcpAllowRemote').checked=s.allowRemote;$('#mcpTokenEnv').value=s.tokenEnv;$('#mcpEditor').open=true;mcpTransport();$('#mcpServerName').focus();}
  function renderServers(){
    const list=$('#mcpServerList');list.replaceChildren();
    if(!config?.mcpServers.length){list.append(el('p','empty-state','No MCP servers. Add one below, connect it, then explicitly enable the tools you need.'));return;}
    for(const definition of config.mcpServers){
      const runtime=servers.find(s=>s.id===definition.id),card=el('article','mcp-server-card'),head=el('div','mcp-card-head'),label=el('div');
      label.append(el('strong','',definition.name),el('small','',`${definition.transport} / ${runtime?.connected?'Connected':'Disconnected'} / ${definition.allowedTools.length} enabled tools`));head.append(label);card.append(head);
      const actions=el('div','backend-actions');
      const button=(name,fn)=>{const b=el('button','quiet-button',name);b.type='button';b.disabled=busy();b.addEventListener('click',guard(fn));actions.append(b);};
      button(runtime?.connected?'Disconnect':'Connect',async()=>{await rpc(runtime?.connected?'mcp.disconnect':'mcp.connect',{id:definition.id});await refreshState();});
      button('Edit',()=>editServer(definition));
      button('Remove',async()=>{if(!await ask('Remove MCP server?',`Disconnect and remove ${definition.name}? Project files are not affected.`,undefined,'Remove'))return;config=await rpc('config.update',{mcpServers:config.mcpServers.filter(s=>s.id!==definition.id)});await refreshState();});card.append(actions);
      if(runtime?.tools?.length){const tools=el('details');tools.append(el('summary','',`Choose permitted tools (${runtime.tools.length})`));const items=el('div','mcp-tools');
        for(const tool of runtime.tools){const row=el('label','mcp-tool'),input=el('input');input.type='checkbox';input.checked=definition.allowedTools.includes(tool.name);input.disabled=busy();input.setAttribute('aria-label',`Enable ${tool.name}`);const info=el('span');info.append(el('strong','',tool.name),el('small','',tool.description));row.append(input,info);
          input.addEventListener('change',guard(async()=>{const next=structuredClone(config.mcpServers),s=next.find(x=>x.id===definition.id);s.allowedTools=input.checked?[...new Set([...s.allowedTools,tool.name])]:s.allowedTools.filter(x=>x!==tool.name);try{config=await rpc('config.update',{mcpServers:next});label.querySelector('small').textContent=`${definition.transport} / ${runtime?.connected?'Connected':'Disconnected'} / ${s.allowedTools.length} enabled tools`;}catch(e){input.checked=!input.checked;throw e;}}));items.append(row);}
        tools.append(items);card.append(tools);
      }
      list.append(card);
    }
  }
  $('#ollamaSettingsForm').addEventListener('submit',guard(async e=>{e.preventDefault();await saveProvider();}));
  $('#refreshModelsBtn').addEventListener('click',guard(refreshModels));
  $('#performanceProfileSelect').addEventListener('change',()=>renderPerformance($('#performanceProfileSelect').value));
  $('#performanceAdd').addEventListener('click',guard(async()=>{
    if(config.performance.profiles.length>=12)throw new Error('June supports at most 12 performance profiles.');
    const profile={...editedPerformance(),id:crypto.randomUUID(),name:$('#performanceName').value.trim()+' copy'};
    config=await rpc('config.update',{performance:{activeId:profile.id,profiles:[...config.performance.profiles,profile]}});
    renderPerformance(profile.id);state.settings.contextBudget=config.contextBudget;store('june.settings',state.settings);await refreshDiagnostics();sync();
  }));
  $('#performanceDelete').addEventListener('click',guard(async()=>{
    const id=$('#performanceProfileSelect').value,profiles=config.performance.profiles.filter(p=>p.id!==id);if(!profiles.length)return;
    config=await rpc('config.update',{performance:{activeId:profiles[0].id,profiles}});
    formFromConfig();state.settings.contextBudget=config.contextBudget;store('june.settings',state.settings);await refreshDiagnostics();
  }));
  $('#performanceSettingsForm').addEventListener('submit',guard(async e=>{
    e.preventDefault();const profile=editedPerformance(),profiles=config.performance.profiles.map(p=>p.id===profile.id?profile:p);
    try{config=await rpc('config.update',{performance:{activeId:profile.id,profiles}});}catch(error){await refreshState();await refreshDiagnostics();throw error;}
    state.settings.contextBudget=config.contextBudget;store('june.settings',state.settings);formFromConfig();await refreshDiagnostics();await refreshModels();toast('Performance profile applied.');
  }));
  $('#performanceRefreshDiagnostics').addEventListener('click',guard(refreshDiagnostics));
  $('#chatModelSelect').addEventListener('change',guard(async()=>{
    const value=$('#chatModelSelect').value,chat=currentChat();if(chat){chat.model=value;if(!chat.temporary)saveChats();}
    if(!isTemporary()){state.settings.defaultModel=value;store('june.settings',state.settings);}
    if(value)try{const info=await rpc('model.info',{model:value});if(info.capabilities?.includes('embedding')&&!info.capabilities?.includes('completion'))toast('This is an embedding-only model. Select it in RAG settings, not chat.');else if(info.capabilities?.length&&!info.capabilities.includes('tools'))toast($('#chatModeSelect').value==='ask'?'This model cannot call file tools. Chat can still use available project context.':'This model does not advertise tool support. Choose a tool-capable model to inspect the project.');}catch(e){toast(e.message);}
  }));
  $('#agentProfileSelect').addEventListener('change',()=>{
    const id=$('#agentProfileSelect').value,chat=currentChat();
    if(chat){const before=chat.agentOverride;chat.agentOverride={...before,agentId:id};if(!chat.temporary&&!saveChats()){chat.agentOverride=before;sync();return;}}
    else state.pendingAgentId=id;
    sync();
  });
  $('#chatModeSelect').addEventListener('change',()=>{const value=$('#chatModeSelect').value,chat=currentChat();if(chat){chat.mode=value;if(!chat.temporary)saveChats();}else{state.settings.agentMode=value;if(!isTemporary())store('june.settings',state.settings);}sync();});
  $('#ragComposerToggle').addEventListener('click',()=>{if(!config?.rag.enabled){openSettings('rag');return;}useRag=!useRag;sync();});
  $('#stopRunBtn').addEventListener('click',guard(cancel));$('#ragMode').addEventListener('change',sync);
  $('#ragSettingsForm').addEventListener('submit',guard(async e=>{e.preventDefault();config=await rpc('config.update',{embeddingModel:$('#ragEmbeddingModel').value,rag:{enabled:$('#ragEnabled').checked,mode:$('#ragMode').value,topK:Number($('#ragTopK').value),maxFiles:Number($('#ragMaxFiles').value),maxChunks:Number($('#ragMaxChunks').value)}});formFromConfig();toast('Retrieval settings saved. Reindex after changing embedding model or mode.');}));
  $('#indexProjectBtn').addEventListener('click',guard(async()=>{
    if(!rootPath()||isTemporary())throw new Error('Choose a project in a normal session before indexing.');
    if(!await ask('Index this project?',`June will store source-code chunks locally. Hybrid mode sends these chunks to ${config.ollamaUrl}. Check the repository for secrets first.`,undefined,'Index project'))return;
    active={id:crypto.randomUUID(),kind:'index'};sync();$('#ragIndexStatus').textContent='Starting index...';
    try{await rpc('rag.index',{id:active.id,projectPath:rootPath(),temporary:isTemporary()});}catch(e){active=null;sync();throw e;}
  }));
  $('#cancelIndexBtn').addEventListener('click',guard(cancel));
  $('#clearIndexBtn').addEventListener('click',guard(async()=>{if(await ask('Clear this project index?','Remove the stored retrieval chunks. Source files are not changed.',undefined,'Clear index')){await rpc('rag.clear',{projectPath:rootPath()});await refreshIndexStatus();}}));
  $('#mcpTransport').addEventListener('change',mcpTransport);$('#mcpResetBtn').addEventListener('click',resetServerForm);
  $('#mcpServerForm').addEventListener('submit',guard(async e=>{
    e.preventDefault();if(!config)throw new Error('Backend is not ready.');
    const id=$('#mcpServerId').value||crypto.randomUUID(),previous=config.mcpServers.find(s=>s.id===id);
    let args;try{args=JSON.parse($('#mcpArgs').value||'[]');}catch{throw new Error('Arguments must be a valid JSON array of strings.');}
    const server={id,name:$('#mcpServerName').value.trim(),transport:$('#mcpTransport').value,command:$('#mcpCommand').value.trim(),args,url:$('#mcpUrl').value.trim(),allowRemote:$('#mcpAllowRemote').checked,tokenEnv:$('#mcpTokenEnv').value.trim(),envNames:$('#mcpEnvNames').value.split(',').map(s=>s.trim()).filter(Boolean),allowedTools:previous?.allowedTools||[]};
    config=await rpc('config.update',{mcpServers:[...config.mcpServers.filter(s=>s.id!==id),server]});resetServerForm();await refreshState();toast('MCP server saved. Connect it to discover tools.');
  }));
  if(available){
    desktop.onBackendEvent(onEvent);
    initializing=refreshState().then(async()=>{
      const saved=host.readJSON('june.settings',{});if(!Object.hasOwn(saved,'agentMode'))state.settings.agentMode='ask';
      await refreshModels().catch(()=>{});await refreshDiagnostics().catch(()=>{});await refreshIndexStatus();sync();
    }).catch(e=>{status(e.message,'error');toast(e.message);});
  }else{
    initializing=Promise.resolve();$('#chatModelSelect').disabled=true;
    $('#backendTestResult').textContent='Desktop backend unavailable. Restart June with the updated desktop files.';
  }
  resetServerForm();
  return {available,busy,canNavigate,sync,updateContextMeter,send:guard(send),cancel,generateCompaction,cancelCompaction,refreshModels,saveProvider,renderMessageExtras,ready:initializing};
}
