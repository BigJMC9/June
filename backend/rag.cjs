'use strict';
const { DatabaseSync } = require('node:sqlite');
const fs = require('node:fs/promises');
const path = require('node:path');
const { hash, fail, aborted, tick } = require('./util.cjs');
const CHUNKER_VERSION = 1;
// Line-aware chunks are deliberately small so most embedding models need no truncation.
function chunksOf(content, file) {
  const lines = content.split('\n'), chunks = []; let start = 0;
  while (start < lines.length) {
    let end = start, count = 0;
    while (end < lines.length && end - start < 45 && (count + lines[end].length < 1800 || end === start)) { count += lines[end].length + 1; end++; }
    const text = lines.slice(start, end).join('\n');
    // Long minified lines are omitted rather than sliced with misleading line citations.
    if (text.trim() && text.length <= 8000) chunks.push({ path: file, start: start + 1, end, text });
    start = end === lines.length ? end : Math.max(start + 1, end - 6);
  }
  return chunks;
}
function tokens(value) { return String(value).replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(x => x.length > 1).slice(0, 200); }
function cosine(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, aa = 0, bb = 0; for (let i=0;i<a.length;i++) { dot += a[i]*b[i]; aa += a[i]*a[i]; bb += b[i]*b[i]; }
  return aa && bb ? dot / Math.sqrt(aa*bb) : 0;
}
function vectorBuffer(vector) { if (!vector) return null; const b = Buffer.alloc(vector.length * 4); vector.forEach((x, i) => b.writeFloatLE(x, i*4)); return b; }
function readVector(blob) { if (!blob) return null; const b = Buffer.from(blob); return Array.from({ length: b.length/4 }, (_,i) => b.readFloatLE(i*4)); }
class RagIndex {
  constructor(dir, workspace) { this.dir = dir; this.workspace = workspace; this.db = null; this.busy = new Set(); }
  async init() {
    await fs.mkdir(this.dir, { recursive: true }); const file = path.join(this.dir, 'rag.sqlite');
    this.db = new DatabaseSync(file); await fs.chmod(file, 0o600).catch(() => {});
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA secure_delete=ON;
      CREATE TABLE IF NOT EXISTS projects(root TEXT PRIMARY KEY, meta TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chunks(root TEXT NOT NULL, path TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, text TEXT NOT NULL, file_hash TEXT NOT NULL, vector BLOB, PRIMARY KEY(root,path,start));
      CREATE INDEX IF NOT EXISTS chunks_root ON chunks(root);`);
  }
  status(root) { const row = this.db.prepare('SELECT meta FROM projects WHERE root=?').get(root); return row ? JSON.parse(row.meta) : { indexed: false, files: 0, chunks: 0 }; }
  rows(root) { return this.db.prepare('SELECT path,start,end,text,file_hash,vector FROM chunks WHERE root=?').all(root); }
  async index(root, config, ollama, signal, emit) {
    root = await this.workspace.root(root);
    if (this.busy.has(root)) throw fail('This project is already being indexed.'); this.busy.add(root);
    try {
      emit({ type: 'index_progress', stage: 'scan', message: 'Scanning source files...' });
      const scan = await this.workspace.walk(root, { maxFiles: config.rag.maxFiles, textOnly: true, signal });
      if (scan.truncated) throw fail('Project exceeds the scan limit. Increase the file limit or open a smaller project. The previous index was kept.');
      const hybrid = config.rag.mode === 'hybrid'; let digest = '';
      if (hybrid) {
        if (!config.embeddingModel) throw fail('Choose an installed embedding model for hybrid RAG.');
        const model = (await ollama.models(signal)).find(m => m.name === config.embeddingModel);
        if (!model) throw fail('The embedding model is not installed in Ollama. Pull it first.'); digest = model.digest;
      }
      const signature = hash(JSON.stringify([CHUNKER_VERSION, config.rag.mode, hybrid ? config.embeddingModel : '', hybrid ? config.ollamaUrl : '', digest]));
      const oldMeta = this.status(root), old = oldMeta.signature === signature ? this.rows(root) : [];
      const previous = new Map(); for (const row of old) { if (!previous.has(row.path)) previous.set(row.path, []); previous.get(row.path).push(row); }
      const staged = []; let files = 0, skipped = scan.skipped, reused = 0, changed = 0;
      for (const filePath of scan.files) {
        aborted(signal); let file;
        try { file = await this.workspace.readFile(root, filePath, 512000, true); } catch { skipped++; continue; }
        if (file.binary || file.tooLarge || !file.content.trim()) { skipped++; continue; }
        let pieces; const cached = previous.get(filePath);
        if (cached?.length && cached.every(x => x.file_hash === file.sha)) { pieces = cached; reused++; }
        else {
          pieces = chunksOf(file.content, filePath).map(x => ({ ...x, file_hash: file.sha, vector: null })); changed++;
          if (staged.length + pieces.length > config.rag.maxChunks) throw fail('Project exceeds the chunk limit. Increase it or select a smaller project. The previous index was kept.');
          if (hybrid) for (let offset=0;offset<pieces.length;offset+=8) {
            aborted(signal); const batch = pieces.slice(offset, offset+8);
            const vectors = await ollama.embed(config.embeddingModel, batch.map(x => `${x.path}\n${x.text}`), signal);
            batch.forEach((item,i) => { item.vector = vectorBuffer(vectors[i]); });
          }
        }
        if (staged.length + pieces.length > config.rag.maxChunks) throw fail('Project exceeds the chunk limit. The previous index was kept.');
        staged.push(...pieces); files++;
        emit({ type: 'index_progress', stage: 'index', files, total: scan.files.length, chunks: staged.length, reused, message: `Indexed ${files} files` }); await tick();
      }
      aborted(signal);
      // Atomic replacement prunes deleted files. Failure/cancellation leaves the previous index intact.
      const meta = { indexed: true, files, chunks: staged.length, skipped, reused, changed, mode: config.rag.mode, embeddingModel: hybrid ? config.embeddingModel : '', embeddingDigest: digest, ollamaUrl: hybrid ? config.ollamaUrl : '', respectsGitignore: scan.respectsGitignore, signature, indexedAt: new Date().toISOString() };
      const insert = this.db.prepare('INSERT INTO chunks(root,path,start,end,text,file_hash,vector) VALUES(?,?,?,?,?,?,?)');
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare('DELETE FROM chunks WHERE root=?').run(root);
        for (const c of staged) insert.run(root,c.path,c.start,c.end,c.text,c.file_hash,c.vector);
        this.db.prepare('INSERT OR REPLACE INTO projects(root,meta) VALUES(?,?)').run(root,JSON.stringify(meta)); this.db.exec('COMMIT');
      } catch(e) { this.db.exec('ROLLBACK'); throw e; }
      emit({ type: 'index_done', ...meta }); return meta;
    } finally { this.busy.delete(root); }
  }
  async retrieve(root, query, config, ollama, signal, emit = () => {}) {
    root = await this.workspace.root(root); const meta = this.status(root);
    if (!meta.indexed) { emit({ type: 'warning', message: 'RAG has no index for this project. Index it in Settings > RAG.' }); return []; }
    let queryVector = null;
    if (config.rag.mode === 'hybrid') {
      if (meta.mode !== 'hybrid' || meta.embeddingModel !== config.embeddingModel || meta.ollamaUrl !== config.ollamaUrl) throw fail('Embedding settings changed. Reindex the project before using hybrid RAG.');
      const model = (await ollama.models(signal)).find(m => m.name === config.embeddingModel);
      if (!model || model.digest !== meta.embeddingDigest) throw fail('The embedding model changed or is missing. Reindex the project.');
      queryVector = (await ollama.embed(config.embeddingModel, [query], signal))[0];
    }
    const terms = [...new Set(tokens(query))]; let ranked = this.rows(root).map((row, id) => {
      const content = row.text.toLowerCase(), file = row.path.toLowerCase();
      const lexical = terms.reduce((sum, term) => sum + (file.includes(term) ? 3 : 0) + (content.includes(term) ? 1 : 0), 0) / Math.max(1, terms.length);
      const vector = queryVector ? readVector(row.vector) : null;
      if (queryVector && vector?.length !== queryVector.length) throw fail('Embedding dimensions changed. Reindex the project.');
      return { ...row, id, lexical, similarity: vector ? cosine(queryVector, vector) : 0, score: 0 };
    });
    // Reciprocal-rank fusion avoids assuming lexical and cosine scores share a scale.
    const lexicalRank = [...ranked].filter(r => r.lexical > 0).sort((a,b) => b.lexical-a.lexical);
    lexicalRank.forEach((r,i) => { r.score += 1/(60+i); });
    if (queryVector) [...ranked].filter(r=>r.similarity>0).sort((a,b)=>b.similarity-a.similarity).forEach((r,i)=>{r.score+=1/(60+i);});
    ranked = ranked.filter(r=>r.score>0).sort((a,b)=>b.score-a.score);
    const selected = [], validFiles = new Map(); let budget = 14000, stale = 0;
    for (const row of ranked) {
      aborted(signal); if (selected.length >= config.rag.topK || budget <= 0) break;
      if (!validFiles.has(row.path)) {
        try { const current = await this.workspace.readFile(root, row.path, 512000, true); validFiles.set(row.path, current.sha === row.file_hash); } catch { validFiles.set(row.path, false); }
      }
      if (!validFiles.get(row.path)) { stale++; continue; }
      if (selected.some(x => x.path === row.path && row.start <= x.end && row.end >= x.start)) continue;
      if (row.text.length > budget) continue;
      selected.push({ path: row.path, start: row.start, end: row.end, text: row.text, score: row.score }); budget -= row.text.length;
      if (selected.length % 3 === 0) await tick();
    }
    if (stale) emit({ type: 'warning', message: 'Some RAG source files changed. Stale chunks were excluded; reindex to include current code.' });
    return selected;
  }
  async clear(root) {
    root = await this.workspace.root(root); if (this.busy.has(root)) throw fail('Cancel indexing before clearing it.');
    this.db.exec('BEGIN'); try { this.db.prepare('DELETE FROM chunks WHERE root=?').run(root); this.db.prepare('DELETE FROM projects WHERE root=?').run(root); this.db.exec('COMMIT'); this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch(e) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw e; }
    return this.status(root);
  }
  close() { this.db?.close(); }
}
module.exports = { RagIndex, chunksOf, tokens, cosine };
