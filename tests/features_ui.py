"""Render-only integration tests. Native bridge and storage are simulated."""
import os
os.environ['JUNE_OFFLINE_TEST']='1'
import json, shutil
from playwright.sync_api import sync_playwright
from ui_smoke import BRIDGE, load_page, reload_page, server, ROOT
ART=ROOT/'test-results';ART.mkdir(exist_ok=True)
EXTRA=r'''
window.__exports=[];window.__copied=[];
Object.assign(window.juneDesktop,{
copyText:async text=>{__copied.push(text);return true},
saveArtifact:async payload=>{__exports.push(payload);return {saved:true}},
getCookbookInfo:async()=>({platform:'win32',modelRoot:'/models'}),
chooseModelFolder:async()=>({path:'/models'}),
scanModels:async()=>({models:[{name:'coder-Q4.gguf',modelId:'coder',path:'/models/coder-Q4.gguf',format:'gguf',size:4000000000},{name:'org/model',modelId:'org/model',path:'/models/models--org--model',format:'huggingface',size:123000000}],truncated:false,skipped:0}),
inspectEnvironment:async()=>({cpu:'Test CPU',logicalCpus:8,ram:32000000000,freeRam:16000000000,dependencies:[{name:'Git',available:true,version:'test version'},{name:'Ollama',available:false,reason:'Not found on PATH'}]}),
fetchSkill:async url=>({source:url,content:'---\nname: review-python\ndescription: Before a Python commit\n---\n# Review\nRun tests and inspect the diff.'}),
openModelPage:async()=>true
});
'''
results=[]
def check(name,value):
 assert value,name
 results.append(name)
