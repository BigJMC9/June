'use strict';
const path=require('node:path');
const {pathToFileURL}=require('node:url');
const {createBackend}=require('../backend/service.cjs');
const {fail}=require('../backend/util.cjs');
let backendPromise;
function getBackend(app){return backendPromise??=app.whenReady().then(()=>createBackend(app.getPath('userData'))).catch(e=>{backendPromise=null;throw e;});}
function registerBackend({app,BrowserWindow,dialog,ipcMain}){
  const indexUrl=pathToFileURL(path.join(__dirname,'..','index.html')).href;
  function sender(event){const win=BrowserWindow.fromWebContents(event.sender);if(!win||win.isDestroyed()||event.senderFrame!==event.sender.mainFrame||event.senderFrame?.url!==indexUrl)throw fail('Backend access is limited to June\'s main frame.');return win;}
  ipcMain.handle('june:backend',async(event,payload)=>{
    const win=sender(event);if(!payload||typeof payload.action!=='string')throw fail('Invalid backend request.');
    const backend=await getBackend(app),owner=event.sender.id,action=payload.action,data=payload.data||{};
    if(action==='mcp.connect'){
      const def=backend.config.get().mcpServers.find(s=>s.id===data.id);if(!def)throw fail('MCP server not found.');
      const detail=def.transport==='stdio'?`${def.command}\nArguments: ${JSON.stringify(def.args)}\n\nThis launches a program with your user permissions. It is not confined to the project. Only connect servers you trust.`:`${def.url}\n\nThis server receives tool arguments and may perform external actions. Only connect servers you trust.`;
      const result=await dialog.showMessageBox(win,{type:'warning',title:'Connect MCP server?',message:`Connect ${def.name}?`,detail,buttons:['Cancel','Connect'],defaultId:0,cancelId:0,noLink:true});
      if(result.response!==1)return {cancelled:true};
      sender(event);
      const current=backend.config.get().mcpServers.find(s=>s.id===data.id);
      if(JSON.stringify(current)!==JSON.stringify(def))throw fail('MCP settings changed while confirmation was open. Connect again to review the current server.');
    }
    return backend.invoke(action,data,owner,eventData=>{if(!event.sender.isDestroyed()&&event.sender.getURL()===indexUrl)event.sender.send('june:backend-event',eventData);else backend.cancelOwner(owner);});
  });
  app.on('web-contents-created',(_e,contents)=>{
    const cancel=()=>{if(backendPromise)void backendPromise.then(b=>b.cancelOwner(contents.id)).catch(()=>{});};
    contents.on('destroyed',cancel);contents.on('render-process-gone',cancel);
    contents.on('did-start-navigation',(_event,_url,inPlace,mainFrame)=>{if(mainFrame&&!inPlace)cancel();});
  });
  let closing=false;
  app.on('before-quit',event=>{
    if(!backendPromise||closing)return;
    event.preventDefault();closing=true;void backendPromise.then(b=>b.close()).catch(()=>{}).finally(()=>app.quit());
  });
}
module.exports={registerBackend,getBackend};
