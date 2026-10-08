import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeKnowledge,normalizeCookbook,normalizeAgentStore,resolveAgentConfig,condensationCutoff,condensationTriggerTokens,estimatedInputTokens,eligibleKnowledge,buildContext,buildCondensationPrompt,DEFAULT_CONDENSATION_INSTRUCTIONS,serializeChat,memoryCandidates,parseSkill,duplicateMemoryIds,validEndpoint,launchCommand,downloadCommand,quoteArgument} from '../workspace-data.mjs';

test('Legacy condensation instructions migrate into the default agent',()=>{
 const store=normalizeAgentStore({},'Keep exact file paths.');
 assert.equal(store.profiles[0].condensation.instructions,'Keep exact file paths.');
 assert.equal(store.profiles[0].condensation.triggerPercent,75);
 assert.deepEqual(store.profiles[0].conversationRetrieval,{enabled:true,includeInRag:false,maxResults:3});
});
test('Project and chat overrides resolve in order, including agent selection',()=>{
 const store=normalizeAgentStore({defaultAgentId:'a',profiles:[{id:'a',name:'A',systemPrompt:'Global A',instructions:'A instructions',condensation:{instructions:'Condense A',triggerPercent:75,summaryBudget:1024,recentTurns:3}},{id:'b',name:'B',systemPrompt:'Global B',condensation:{instructions:'Condense B',triggerPercent:80,summaryBudget:512,recentTurns:2}}],projectOverrides:{'/A':{agentId:'b',instructions:'Project instructions',condensation:{triggerPercent:60}}}});
 const chat={agentOverride:{instructions:'Chat instructions',condensation:{recentTurns:1}}};
 assert.deepEqual(resolveAgentConfig(store,'/A',chat).condensation,{instructions:'Condense B',triggerPercent:60,summaryBudget:512,recentTurns:1});
 assert.equal(resolveAgentConfig(store,'/A',chat).instructions,'Chat instructions');
 assert.equal(resolveAgentConfig(store,'/B',chat).id,'a');
 chat.agentOverride.agentId='a';assert.equal(resolveAgentConfig(store,'/A',chat).id,'a');
});
test('Conversation retrieval settings inherit across profile, project and chat',()=>{
 const store=normalizeAgentStore({profiles:[{id:'a',name:'A',conversationRetrieval:{enabled:true,includeInRag:false,maxResults:2}}],projectOverrides:{'/A':{conversationRetrieval:{includeInRag:true}}}});
 const chat={agentOverride:{conversationRetrieval:{maxResults:5,enabled:false}}};
 assert.deepEqual(resolveAgentConfig(store,'/A',chat).conversationRetrieval,{enabled:false,includeInRag:true,maxResults:5});
 assert.deepEqual(resolveAgentConfig(store,'/B').conversationRetrieval,{enabled:true,includeInRag:false,maxResults:2});
});
test('Recent turn cutoff keeps complete user turns and never mutates history',()=>{
 const messages=[{role:'user',content:'old'},{role:'assistant',content:'answer'},{role:'user',content:'middle'},{role:'assistant',content:'answer'},{role:'user',content:'recent'}];
 assert.equal(condensationCutoff(messages,1),4);assert.equal(condensationCutoff(messages,2),2);assert.equal(condensationCutoff(messages,0),5);
 assert.equal(estimatedInputTokens({messages},null,'pending')>0,true);
 assert.equal(messages.length,5);
});
test('Condensation meter threshold matches the send trigger',()=>{
 assert.equal(condensationTriggerTokens(8192,2048,75),4608);
 assert.equal(condensationTriggerTokens(8192,2048,0),0);
});
test('Automatic summaries are marked unreviewed in request context',()=>{
 const context=buildContext({messages:[{role:'user',content:'old'},{role:'user',content:'new'}],compaction:{summary:'draft',through:1,automatic:true}},lib,'/A');
 assert.equal(context.messages[0].role,'user');assert.match(context.messages[0].content,/not reviewed by the user/);
 assert.equal(context.messages[1].content,'new');
});
const lib=normalizeKnowledge({preferences:{maxSkills:1},memories:[{id:'g',content:'Global'},{id:'a',content:'A',projectPath:'/A'},{id:'b',content:'B',projectPath:'/B'},{id:'off',content:'Off',enabled:false}],skills:[{id:'1',title:'A',how:'steps',approved:true},{id:'2',title:'B',how:'steps',approved:true},{id:'3',title:'Draft',how:'steps'},{id:'4',title:'Other',how:'steps',projectPath:'/B',approved:true}]});
test('Knowledge normalizer handles corrupt entries',()=>assert.equal(normalizeKnowledge({memories:[null,{},false]}).memories.length,0));
test('Knowledge defaults have a bounded skill budget',()=>assert.equal(normalizeKnowledge(null).preferences.maxSkills,3));
test('Project scope is isolated',()=>assert.deepEqual(eligibleKnowledge(lib,'/A').memories.map(m=>m.id),['g','a']));
test('Only approved skills up to budget are included',()=>assert.deepEqual(eligibleKnowledge(lib,'/A').skills.map(s=>s.id),['1']));
test('Zero skill budget disables skill inclusion',()=>{const next=structuredClone(lib);next.preferences.maxSkills=0;assert.equal(eligibleKnowledge(next,'/A').skills.length,0);});
test('Global disable switches exclude knowledge',()=>{const next=structuredClone(lib);next.preferences.memoriesEnabled=next.preferences.skillsEnabled=false;assert.deepEqual(eligibleKnowledge(next,'/A'),{memories:[],skills:[]});});
test('Temporary contexts contain no saved knowledge or retention',()=>{const r=buildContext({messages:[{role:'user',content:'secret'}]},lib,'/A',true);assert.equal(r.retention,'none');assert.equal(r.memoryRead,false);assert.equal(r.memoryWrite,false);assert.deepEqual(r.memories,[]);assert.deepEqual(r.skills,[]);});
test('Compaction changes request context, not chat history',()=>{const c={messages:[{role:'user',content:'1'},{role:'user',content:'2'}],compaction:{summary:'reviewed',through:1}},copy=JSON.stringify(c),r=buildContext(c,lib,'/A');assert.equal(r.messages.length,2);assert.match(r.messages[0].content,/reviewed/);assert.equal(JSON.stringify(c),copy);});
test('Invalid compaction cursor cannot omit history',()=>assert.equal(buildContext({messages:[{role:'user',content:'one'}],compaction:{summary:'bad',through:99}},lib,'/A').messages[0].content,'one'));
test('Condensation prompt applies saved instructions to older messages without changing history',()=>{
 const chat={messages:[{role:'user',content:'First requirement'},{role:'assistant',content:'Implemented it'},{role:'user',content:'New correction'}]};
 const before=JSON.stringify(chat),draft=buildCondensationPrompt(chat,1,'Keep exact errors and decisions.');
 assert.equal(draft.through,2);assert.match(draft.prompt,/Keep exact errors and decisions/);assert.match(draft.prompt,/First requirement/);
 assert.doesNotMatch(draft.prompt,/New correction/);assert.equal(JSON.stringify(chat),before);
 assert.match(DEFAULT_CONDENSATION_INSTRUCTIONS,/verified facts/);
});
test('Condensation refresh uses the reviewed summary plus only new older messages',()=>{
 const chat={messages:[{role:'user',content:'Old one'},{role:'assistant',content:'Old two'},{role:'user',content:'New older'},{role:'user',content:'Keep recent'}],compaction:{summary:'Reviewed previous work',through:2}};
 const draft=buildCondensationPrompt(chat,1,'Preserve progress.');assert.equal(draft.through,3);
 assert.match(draft.prompt,/Reviewed previous work/);assert.match(draft.prompt,/New older/);
 assert.doesNotMatch(draft.prompt,/Old one|Keep recent/);
 assert.throws(()=>buildCondensationPrompt(chat,4,'Preserve progress.'),/fewer recent/);
});
test('Transcripts preserve literal user HTML',()=>assert.match(serializeChat({title:'June chat',messages:[{role:'user',content:'<script>literal</script>'}]}),/<script>literal/));
test('Imports cannot smuggle IDs, scope or approval',()=>{const r=memoryCandidates(JSON.stringify({version:1,skills:[{id:'stolen',title:'S',how:'H',approved:true,projectPath:'/other'}]}),'b.json')[0];assert.equal(r.approved,undefined);assert.equal(r.id,undefined);assert.equal(r.projectPath,undefined);});
test('Malformed and oversized imports fail',()=>{assert.throws(()=>memoryCandidates('{}','x.json'));assert.throws(()=>memoryCandidates('x'.repeat(1048577),'x.txt'));});
test('Text import creates candidate paragraphs',()=>assert.equal(memoryCandidates('One\n\nTwo','file.md').length,2));
test('Skill file parses text without evaluation',()=>{const r=parseSkill('---\nname: lint\ndescription: Before commit\n---\n# Steps\nRun tests');assert.equal(r.title,'lint');assert.equal(r.when,'Before commit');assert.match(r.how,/# Steps/);});
test('Duplicates respect category and scope',()=>assert.deepEqual(duplicateMemoryIds([{id:'1',content:'SAME  fact',category:'fact',projectPath:''},{id:'2',content:'same fact',category:'fact',projectPath:''},{id:'3',content:'same fact',category:'fact',projectPath:'/A'}]),['2']));
test('Endpoint rejects credentials, file URLs and secret query',()=>{assert.ok(validEndpoint('http://127.0.0.1:8080'));for(const v of ['file:///etc/passwd','https://user:secret@example.org','https://example.org/?key=x'])assert.equal(validEndpoint(v),false);});
test('Cookbook setup defaults remain valid',()=>{const r=normalizeCookbook({activeRecipeId:'r',recipes:[{id:'r',name:'R',model:'M',context:-1,endpoint:'file:///x'}]});assert.equal(r.activeRecipeId,'r');assert.equal(r.recipes[0].context,32768);});
test('Shell quoting escapes single quotes and rejects newline',()=>{assert.equal(quoteArgument("a'b",'win32'),"'a''b'");assert.equal(quoteArgument("a'b",'linux'),"'a'\\''b'");assert.throws(()=>quoteArgument('a\nb'));});
test('Launch command binds only localhost',()=>assert.match(launchCommand({runtime:'llama.cpp',filePath:'C:\\a b.gguf',endpoint:'http://localhost:8080',context:4096},'win32'),/--ctx-size 4096 --host 127\.0\.0\.1 --port 8080/));
test('Download helper validates names and rejects traversal',()=>{assert.throws(()=>downloadCommand('owner/repo','../x'));assert.throws(()=>downloadCommand('owner/../repo','a.gguf'));assert.equal(downloadCommand('owner/repo','a b.gguf','win32'),"hf download 'owner/repo' 'a b.gguf'");});
