'use strict';
const {app,BrowserWindow,dialog,ipcMain,shell,session}=require('electron');
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const fs=require('node:fs/promises');
const {getBackend}=require('./backend.cjs');
const {endpoint,fail}=require('../backend/util.cjs');
const indexPath=path.join(__dirname,'..','index.html'),indexUrl=pathToFileURL(indexPath).href;
let mainWindow=null;
const gotLock=app.requestSingleInstanceLock();
if(!gotLock)app.quit();
function fromEvent(event){const win=BrowserWindow.fromWebContents(event.sender);if(!win||win.isDestroyed()||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==indexUrl)throw fail('This operation is only available in June.');return win;}
function handle(name,fn){ipcMain.handle(name,(event,...args)=>fn(fromEvent(event),...args));}
function register(){
  handle('june:get-runtime-info',()=>({platform:process.platform,appVersion:app.getVersion(),electronVersion:process.versions.electron,isPackaged:app.isPackaged}));
  handle('june:window-minimize',win=>{win.minimize();return true;});
  handle('june:window-toggle-maximize',win=>{win.isMaximized()?win.unmaximize():win.maximize();return win.isMaximized();});
  handle('june:window-is-maximized',win=>win.isMaximized());
  handle('june:window-close',win=>{win.close();return true;});
  handle('june:list-projects',async()=> (await getBackend(app)).workspace.listProjects());
  handle('june:select-project-directory',async win=>{const r=await dialog.showOpenDialog(win,{title:'Open project in June',buttonLabel:'Open project',properties:['openDirectory']});if(r.canceled||!r.filePaths[0])return null;return (await getBackend(app)).workspace.addProject(r.filePaths[0]);});
  handle('june:remove-project',async(_win,root)=>{const b=await getBackend(app);b.idle();return b.workspace.removeProject(root);});
  handle('june:list-directory',async(_win,root,rel='',options={})=>(await getBackend(app)).workspace.listDirectory(root,rel,{showHidden:options.showHidden===true,excludeCommon:options.excludeCommon!==false}));
  handle('june:read-text-file',async(_win,root,rel,max)=>(await getBackend(app)).workspace.readFile(root,rel,max));
  handle('june:search-files',async(_win,root,query,options={})=>(await (await getBackend(app)).workspace.search(root,query,{showHidden:options.showHidden===true,excludeCommon:options.excludeCommon!==false})).results);
  handle('june:get-git-status',async(_win,root)=>(await getBackend(app)).workspace.gitStatus(root));
  handle('june:reveal-path',async(_win,root,rel='')=>{const {target}=await (await getBackend(app)).workspace.resolve(root,rel);if((await fs.stat(target)).isDirectory()){const error=await shell.openPath(target);if(error)throw fail(error);}else shell.showItemInFolder(target);return true;});
  // Kept for compatibility with old UI versions. The live backend uses /api/tags.
  handle('june:check-backend',async(_win,raw)=>{try{const u=endpoint(raw);const r=await fetch(new URL('health',u.href.replace(/\/$/,'')+'/'),{signal:AbortSignal.timeout(3500),redirect:'error'});await r.body?.cancel();return {ok:r.ok,message:r.ok?'Server reachable.':`HTTP ${r.status}`};}catch{return {ok:false,message:'Backend is not reachable.'};}});
}
function createWindow(){
  const win=new BrowserWindow({width:1440,height:900,minWidth:980,minHeight:640,backgroundColor:'#101317',show:false,frame:false,autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.cjs'),contextIsolation:true,nodeIntegration:false,sandbox:true,webSecurity:true}});
  mainWindow=win;win.once('ready-to-show',()=>win.show());win.on('closed',()=>{if(mainWindow===win)mainWindow=null;});
  const external=url=>{try{const u=new URL(url);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)return;void dialog.showMessageBox(win,{type:'question',message:'Open this link in your browser?',detail:u.href,buttons:['Cancel','Open'],defaultId:0,cancelId:0}).then(r=>{if(r.response===1)void shell.openExternal(u.href);});}catch{}};
  win.webContents.setWindowOpenHandler(({url})=>{external(url);return {action:'deny'};});
  win.webContents.on('will-navigate',(event,url)=>{if(url!==indexUrl){event.preventDefault();external(url);}});
  win.webContents.on('will-attach-webview',event=>event.preventDefault());
  for(const event of ['maximize','unmaximize'])win.on(event,()=>{if(!win.webContents.isDestroyed())win.webContents.send('june:window-state',{maximized:win.isMaximized()});});
  void win.loadFile(indexPath);if(process.env.JUNE_DEVTOOLS==='1')win.webContents.openDevTools({mode:'detach'});
}
if(gotLock){
  app.on('second-instance',()=>{if(mainWindow){if(mainWindow.isMinimized())mainWindow.restore();mainWindow.show();mainWindow.focus();}});
  app.whenReady().then(async()=>{
    session.defaultSession.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false));
    session.defaultSession.setPermissionCheckHandler(()=>false);
    await getBackend(app);register();createWindow();
    app.on('activate',()=>{if(BrowserWindow.getAllWindows().length===0)createWindow();});
  }).catch(error=>{dialog.showErrorBox('June could not start',error.message);app.quit();});
  app.on('window-all-closed',()=>{if(process.platform!=='darwin')app.quit();});
}
