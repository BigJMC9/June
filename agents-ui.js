import { AGENTS_KEY, normalizeAgentStore, normalizeAgentOverride, resolveAgentConfig } from './workspace-data.mjs';

export function installAgents({state,$,el,store,currentChat,rootPath,saveChats,toast,onChange}) {
  let editingId=state.agentStore.defaultAgentId;
  const profile=()=>state.agentStore.profiles.find(item=>item.id===editingId)||state.agentStore.profiles[0];
  const scope=()=>$('#agentSettingsScope').value;
  const fields={systemPrompt:'#agentSystemPrompt',instructions:'#agentInstructions',instructionsCompact:'#agentCondensationInstructions',triggerPercent:'#agentTriggerPercent',summaryBudget:'#agentSummaryBudget',recentTurns:'#agentRecentTurns'};
  const option=(value,label)=>{const node=el('option','',label);node.value=value;return node;};
  function persist(next){
    if(!store(AGENTS_KEY,next))return false;
    state.agentStore=next;onChange();return true;
  }
  function selectors(){
    const edit=$('#agentEditorSelect'),choose=$('#agentOverrideProfile');edit.replaceChildren();choose.replaceChildren(option('','Inherit agent'));
    for(const item of state.agentStore.profiles){edit.append(option(item.id,item.name));choose.append(option(item.id,item.name));}
    if(!state.agentStore.profiles.some(item=>item.id===editingId))editingId=state.agentStore.defaultAgentId;
    edit.value=editingId;
  }
  function setFields(source,override){
    $('#agentName').value=override?'':source.name;
    $('#agentSystemPrompt').value=source.systemPrompt||'';
    $('#agentInstructions').value=source.instructions||'';
    $('#agentCondensationInstructions').value=source.condensation?.instructions||'';
    for(const key of ['triggerPercent','summaryBudget','recentTurns'])$(fields[key]).value=source.condensation?.[key]??'';
    $('#agentConversationRetrieval').value=source.conversationRetrieval?.enabled===undefined?'':String(source.conversationRetrieval.enabled);
    $('#agentConversationRag').value=source.conversationRetrieval?.includeInRag===undefined?'':String(source.conversationRetrieval.includeInRag);
    $('#agentConversationMaxResults').value=source.conversationRetrieval?.maxResults??'';
    $('#agentIsDefault').checked=!override&&source.id===state.agentStore.defaultAgentId;
    $('#agentIsDefault').disabled=!override&&source.id===state.agentStore.defaultAgentId;
    $('#agentOverrideProfile').value=override&&state.agentStore.profiles.some(p=>p.id===source.agentId)?source.agentId:'';
    $('#agentSettingsStatus').textContent='';
  }
  function sync(){
    const selected=scope(),chat=currentChat(),project=rootPath();
    $('#agentSettingsScope option[value="project"]').disabled=!project;
    $('#agentSettingsScope option[value="chat"]').disabled=!chat;
    if((selected==='project'&&!project)||(selected==='chat'&&!chat))$('#agentSettingsScope').value='profile';
    selectors();
    const override=scope()!=='profile';
    $('#agentProfileControls').hidden=override;$('#agentNameRow').hidden=override;$('#agentName').required=!override;$('#agentDefaultRow').hidden=override;
    $('#agentOverrideProfileRow').hidden=!override;$('#agentClearOverrideBtn').hidden=!override;
    $('#agentConversationRetrieval option[value=""]').disabled=!override;$('#agentConversationRag option[value=""]').disabled=!override;
    const source=override?normalizeAgentOverride(scope()==='project'?state.agentStore.projectOverrides[project]:chat?.agentOverride):profile();
    setFields(source,override);
  }
  function readFields(override){
    const systemPrompt=$('#agentSystemPrompt').value.trim(),instructions=$('#agentInstructions').value.trim(),compact=$('#agentCondensationInstructions').value.trim();
    const values={};for(const key of ['triggerPercent','summaryBudget','recentTurns']){
      const input=$(fields[key]);if(input.value===''){if(!override)throw new Error('Set all condensation numbers for a profile.');continue;}
      if(!input.checkValidity())throw new Error(`Enter a valid value for ${key}.`);
      values[key]=Number(input.value);
    }
    if(!override&&!compact)throw new Error('Enter condensation instructions for the agent.');
    const retrieval={};
    for(const [key,id] of [['enabled','#agentConversationRetrieval'],['includeInRag','#agentConversationRag']]){
      const value=$(id).value;if(value===''){if(!override)throw new Error('Set conversation retrieval options for the agent.');}else retrieval[key]=value==='true';
    }
    const max=$('#agentConversationMaxResults');if(max.value===''){if(!override)throw new Error('Set the maximum retrieved messages.');}
    else {if(!max.checkValidity())throw new Error('Enter a maximum of 1 to 8 retrieved messages.');retrieval.maxResults=Number(max.value);}
    const raw={systemPrompt,instructions,condensation:{instructions:compact,...values},conversationRetrieval:retrieval};
    if(override)raw.agentId=$('#agentOverrideProfile').value;
    return override?normalizeAgentOverride(raw):raw;
  }
  function save(event){
    event.preventDefault();const selected=scope(),override=selected!=='profile',data=readFields(override);
    if(override){
      if(selected==='project'){
        const next=structuredClone(state.agentStore),key=rootPath();if(!key)throw new Error('Open a project first.');
        if(Object.keys(data).length)next.projectOverrides[key]=data;else delete next.projectOverrides[key];
        if(!persist(normalizeAgentStore(next)))return;
      }else{
        const chat=currentChat();if(!chat)throw new Error('Open a chat first.');
        const before=chat.agentOverride;chat.agentOverride=data;
        if(!chat.temporary&&!saveChats()){chat.agentOverride=before;return;}
        onChange();
      }
    }else{
      const name=$('#agentName').value.trim();if(!name)throw new Error('Name the agent.');
      const next=structuredClone(state.agentStore),item=next.profiles.find(p=>p.id===editingId);
      Object.assign(item,{name,...data});if($('#agentIsDefault').checked)next.defaultAgentId=item.id;
      if(!persist(normalizeAgentStore(next)))return;
    }
    $('#agentSettingsStatus').textContent='Saved.';selectors();
  }
  function add(){
    if(state.agentStore.profiles.length>=20)throw new Error('June supports up to 20 agents.');
    const next=structuredClone(state.agentStore),base=profile(),id=crypto.randomUUID();
    next.profiles.push({...structuredClone(base),id,name:'New agent'});
    if(!persist(normalizeAgentStore(next)))return;editingId=id;sync();$('#agentName').focus();$('#agentName').select();
  }
  function remove(){
    if(state.agentStore.profiles.length===1)throw new Error('Keep at least one agent.');
    const next=structuredClone(state.agentStore);next.profiles=next.profiles.filter(p=>p.id!==editingId);
    if(next.defaultAgentId===editingId)next.defaultAgentId=next.profiles[0].id;
    if(!persist(normalizeAgentStore(next)))return;editingId=next.defaultAgentId;sync();
  }
  function clear(){
    if(scope()==='project'){
      const next=structuredClone(state.agentStore);delete next.projectOverrides[rootPath()];if(!persist(normalizeAgentStore(next)))return;
    }else if(scope()==='chat'){
      const chat=currentChat();if(!chat)return;const old=chat.agentOverride;delete chat.agentOverride;
      if(!chat.temporary&&!saveChats()){chat.agentOverride=old;return;}onChange();
    }sync();$('#agentSettingsStatus').textContent='Override cleared.';
  }
  const guard=fn=>event=>{try{fn(event);}catch(error){toast(error.message);}};
  $('#agentSettingsScope').addEventListener('change',sync);
  $('#agentEditorSelect').addEventListener('change',()=>{editingId=$('#agentEditorSelect').value;sync();});
  $('#agentSettingsForm').addEventListener('submit',guard(save));
  $('#agentAddBtn').addEventListener('click',guard(add));
  $('#agentDeleteBtn').addEventListener('click',guard(remove));
  $('#agentClearOverrideBtn').addEventListener('click',guard(clear));
  sync();
  return {sync,resolve:()=>resolveAgentConfig(state.agentStore,rootPath(),currentChat())};
}
