'use strict';

const stop=new Set(['about','after','again','also','been','could','does','from','have','into','more','that','them','there','these','this','those','what','when','where','which','with','would','your','the','and','for','was','were','are','our','you','did','how']);
const words=value=>[...new Set(String(value).toLowerCase().match(/[\p{L}\p{N}_./:-]{2,}/gu)||[])].filter(word=>!stop.has(word)).slice(0,24);

function excerpt(content,terms,limit=1000){
 const text=String(content),lower=text.toLowerCase();
 const positions=terms.map(term=>lower.indexOf(term)).filter(n=>n>=0);
 const start=positions.length?Math.max(0,Math.min(...positions)-180):0;
 return (start?'…':'')+text.slice(start,start+limit)+(start+limit<text.length?'…':'');
}

function searchConversation(messages,query,maxResults=3){
 const terms=words(query);if(!terms.length)return [];
 const scored=[];
 for(const message of messages){
  const content=String(message.content),lower=content.toLowerCase();
  let matches=0,score=0;
  for(const term of terms)if(lower.includes(term)){matches++;score+=term.length>=6?3:2;}
  if(!matches)continue;
  score+=matches/terms.length*5;
  scored.push({index:message.index,role:message.role,score,excerpt:excerpt(content,terms),length:content.length});
 }
 scored.sort((a,b)=>b.score-a.score||b.index-a.index);
 return scored.slice(0,maxResults).map(({score,...item})=>item);
}

function readConversation(messages,index,offset=0,limit=8000){
 const message=messages.find(item=>item.index===index);
 if(!message)return {error:'Archived message not found in this chat.'};
 const content=message.content.slice(offset,offset+limit);
 return {index,role:message.role,content,offset,totalLength:message.content.length,hasMore:offset+content.length<message.content.length};
}

module.exports={searchConversation,readConversation};
