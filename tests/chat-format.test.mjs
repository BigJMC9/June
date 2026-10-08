import test from 'node:test';
import assert from 'node:assert/strict';
import {parseMarkdown,renderMarkdown} from '../chat-format.mjs';

const sample='### Core Features\n\n- **Ollama Backend**: local inference\n- `RAG` retrieval\n\n```js\nconst answer = 42;\n```';

test('Chat Markdown renders headings, bullet points, emphasis, and fenced code',()=>{
 const blocks=parseMarkdown(sample);
 assert.deepEqual(blocks.map(block=>block.type),['heading','ul','codeBlock']);
 assert.equal(blocks[0].level,3);
 assert.deepEqual(blocks[1].items[0].map(node=>node.type),['strong','text']);
 assert.equal(blocks[1].items[0][0].children[0].text,'Ollama Backend');
 assert.equal(blocks[2].text,'const answer = 42;');
});

test('Model HTML remains text and escaped markers stay literal',()=>{
 const blocks=parseMarkdown('Hello <script>alert(1)</script> and \\*\\*literal\\*\\*.');
 assert.equal(blocks[0].type,'paragraph');
 assert.ok(blocks[0].inline.every(node=>node.type==='text'));
 assert.deepEqual(parseMarkdown('Use file_name and a*b*c.')[0].inline,[{type:'text',text:'Use file_name and a*b*c.'}]);
 const makeNode=tag=>({tag,children:[],append(...nodes){this.children.push(...nodes);}});
 const doc={createDocumentFragment:()=>makeNode('fragment'),createElement:makeNode,createTextNode:text=>({tag:'text',text})};
 const output=renderMarkdown('<img src=x onerror=alert(1)>',doc);
 assert.equal(output.children[0].tag,'p');
 assert.equal(output.children[0].children[0].tag,'text');
 assert.match(output.children[0].children[0].text,/onerror/);
});
