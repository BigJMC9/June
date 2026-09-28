"""Renderer checks using a simulated Electron preload bridge.

Run: python -m pip install playwright; python tests/ui_smoke.py
JUNE_OFFLINE_TEST=1 uses an about:blank document and simulated storage when a
restricted environment does not permit localhost navigation. This fallback does
not test native storage, CSP, module loading, or operating-system window behavior.
"""
import json
import os
import re
import shutil
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import sync_playwright
from renderer_loader import renderer_bundle

ROOT = Path(__file__).resolve().parents[1]
ARTIFACTS = ROOT / 'test-results'
ARTIFACTS.mkdir(exist_ok=True)
class Handler(SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), partial(Handler, directory=str(ROOT)))
threading.Thread(target=server.serve_forever, daemon=True).start()
BASE = f'http://127.0.0.1:{server.server_port}'
BRIDGE = r"""
window.__calls = [];
window.__mock = { wait: {}, healthOK: false, maximized: false };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const projects = [{id:'june',name:'June',path:'/projects/June'}, {id:'other',name:'Other project',path:'/projects/Other'}];
const dir = (name, path=name) => ({name,path,type:'directory'});
const file = (name,path=name) => ({name,path,type:'file',size:321});
window.juneDesktop = {
 isDesktop:true,
 getRuntimeInfo:async()=>({appVersion:'0.1.0',electronVersion:'test bridge',platform:'win32'}),
 listProjects:async()=>projects,
 selectProjectDirectory:async()=>{ __calls.push('selectProjectDirectory'); return projects[0]; },
 removeProject:async p=>{ __calls.push(['removeProject',p]); return true; },
 listDirectory:async(p,rel,opts)=>{
   __calls.push(['listDirectory',p,rel,opts]);
   await delay(__mock.wait[p] || 0);
   if(p === '/projects/Other') return [file('other.txt')];
   if(rel === 'src') return [dir('ui','src/ui'), file('agent.js','src/agent.js')];
   if(rel === 'src/ui') return [file('workspace.js','src/ui/workspace.js')];
   return [dir('src'),file('README.md'),file('package.json'),file('binary.png'),file('huge.txt'),file('missing.txt'), ...(opts.showHidden ? [file('.env')] : [])];
 },
 readTextFile:async(p,rel,limit)=>{
   __calls.push(['readTextFile',p,rel,limit]);
   await delay(__mock.wait[rel] || 0);
   if(rel === 'missing.txt') throw Error('File no longer exists.');
   return {path:rel,size:rel==='huge.txt'?6000000:321,binary:rel==='binary.png',tooLarge:rel==='huge.txt',content:rel==='README.md' ? '# June\n\nA local AI coding workspace.\n\nOpen a project, find your files, and start a conversation.' : '// '+rel+'\nexport const ready = true;'};
 },
 searchFiles:async(p,q)=>{ __calls.push(['searchFiles',p,q]); await delay(__mock.wait[q] || 0); return q==='src' ? [dir('src')] : [file(q+'.js','src/'+q+'.js')]; },
 getGitStatus:async(p)=>{ __calls.push(['getGitStatus',p]); await delay(__mock.wait[p] || 0); return {available:true,branch:'desktop-electron',files:p.includes('Other')?[]:[{status:' M',path:'src/agent.js'},{status:' D',path:'removed.js'}]}; },
 revealPath:async(p,rel)=>{ __calls.push(['revealPath',p,rel]); return true; },
 checkBackend:async url=>{ __calls.push(['checkBackend',url]); await delay(50); return {ok:__mock.healthOK,message:'Backend is not reachable.'}; },
 minimizeWindow:async()=>{__calls.push('minimize');},
 toggleMaximizeWindow:async()=>{__calls.push('maximize');return __mock.maximized=!__mock.maximized;},
 isWindowMaximized:async()=>__mock.maximized,
 closeWindow:async()=>{__calls.push('close');}
};
"""
OFFLINE = os.environ.get('JUNE_OFFLINE_TEST') == '1'
def load_page(page, saved=None):
    if not OFFLINE:
        if saved is None: page.goto(BASE)
        else: page.reload()
        return
    page.goto('about:blank')
    page.evaluate("""seed => {
      window.__store = seed;
      Object.defineProperty(window, 'localStorage', {value: {
        getItem:k=>Object.hasOwn(__store,k)?__store[k]:null,
        setItem:(k,v)=>{__store[k]=String(v)},
        removeItem:k=>{delete __store[k]},
        clear:()=>{window.__store={}}
      }});
      if(!crypto.randomUUID) crypto.randomUUID = ()=>'test-'+Math.random().toString(36).slice(2);
    }""", saved or {})
    html = (ROOT/'index.html').read_text()
    html = re.sub(r'<meta http-equiv="Content-Security-Policy"[^>]*>', '', html)
    html = re.sub(r'<link rel="stylesheet"[^>]*>', '', html)
    html = re.sub(r'<script[^>]*>.*?</script>', '', html, flags=re.S)
    page.set_content(html)
    page.add_style_tag(content=(ROOT/'styles.css').read_text()+'\n'+(ROOT/'extras.css').read_text())
    page.evaluate('() => {'+renderer_bundle(ROOT)+'}')

