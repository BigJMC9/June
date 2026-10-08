"""Browser UI + real Node backend, with a fixture Ollama and MCP process.
The preload, native dialogs and storage are simulated. No model inference is claimed.
"""
import os
os.environ['JUNE_OFFLINE_TEST']='1'
import json, queue, shutil, subprocess, threading, urllib.request, time
from pathlib import Path
from playwright.sync_api import sync_playwright
from ui_smoke import BRIDGE, load_page, reload_page, ROOT
ART=ROOT/'test-results';ART.mkdir(exist_ok=True)
results=[]
def check(name, condition):
    assert condition,name
    results.append(name)
def run():
    proc=subprocess.Popen(['node',str(ROOT/'tests/live-ui-host.cjs')],cwd=ROOT,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True)
    line=proc.stdout.readline()
    if not line:raise RuntimeError(proc.stderr.read())
    host=json.loads(line);events=queue.Queue()
    def request(action,data=None,stream=False):
        payload=json.dumps({'action':action,'data':data or {}}).encode()
        req=urllib.request.Request(host['url']+('/api/stream' if stream else '/api/invoke'),data=payload,headers={'Content-Type':'application/json','Authorization':'Bearer '+host['token']})
        return urllib.request.urlopen(req,timeout=30)
    def invoke(action,data):
        if action in ['run.start','rag.index']:
            def worker():
                try:
                    with request(action,data,True) as response:
                        for raw in response:
                            if raw.startswith(b'data: '):events.put(json.loads(raw[6:]))
                except Exception as error:
                    try:message=json.loads(error.read()).get('error',str(error))
                    except Exception:message=str(error)
                    events.put({'id':data['id'],'type':'error','message':message})
            threading.Thread(target=worker,daemon=True).start()
            return {'id':data['id']}
        try:
            with request(action,data) as response:
                body=json.load(response)
            if not body['ok']:raise RuntimeError(body.get('error','Request failed'))
            return body['result']
        except urllib.error.HTTPError as e:
            raise RuntimeError(json.loads(e.read()).get('error',str(e)))
    def poll():
        out=[]
        while not events.empty():out.append(events.get_nowait())
        return out
    js=r'''
const fixture=FIXTURE;
window.juneDesktop.backendCall=(action,data={})=>window.__backendInvoke(action,data);
window.__backendListeners=[];
window.juneDesktop.onBackendEvent=callback=>{__backendListeners.push(callback);return ()=>{};};
window.juneDesktop.listProjects=async()=>[{id:'actual',name:'June test project',path:fixture.project}];
window.juneDesktop.selectProjectDirectory=async()=>({id:'actual',name:'June test project',path:fixture.project});
setInterval(async()=>{for(const e of await window.__backendPoll())for(const listener of __backendListeners)listener(e)},20);
'''.replace('FIXTURE',json.dumps(host))
    try:
      with sync_playwright() as pw:
        browser=pw.chromium.launch(headless=True,executable_path=shutil.which('chromium'),args=['--no-sandbox'])
        ctx=browser.new_context(viewport={'width':1440,'height':900})
        ctx.expose_function('__backendInvoke',invoke);ctx.expose_function('__backendPoll',poll)
        ctx.add_init_script(BRIDGE);ctx.add_init_script(js)
        page=ctx.new_page();errors=[];page.on('pageerror',lambda e:errors.append(str(e)))
        load_page(page);page.wait_for_function("document.querySelector('#chatModelSelect').options.length>1")
        page.click('#welcomeAction');page.wait_for_function("document.querySelector('#projectName').textContent==='June test project'")
        check('Actual backend model list appears in composer',page.locator('#chatModelSelect').input_value()=='test-coder')
        check('Fresh normal chat defaults to Chat mode',page.locator('#chatModeSelect').input_value()=='ask')
        check('Context meter shows a token estimate and condensation marker',page.locator('#contextMeter').is_visible() and page.locator('#contextMeterThreshold').is_visible() and 'tokens' in page.locator('#contextMeterCount').inner_text())
        page.fill('#composerInput','Explain authentication');page.keyboard.press('Enter')
        page.wait_for_function("document.querySelector('.message[data-status=complete]')!==null")
        check('Ollama stream is displayed as assistant content','A streamed Ollama fixture response.' in page.locator('#chatHistory').inner_text())
        saved=page.evaluate("JSON.parse(localStorage.getItem('june.chats'))")
        check('Normal replies and model choice persist',saved[0]['model']=='test-coder' and saved[0]['messages'][-1]['status']=='complete')
        check('Token statistics are displayed','15 tokens' in page.locator('#chatHistory').inner_text())
        check('Completed response keeps its total elapsed time','total' in page.locator('.message-note').last.inner_text())
        page.click('#newChatBtn');page.fill('#composerInput','slow stream');page.keyboard.press('Enter');page.wait_for_selector('#stopRunBtn:visible')
        page.wait_for_function("document.querySelector('.message[data-status=running] .message-body').textContent.length>0")
        page.click('#newChatBtn');check('Navigation cannot discard an active run',page.locator('#stopRunBtn').is_visible())
        page.click('#stopRunBtn');page.wait_for_function("document.querySelector('.message[data-status=cancelled]')!==null")
        check('Stop cancels the actual backend job',not invoke('state',{})['busy'])
        page.click('#sidebarSettingsBtn');page.click('#backendTab');page.wait_for_timeout(40)
        check('Ollama provider controls replace placeholder settings',page.locator('#ollamaSettingsForm').is_visible())
        page.locator('#ollamaSettingsForm .advanced-settings > summary').click();page.check('#agentWrites');page.locator('#ollamaSettingsForm [type=submit]').click()
        page.wait_for_function("document.querySelector('#backendTestResult').dataset.status==='ok'")
        check('Saved permissions reach the backend',invoke('state',{})['config']['writesEnabled'])
        page.locator('#ollamaSettingsForm .advanced-settings > summary').click()
        page.locator('#backendSettings h3').scroll_into_view_if_needed()
        page.screenshot(path=str(ART/'ollama-settings.png'))
        page.locator('#settingsModal [data-close=settingsModal]').first.click()
        page.click('#newChatBtn');page.select_option('#chatModeSelect','agent');page.fill('#composerInput','write a file');page.keyboard.press('Enter')
        page.wait_for_selector('#approvalCard:visible')
        check('File proposal requires visible approval','new-test.js' in page.locator('#approvalCard').inner_text())
        check('File does not exist before approval',not (Path(host['project'])/'new-test.js').exists())
        page.wait_for_function("document.querySelector('#toast').hidden")
        page.screenshot(path=str(ART/'agent-approval.png'))
        page.get_by_role('button',name='Approve once',exact=True).click();page.wait_for_function("document.querySelector('.message[data-status=complete]')!==null")
        check('Approval applies real fixture file',(Path(host['project'])/'new-test.js').read_text()=='export const tested = true;\n')
        page.click('#sidebarSettingsBtn');page.click('#ragSettingsTab');page.check('#ragEnabled');page.locator('#ragSettingsForm [type=submit]').click();page.wait_for_timeout(50)
        page.click('#indexProjectBtn');page.click('#actionConfirm');page.wait_for_function("document.querySelector('#ragIndexStatus').textContent.includes('chunks') && document.querySelector('#cancelIndexBtn').hidden")
        check('Project index stores real source chunks',invoke('rag.status',{'projectPath':host['project']})['indexed'])
        page.screenshot(path=str(ART/'rag-settings.png'))
        page.locator('#settingsModal [data-close=settingsModal]').first.click();page.click('#newChatBtn');page.select_option('#chatModeSelect','ask');page.fill('#composerInput','Where is authentication described?');page.keyboard.press('Enter');page.wait_for_function("document.querySelector('.message[data-status=complete]')!==null")
        check('RAG citations appear beneath the answer',page.locator('.source-chip').count()>=1)
        page.wait_for_function("document.querySelector('#toast').hidden")
        page.screenshot(path=str(ART/'ollama-chat-rag.png'))
        page.click('#temporaryButton');page.fill('#composerInput','TEMPORARY_PRIVATE_MARKER');page.keyboard.press('Enter');page.wait_for_function("document.querySelector('.message[data-status=complete]')!==null")
        check('Temporary response does not enter saved chat storage','TEMPORARY_PRIVATE_MARKER' not in page.evaluate("localStorage.getItem('june.chats')"))
        check('Temporary mode disables RAG control',page.locator('#ragComposerToggle').is_disabled())
        check('Temporary answer contains no RAG sources',page.locator('.source-chip').count()==0)
        page.click('#temporaryBadge');page.click('#actionConfirm');page.wait_for_timeout(40)
        page.click('#sidebarSettingsBtn');page.click('#mcpSettingsTab');page.locator('#mcpEditor summary').click()
        page.fill('#mcpServerName','Fixture tools');page.fill('#mcpCommand',host['node']);page.fill('#mcpArgs',json.dumps([host['mcp']]))
        page.locator('#mcpServerForm [type=submit]').click();page.wait_for_selector('.mcp-server-card')
        page.locator('.mcp-server-card').get_by_role('button',name='Connect',exact=True).click();page.wait_for_function("document.querySelector('.mcp-server-card').textContent.includes('Connected')")
        page.locator('.mcp-server-card details summary').click();page.get_by_label('Enable echo',exact=True).check();page.wait_for_timeout(80)
        check('MCP discovery and tool allowlisting reach actual server',invoke('state',{})['config']['mcpServers'][0]['allowedTools']==['echo'])
        page.screenshot(path=str(ART/'mcp-settings.png'))
        page.locator('#settingsModal [data-close=settingsModal]').first.click();page.click('#newChatBtn');page.select_option('#chatModeSelect','agent');page.fill('#composerInput','MCP echo');page.keyboard.press('Enter');page.wait_for_selector('#approvalCard:visible')
        check('MCP invocation has an explicit approval card','Fixture tools / echo' in page.locator('#approvalCard').inner_text())
        page.get_by_role('button',name='Approve once',exact=True).click();page.wait_for_function("document.querySelector('.message[data-status=complete]')!==null")
        check('Approved MCP response completes the agent loop','Tool completed' in page.locator('#chatHistory').inner_text())
        check('No browser script errors',not errors)
        (ART/'backend-ui-results.json').write_text(json.dumps({'passed':len(results),'checks':results,'errors':errors,'environment':'Chromium with simulated preload/storage and real Node backend talking to protocol fixtures'},indent=2))
        print(json.dumps({'passed':len(results),'checks':results},indent=2));browser.close()
    finally:
        proc.terminate()
        try:proc.wait(timeout=8)
        except subprocess.TimeoutExpired:proc.kill()
if __name__=='__main__':run()