def saved(p,key):return p.evaluate('(k)=>localStorage.getItem(k)',key)
def library(p):return json.loads(saved(p,'june.knowledge.v1') or '{}')
def tab(p,kind,name):p.click(f'#{kind}-{name}-tab')
def run():
 with sync_playwright() as playwright:
  browser=playwright.chromium.launch(headless=True,executable_path=shutil.which('chromium'),args=['--no-sandbox'])
  ctx=browser.new_context(viewport={'width':1440,'height':900});ctx.add_init_script(BRIDGE);ctx.add_init_script(EXTRA)
  p=ctx.new_page();errors=[];p.on('pageerror',lambda e:errors.append(str(e)));load_page(p);p.wait_for_timeout(150)
  check('Fresh title is June chat',p.locator('#chatTitle').inner_text()=='June chat')
  p.click('#chatOptionsBtn');check('Title opens anchored menu',p.locator('#chatMenu').evaluate("e=>e.matches(':popover-open')"));check('Empty transcript cannot export',p.locator('[data-extra="export-pdf"]').is_disabled());p.keyboard.press('ArrowDown');check('Menu has keyboard focus',p.evaluate("document.activeElement.closest('#chatMenu')!==null"));p.keyboard.press('Escape')
  p.click('#welcomeAction');p.wait_for_timeout(100);p.fill('#composerInput','Review the repository structure');p.keyboard.press('Enter');p.fill('#composerInput','My normal unsent draft')
  p.click('#chatOptionsBtn');p.click('[data-extra="copy-chat"]');check('Copy uses real transcript',p.evaluate("__copied[0].includes('Review the repository')"))
  p.click('#chatOptionsBtn');p.click('[data-extra="export-pdf"]');check('PDF calls explicit desktop export API',p.evaluate("__exports[0].format==='pdf'"))
  p.click('#chatOptionsBtn');p.click('[data-extra="save-document"]');check('Documents export chooses documents directory',p.evaluate('__exports[1].documents===true'))
  p.click('#chatOptionsBtn');p.click('[data-extra="compact"]');p.fill('#compactSummary','Repository reviewed; implement workspace tools next.');p.fill('#compactKeep','0');p.locator('#compactForm [type="submit"]').click()
  check('Compaction retains full history',p.evaluate("JSON.parse(localStorage.getItem('june.chats'))[0].compaction.through===1 && JSON.parse(localStorage.getItem('june.chats'))[0].messages.length===1"))
  p.click('#chatOptionsBtn');p.click('[data-extra="chat-settings"]');p.select_option('#chatMode','plan');p.fill('#chatBudget','8192');p.locator('#chatSettingsForm [type="submit"]').click()
  check('Per-chat mode is independent of global',p.evaluate("JSON.parse(localStorage.getItem('june.chats'))[0].mode==='plan' && (JSON.parse(localStorage.getItem('june.settings')||'{}').agentMode||'agent')==='agent'"))
  p.click('#knowledgeButton');tab(p,'knowledge','add');p.fill('#memoryContent','Use pytest for this project.');p.select_option('#memoryCategory','instruction');p.click('#saveMemoryBtn')
  check('Memory saved with project scope',library(p)['memories'][0]['projectPath']=='/projects/June')
  p.locator('[aria-label="Enable memory"]').uncheck();check('Memory enable switch persists',library(p)['memories'][0]['enabled']==False);p.locator('[aria-label="Enable memory"]').check()
  tab(p,'knowledge','add');p.fill('#memoryContent','<script>literal text</script>');p.select_option('#memoryAddScope','global');p.click('#saveMemoryBtn')
  check('Memory content is escaped text',p.locator('#memoryList script').count()==0 and '<script>literal text</script>' in p.locator('#memoryList').inner_text())
  p.select_option('#memoryScope','global');check('Memory scope filter works',p.locator('#memoryList .knowledge-entry').count()==1);p.select_option('#memoryScope','applicable');p.fill('#memorySearch','pytest');check('Memory search works',p.locator('#memoryList .knowledge-entry').count()==1);p.fill('#memorySearch','')
  tab(p,'knowledge','add');p.fill('#skillTitle','Review a Python patch');p.fill('#skillWhen','Before a Python commit');p.fill('#skillHow','Run pytest.\nInspect API changes.');p.fill('#skillTags','python, review');p.click('#saveSkillBtn')
  check('Skill starts as unapproved draft',library(p)['skills'][0]['approved']==False)
  p.locator('[aria-label="Review & approve"]').click();p.check('#skillApprove');p.click('#saveSkillBtn');check('Explicit approval persisted',library(p)['skills'][0]['approved']==True)
  p.locator('.skill-instructions summary').click();check('Skill instructions expandable','Run pytest.' in p.locator('.skill-instructions pre').inner_text());p.screenshot(path=str(ART/'skills.png'))
  tab(p,'knowledge','settings');p.fill('#maxSkills','0');p.locator('#knowledgeDialogTitle').click();check('Zero skills setting persists',library(p)['preferences']['maxSkills']==0)
  p.fill('#maxSkills','3');p.locator('#knowledgeDialogTitle').click();tab(p,'knowledge','add')
  payload={'version':1,'memories':[{'id':'bad','content':'Imported fact','projectPath':'/other'}],'skills':[{'id':'evil','title':'Imported skill','when':'When needed','how':'Review safely','approved':True}]}
  p.set_input_files('#knowledgeFileInput',{'name':'backup.json','mimeType':'application/json','buffer':json.dumps(payload).encode()});p.locator('#importReviewDialog').wait_for();check('Import waits for confirmation',len(library(p)['memories'])==2);p.click('#confirmImportBtn')
  check('Import cannot bypass skill approval',next(s for s in library(p)['skills'] if s['title']=='Imported skill')['approved']==False)
  check('Import ignores embedded project scope',next(m for m in library(p)['memories'] if m['content']=='Imported fact')['projectPath']=='/projects/June')
  tab(p,'knowledge','add');p.fill('#skillImportUrl','https://github.com/owner/repo/blob/main/SKILL.md');p.click('#fetchSkillBtn');p.locator('#importReviewDialog').wait_for();p.click('#confirmImportBtn');check('GitHub import becomes draft skill',next(s for s in library(p)['skills'] if s['title']=='review-python')['approved']==False)
  tab(p,'knowledge','memories');check('Switch has no inherited second mark',p.locator('#memoriesEnabled').evaluate("e=>getComputedStyle(e,'::after').display==='none'"));check('Tab resets scroll position',p.locator('#knowledgeDialog > .feature-body').evaluate('e=>e.scrollTop===0'));check('Search has no nested border',p.locator('#memorySearch').evaluate("e=>getComputedStyle(e).borderTopWidth==='0px'"));p.screenshot(path=str(ART/'memories.png'));p.keyboard.press('Escape')
  p.click('#cookbookButton');p.click('#scanModelsBtn');p.locator('.model-entry').first.wait_for();check('Model scan renders native metadata',p.locator('.model-entry').count()==2)
  p.locator('.model-entry').filter(has_text='coder-Q4').locator('button').click();check('GGUF setup prepares localhost command','--host 127.0.0.1' in p.input_value('#recipeCommand'));p.locator('#recipeForm [type="submit"]').click();p.locator('[aria-label="Use setup"]').click();check('Use setup sets model preference',p.evaluate("JSON.parse(localStorage.getItem('june.settings')).defaultModel==='coder'"));check('Model setup does not replace pipeline endpoint',p.evaluate("JSON.parse(localStorage.getItem('june.settings')).backendUrl==='http://127.0.0.1:8765'"));p.screenshot(path=str(ART/'cookbook.png'))
  tab(p,'cookbook','download');p.fill('#downloadRepo','owner/repo');p.fill('#downloadFile','model.gguf');p.locator('#downloadForm [type="submit"]').click();check('Download prepares quoted command',p.input_value('#downloadCommand')=="hf download 'owner/repo' 'model.gguf'");p.click('[data-extra="copy-download"]');check('Command copied explicitly',p.evaluate("__copied.at(-1).startsWith('hf download')"))
  tab(p,'cookbook','dependencies');p.click('#checkDepsBtn');p.locator('.dependency-row').first.wait_for();check('Dependencies distinguish missing executables','Not found on PATH' in p.locator('#dependencyList').inner_text());p.keyboard.press('Escape')
  p.click('#temporaryButton');p.wait_for_timeout(60);before={k:saved(p,k) for k in ['june.chats','june.drafts','june.activeChatId','june.knowledge.v1']}
  p.fill('#composerInput','TEMPORARY_SENTINEL');p.keyboard.press('Enter');p.fill('#composerInput','TEMPORARY_UNSENT');check('Temporary badge and banner visible',p.locator('#temporaryBadge').is_visible() and p.locator('#temporaryNotice').is_visible());check('Temporary content never changes stored state',all(saved(p,k)==v for k,v in before.items()));check('Temporary transcript is absent from chat list','TEMPORARY_SENTINEL' not in p.locator('#chatList').inner_text())
  check('Temporary composer label is truthful',p.locator('#draftLabel').inner_text()=='Temporary draft' and p.locator('#sendBtn').get_attribute('aria-label')=='Add to temporary chat')
  p.click('#knowledgeButton');check('Temporary mode disables library writes',p.locator('#saveMemoryBtn').is_disabled() and p.locator('#importKnowledgeBtn').is_disabled());p.keyboard.press('Escape')
  p.click('#chatOptionsBtn');p.click('[data-extra="copy-chat"]');p.locator('#actionDialog [data-close]').click();check('Temporary export requires consent',p.evaluate("!__copied.some(s=>s.includes('TEMPORARY_SENTINEL'))"))
  p.click('#newChatBtn');p.locator('#actionDialog [data-close]').click();check('Cancel keeps temporary content',p.locator('#temporaryBadge').is_visible());p.screenshot(path=str(ART/'temporary-chat.png'))
  p.click('#temporaryBadge');p.click('#actionConfirm');p.wait_for_timeout(60);check('Normal draft restored on temporary exit',p.input_value('#composerInput')=='My normal unsent draft');check('No temporary sentinel in any storage value',not p.evaluate("JSON.stringify(__store).includes('TEMPORARY_')"))
  p.click('#temporaryButton');p.fill('#composerInput','RELOAD_EPHEMERAL');p.keyboard.press('Enter');reload_page(p);p.wait_for_timeout(100);check('Reload discards ephemeral content',p.locator('#temporaryBadge').is_hidden() and 'RELOAD_EPHEMERAL' not in p.locator('#chatHistory').inner_text())
  p.click('#chatOptionsBtn');p.screenshot(path=str(ART/'june-chat-menu.png'));p.keyboard.press('Escape')
  for width,height in [(980,640),(760,640),(390,844)]:
   p.set_viewport_size({'width':width,'height':height});p.wait_for_timeout(60)
   if width<=760:p.click('#sidebarToggle')
   p.click('#knowledgeButton');tab(p,'knowledge','add');check(f'Library fits viewport {width}',p.locator('#knowledgeDialog').evaluate('(e)=>e.getBoundingClientRect().width<=innerWidth && e.getBoundingClientRect().height<=innerHeight'));check(f'No library horizontal overflow {width}',p.locator('#knowledgeDialog').evaluate('(e)=>e.scrollWidth<=e.clientWidth'))
   if width==390:p.screenshot(path=str(ART/'knowledge-mobile.png'))
   p.keyboard.press('Escape')
  check('No uncaught renderer errors',not errors)
  (ART/'feature-results.json').write_text(json.dumps({'passed':len(results),'tests':results,'uncaught_errors':errors,'browser':browser.version,'bridge_and_storage_simulated':True},indent=2));browser.close()
 server.shutdown();print(json.dumps({'passed':len(results),'screenshots':str(ART)},indent=2))
if __name__=='__main__':run()
