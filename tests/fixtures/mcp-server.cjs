'use strict';
const readline=require('node:readline');
const line=readline.createInterface({input:process.stdin});
const output=m=>process.stdout.write(JSON.stringify(m)+'\n');
line.on('line',raw=>{
 const m=JSON.parse(raw);if(m.id===undefined)return;
 const result=m.method==='initialize'?{protocolVersion:'2025-11-25',serverInfo:{name:'test-server',version:'1'},capabilities:{tools:{}}}:
 m.method==='tools/list'?{tools:[{name:'echo',description:'Echo text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false},annotations:{readOnlyHint:true}},{name:'environment',description:'Check forwarded environment',inputSchema:{type:'object',properties:{}}}]}:
 m.method==='tools/call'?{content:[{type:'text',text:m.params.name==='echo'?m.params.arguments.text:JSON.stringify({secret:process.env.JUNE_TEST_SECRET||null,allowed:process.env.JUNE_ALLOWED||null})}]}:{};
 output({jsonrpc:'2.0',id:m.id,result});
});
