/* A small Markdown subset for chat text. Model output is never inserted as HTML. */
function closing(source,marker,start){
 for(let i=start;i<=source.length-marker.length;i++){
  if(source[i]==='\\'){i++;continue;}
  if(source.startsWith(marker,i))return i;
 }
 return -1;
}

export function parseInline(source,depth=0){
 const result=[];let plain='';
 const flush=()=>{if(plain){result.push({type:'text',text:plain});plain='';}};
 for(let i=0;i<source.length;){
  if(source[i]==='\\'&&i+1<source.length&&/[\\`*_~#\[\]()]/.test(source[i+1])){plain+=source[i+1];i+=2;continue;}
  if(source[i]==='`'){
   const end=closing(source,'`',i+1);
   if(end!==-1){flush();result.push({type:'code',text:source.slice(i+1,end)});i=end+1;continue;}
  }
  if(depth<5){
   const marker=['**','__','~~','*','_'].find(item=>source.startsWith(item,i));
   if(marker&&!(marker.length===1&&/[\p{L}\p{N}]/u.test(source[i-1]||''))){const end=closing(source,marker,i+marker.length);
    if(end>i+marker.length){flush();result.push({type:marker==='~~'?'del':marker.length===2?'strong':'em',children:parseInline(source.slice(i+marker.length,end),depth+1)});i=end+marker.length;continue;}
   }
  }
  plain+=source[i++];
 }
 flush();return result;
}

const fence=line=>/^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
const heading=line=>/^ {0,3}(#{1,6})[ \t]+(.+?)\s*#*\s*$/.exec(line);
const bullet=line=>/^ {0,3}[-*+][ \t]+(.+)$/.exec(line);
const numbered=line=>/^ {0,3}\d+[.)][ \t]+(.+)$/.exec(line);
const quote=line=>/^ {0,3}>[ \t]?(.*)$/.exec(line);
const blockStart=line=>Boolean(fence(line)||heading(line)||bullet(line)||numbered(line)||quote(line));

export function parseMarkdown(source){
 const lines=String(source||'').replace(/\r\n?/g,'\n').split('\n'),blocks=[];
 for(let i=0;i<lines.length;){
  const line=lines[i];if(!line.trim()){i++;continue;}
  const open=fence(line);
  if(open){const mark=open[1],body=[];i++;
   while(i<lines.length&&!new RegExp('^ {0,3}'+mark[0]+'{'+mark.length+',}\\s*$').test(lines[i]))body.push(lines[i++]);
   if(i<lines.length)i++;
   blocks.push({type:'codeBlock',text:body.join('\n'),language:open[2].trim().split(/\s+/)[0].slice(0,40)});continue;
  }
  const h=heading(line);if(h){blocks.push({type:'heading',level:h[1].length,inline:parseInline(h[2])});i++;continue;}
  const list=bullet(line)||numbered(line);
  if(list){const type=bullet(line)?'ul':'ol',items=[];
   while(i<lines.length){const item=(type==='ul'?bullet:numbered)(lines[i]);if(!item)break;items.push(parseInline(item[1]));i++;}
   blocks.push({type,items});continue;
  }
  const q=quote(line);if(q){const parts=[];while(i<lines.length){const part=quote(lines[i]);if(!part)break;parts.push(part[1]);i++;}blocks.push({type:'quote',inline:parseInline(parts.join(' '))});continue;}
  const parts=[line.trim()];i++;
  while(i<lines.length&&lines[i].trim()&&!blockStart(lines[i]))parts.push(lines[i++].trim());
  blocks.push({type:'paragraph',inline:parseInline(parts.join(' '))});
 }
 return blocks;
}

function appendInline(parent,nodes,doc){
 for(const node of nodes){
  if(node.type==='text')parent.append(doc.createTextNode(node.text));
  else {const tag={strong:'strong',em:'em',code:'code',del:'del'}[node.type],child=doc.createElement(tag);
   if(node.text!==undefined)child.textContent=node.text;else appendInline(child,node.children,doc);
   parent.append(child);
  }
 }
}

export function renderMarkdown(source,doc=document){
 const fragment=doc.createDocumentFragment();
 const content=String(source||'');
 if(content.length>100000){const plain=doc.createElement('pre');plain.className='message-plain';plain.textContent=content;fragment.append(plain);return fragment;}
 for(const block of parseMarkdown(content)){
  const tag=block.type==='heading'?`h${block.level}`:block.type==='paragraph'?'p':block.type==='quote'?'blockquote':block.type==='codeBlock'?'pre':block.type;
  const element=doc.createElement(tag);
  if(block.type==='codeBlock'){const code=doc.createElement('code');code.textContent=block.text;element.append(code);}
  else if(block.items){for(const item of block.items){const li=doc.createElement('li');appendInline(li,item,doc);element.append(li);}}
  else appendInline(element,block.inline,doc);
  fragment.append(element);
 }
 return fragment;
}