def reload_page(page):
    if not OFFLINE: page.reload()
    else: load_page(page, page.evaluate('window.__store'))

results=[]
def check(name, condition):
    assert condition, name
    results.append(name)

def run():
 with sync_playwright() as p:
  browser = p.chromium.launch(headless=True, executable_path=shutil.which('chromium') or None, args=['--no-sandbox'])
  context=browser.new_context(viewport={'width':1440,'height':900},device_scale_factor=1)
  context.add_init_script(BRIDGE)
  page=context.new_page()
  errors=[]
  page.on('pageerror',lambda e:errors.append(str(e)))
  load_page(page)
  page.wait_for_function("document.documentElement.dataset.runtime === 'desktop'")
  page.wait_for_timeout(150)
  check('Workbench starts closed',page.locator('#inspector').is_hidden())
  check('No old metadata or dead toolbar',page.locator('.project-context,.conversation-toolbar,#runsList').count()==0)
  check('Composer starts disabled while empty',page.locator('#sendBtn').is_disabled())
  check('No eager file crawl or health probe',page.evaluate("__calls.length === 0"))
  page.screenshot(path=str(ARTIFACTS/'welcome-no-project.png'))
  page.click('#welcomeAction')
  page.wait_for_function("document.querySelector('#projectName').textContent === 'June'")
  check('Project selection persists in test storage',page.evaluate("localStorage.getItem('june.lastProjectPath') === '/projects/June'"))
  check('Opening project does not force inspector',page.locator('#inspector').is_hidden())
  page.screenshot(path=str(ARTIFACTS/'welcome.png'))
  page.click('#filesButton')
  page.locator('.folder > summary').first.wait_for()
  page.locator('.folder > summary').first.click()
  page.locator('.folder[data-path="src/ui"] > summary').click()
  page.locator('.tree-row[data-path="src/ui/workspace.js"]').click()
  page.wait_for_function("document.querySelector('#filePreviewCode').textContent.includes('export const ready')")
  check('Nested directory reads call the bridge',page.evaluate("__calls.some(c=>Array.isArray(c)&&c[0]==='listDirectory'&&c[2]==='src/ui')"))
  check('File read is marked read-only',page.locator('#filePreviewMeta').inner_text().endswith('Read-only'))
  page.locator('.tree-row[data-path="binary.png"]').click()
  page.wait_for_function("!document.querySelector('#filePreviewNotice').hidden")
  check('Binary preview keeps close control visible',page.locator('#closeFileBtn').is_visible())
  page.locator('.tree-row[data-path="huge.txt"]').click()
  page.wait_for_function("document.querySelector('#filePreviewNotice').textContent.includes('exceeds')")
  check('Oversize notice is readable',page.locator('#filePreviewNotice').is_visible())
  page.locator('.tree-row[data-path="missing.txt"]').click()
  page.wait_for_function("document.querySelector('#filePreviewNotice').textContent.includes('Could not open')")
  page.locator('.tree-row[data-path="README.md"]').click()
  page.wait_for_function("document.querySelector('#filePreviewCode').textContent.includes('# June')")
  check('Text preview recovers from error',page.locator('#filePreviewCode').is_visible())
  page.screenshot(path=str(ARTIFACTS/'file-browser.png'))
  page.click('#revealFileBtn')
  check('Reveal calls bridge with current file',page.evaluate("__calls.some(c=>Array.isArray(c)&&c[0]==='revealPath'&&c[2]==='README.md')"))
  page.click('#closeFileBtn')
  page.click('#changesButton')
  page.locator('.git-change').first.wait_for()
  check('Changes panel displays returned bridge status',page.locator('#branchSummary').inner_text()=='desktop-electron')
  check('Deleted files cannot be previewed',page.locator('.git-change').nth(1).is_disabled())
  page.click('[data-action="close-inspector"]')
  page.fill('#composerInput','Build a project-aware context manager')
  page.keyboard.press('Enter')
  check('Local message creates a chat',page.locator('.chat-item').count()==1)
  check('No fabricated assistant reply',page.locator('.message').count()==1)
  check('Chat saves without opening inspector',page.locator('#inspector').is_hidden())
  page.fill('#composerInput','Keep this unsent draft')
  page.click('#newChatBtn')
  page.fill('#composerInput','A second conversation')
  page.keyboard.press('Enter')
  page.locator('.chat-item').filter(has_text='Build a project').click()
  check('Draft survives chat switching',page.input_value('#composerInput')=='Keep this unsent draft')
  page.click('#projectButton')
  page.locator('.project-entry').filter(has_text='Other project').click()
  check('Chats are scoped to selected project',page.locator('.chat-item').count()==0)
  page.fill('#composerInput','Other project note')
  page.keyboard.press('Enter')
  page.click('#projectButton')
  page.locator('.project-entry').filter(has_text='June').click()
  check('Returning restores project chats',page.locator('.chat-item').count()==2)
  reload_page(page); page.wait_for_timeout(200)
  check('Reload retains project using test storage',page.locator('#projectName').inner_text()=='June')
  check('Reload retains chats using test storage',page.locator('.chat-item').count()==2)
  page.click('#chatOptionsBtn');page.click('[data-action="rename-chat"]')
  page.fill('#actionInput','<script>not code</script>')
  page.click('#actionConfirm');page.wait_for_timeout(100)
  page.wait_for_function("document.querySelector('#chatTitle').textContent === '<script>not code</script>'", timeout=5000)
  check('Chat names render as text',page.locator('#chatTitle').inner_text()=='<script>not code</script>')
  page.click('#chatOptionsBtn'); page.click('[data-action="delete-chat"]')
  page.locator('#actionDialog [data-close]').click();page.wait_for_timeout(50)
  check('Delete cancellation keeps chat',page.locator('.chat-item').count()==2)
  page.click('#chatOptionsBtn'); page.click('[data-action="delete-chat"]');page.click('#actionConfirm');page.wait_for_timeout(100)
  check('Confirmed deletion removes one chat',page.locator('.chat-item').count()==1)
  page.keyboard.press('Control+k')
  check('Search opens and focuses input',page.locator('#paletteInput').evaluate('(e)=>e===document.activeElement'))
  page.fill('#paletteInput','Build');page.wait_for_timeout(250)
  check('Search includes project chats',page.locator('.search-result').count()>=2)
  page.keyboard.press('Escape');page.keyboard.press('Control+k')
  page.evaluate("__mock.wait.slow=450; __mock.wait.fast=10")
  page.fill('#paletteInput','slow');page.wait_for_timeout(200)
  page.fill('#paletteInput','fast');page.wait_for_timeout(650)
  check('Late search response cannot replace latest query','fast.js' in page.locator('#paletteResults').inner_text() and 'slow.js' not in page.locator('#paletteResults').inner_text())
  page.keyboard.press('Escape');page.keyboard.press('Control+k')
  page.fill('#paletteInput','src');page.wait_for_timeout(250)
  page.locator('.search-result').filter(has_text='src').click();page.wait_for_timeout(180)
  check('Directory search opens folder in tree',page.locator('.folder[data-path="src"]').get_attribute('open') is not None)
  page.click('[data-action="close-inspector"]');page.click('#sidebarSettingsBtn')
  check('Settings modal opens',page.locator('#settingsModal').evaluate('(e)=>e.open'))
  page.keyboard.press('Tab');page.keyboard.press('Tab')
  check('Modal traps focus',page.evaluate("!!document.activeElement.closest('#settingsModal')"))
  page.select_option('[data-setting="theme"]','light')
  check('Theme applies across app',page.locator('html').get_attribute('data-theme')=='light')
  page.click('#workspaceTab');page.check('[data-setting="showHidden"]')
  check('Checkbox settings persist in test storage',page.evaluate("JSON.parse(localStorage.getItem('june.settings')).showHidden"))
  page.uncheck('[data-setting="rememberProject"]');page.click('#backendTab')
  page.fill('#settingBackendUrl','ftp://example.com');page.locator('#backendHelp').click()
  check('Invalid backend URL is not persisted',page.evaluate("JSON.parse(localStorage.getItem('june.settings')).backendUrl!=='ftp://example.com'"))
  page.fill('#settingBackendUrl','http://127.0.0.1:8765');page.locator('#backendHelp').click()
  page.click('#testBackendBtn');page.wait_for_timeout(100)
  check('Health error is not described as connected','not reachable' in page.locator('#backendTestResult').inner_text())
  page.evaluate('__mock.healthOK=true');page.click('#testBackendBtn');page.wait_for_timeout(100)
  check('Reachable server still notes missing execution','integration is still pending' in page.locator('#backendTestResult').inner_text())
  page.click('#generalTab');page.select_option('[data-setting="theme"]','dark')
  page.click('#workspaceTab');page.screenshot(path=str(ARTIFACTS/'settings.png'))
  page.keyboard.press('Escape');reload_page(page);page.wait_for_timeout(180)
  check('Remember project off starts unselected',page.locator('#projectName').inner_text()=='Select project')
  page.click('#windowMaximizeBtn');page.wait_for_timeout(40)
  check('Maximize control shows restore state',page.locator('#windowMaximizeBtn').get_attribute('aria-label')=='Restore')
  page.evaluate('__mock.maximized=false; window.dispatchEvent(new Event("resize"))');page.wait_for_timeout(30)
  check('Resize resynchronizes maximize icon',page.locator('#windowMaximizeBtn').get_attribute('aria-label')=='Maximize')
  page.click('#windowMinimizeBtn')
  check('Minimize calls bridge',page.evaluate("__calls.includes('minimize')"))
  page.keyboard.press('Control+b')
  check('Collapsed sidebar has no focusable content',page.locator('#sidebar').evaluate('(e)=>e.inert'))
  reload_page(page);page.wait_for_timeout(180)
  check('Sidebar collapsed state persists in test storage',page.locator('#appShell').evaluate('(e)=>e.classList.contains("is-collapsed")'))
  page.click('#sidebarToggle')
  for width,height in [(1440,900),(1100,700),(980,640),(760,640),(390,844)]:
   page.set_viewport_size({'width':width,'height':height});page.wait_for_timeout(80)
   check(f'No horizontal overflow at {width}x{height}',page.evaluate('document.documentElement.scrollWidth <= innerWidth'))
   check(f'Composer stays visible at {width}x{height}',page.locator('#composerInput').is_visible())
   if width<=760:
    page.click('#sidebarToggle');check(f'Mobile navigation opens at {width}',page.locator('#projectButton').is_visible())
    page.click('#sidebarSettingsBtn');check(f'Settings usable at {width}',page.locator('#settingsModal').is_visible());page.keyboard.press('Escape')
  page.screenshot(path=str(ARTIFACTS/'mobile.png'))
  check('No uncaught renderer errors',len(errors)==0)
  web=browser.new_page(viewport={'width':1200,'height':800})
  web_errors=[];web.on('pageerror',lambda e:web_errors.append(str(e)))
  load_page(web);web.wait_for_timeout(120)
  check('Web preview hides fake window controls',web.locator('.titlebar').is_hidden())
  web.click('#filesButton');check('Web preview has truthful file state','Open a project' in web.locator('#fileTree').inner_text())
  check('Web preview boots without a preload',not web_errors)
  (ARTIFACTS/'results.json').write_text(json.dumps({'passed':len(results),'tests':results,'browser':browser.version,'offline_storage_and_bridge_simulated':OFFLINE,'uncaught_errors':errors},indent=2))
  browser.close()
 server.shutdown()
 print(json.dumps({'passed':len(results),'artifacts':str(ARTIFACTS)},indent=2))
if __name__=='__main__': run()
