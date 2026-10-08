'use strict';
const fs = require('node:fs/promises');
const constants = require('node:fs').constants;
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const { fail, text, within, atomicJSON, readJSON, hash, uid, tick, aborted, cleanEnvironment } = require('./util.cjs');
const exec = promisify(execFile);
const GENERATED = new Set(['.git','node_modules','.next','.nuxt','.cache','dist','build','target','vendor','__pycache__','.venv','venv','.idea','.vs','coverage']);
const TEXT_EXT = new Set(['.md','.mdx','.txt','.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.pyi','.c','.h','.cc','.cpp','.hpp','.rs','.go','.java','.kt','.cs','.json','.toml','.yaml','.yml','.xml','.html','.css','.scss','.sass','.sql','.sh','.bash','.zsh','.ps1','.bat','.cmake','.make','.s','.asm','.ini','.cfg','.conf','.proto','.vue','.svelte','.rb','.php','.swift','.r','.dart','.lua']);
function sensitive(relative) {
  return relative.split(/[\\/]/).some(p => /^\.env(?:\.|$)/i.test(p) || /^\.?(?:ssh|aws|azure|gnupg)$/i.test(p) || /^(?:credentials|secrets|id_rsa|id_ed25519|\.npmrc|\.pypirc|\.netrc)(?:\.|$)/i.test(p) || /\.(?:pem|pfx|p12|key|keystore)$/i.test(p));
}
function relativePath(value = '') {
  text(value, 'Project-relative path', 4000, true);
  if (path.isAbsolute(value) || /^[A-Za-z]:/.test(value) || /^[\\/]/.test(value)) throw fail('Use a path relative to the selected project.');
  const parts = value.replace(/\\/g, '/').split('/').filter(p => p && p !== '.');
  if (parts.some(p => p === '..' || /[:\x00-\x1f]/.test(p))) throw fail('Path traversal and special device paths are not allowed.');
  return parts.join('/');
}
function supportedText(relative) { const name = path.basename(relative); return TEXT_EXT.has(path.extname(name).toLowerCase()) || /^(?:README|LICENSE|Dockerfile|Makefile|CMakeLists.txt|\.gitignore|\.gitattributes)$/i.test(name); }
function parseStatus(raw) {
  const fields = raw.split('\0'); let branch = '', files = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]; if (!field) continue;
    if (field.startsWith('## ')) { branch = field.slice(3).split('...')[0].replace(/^(No commits yet on |Initial commit on )/, ''); continue; }
    const status = field.slice(0, 2), file = field.slice(3);
    const originalPath = /[RC]/.test(status) ? fields[++i] : undefined;
    files.push({ status, path: file, ...(originalPath ? { originalPath } : {}) });
  }
  return { branch: branch || 'HEAD', files };
}
class Workspace {
  constructor(dataDir) { this.storeFile = path.join(dataDir, 'projects.json'); this.queue = Promise.resolve(); }
  async listProjects() {
    const list = await readJSON(this.storeFile, []);
    if (!Array.isArray(list)) throw fail('Invalid project registry.');
    return list.filter(p => p && typeof p.path === 'string' && path.isAbsolute(p.path)).map(p => ({ ...p, name: typeof p.name === 'string' ? p.name : path.basename(p.path) }));
  }
  async addProject(selectedPath) {
    text(selectedPath, 'Folder', 4000); const root = await fs.realpath(selectedPath); if (!(await fs.stat(root)).isDirectory()) throw fail('Choose a directory.');
    const task = async () => {
      const all = await this.listProjects(); let project = all.find(p => p.path === root);
      if (!project) { project = { id: Buffer.from(root).toString('base64url'), name: path.basename(root) || root, path: root, addedAt: new Date().toISOString() }; all.unshift(project); }
      project.lastOpenedAt = new Date().toISOString(); await atomicJSON(this.storeFile, all); return project;
    };
    this.queue = this.queue.then(task, task); return this.queue;
  }
  async removeProject(root) {
    const task = async () => { const all = await this.listProjects(); if (!all.some(p => p.path === root)) throw fail('Project is not registered.'); await atomicJSON(this.storeFile, all.filter(p => p.path !== root)); return true; };
    this.queue = this.queue.then(task, task); return this.queue;
  }
  async root(registeredPath) {
    text(registeredPath, 'Project', 4000);
    if (!(await this.listProjects()).some(p => p.path === registeredPath)) throw fail('Open this project through June before accessing its files.', 'UNAUTHORIZED_PROJECT');
    const root = path.resolve(registeredPath), real = await fs.realpath(root);
    if (real !== root || !(await fs.stat(root)).isDirectory()) throw fail('The project root changed or is a link. Reopen it through the folder picker.');
    return root;
  }
  async resolve(registeredPath, relative = '', { allowMissing = false, agent = false } = {}) {
    const root = await this.root(registeredPath); const rel = relativePath(relative);
    if (agent && (sensitive(rel) || rel.split('/').includes('.git'))) throw fail('Credential files and Git internals are excluded from agent access.', 'SENSITIVE_PATH');
    const target = path.join(root, rel); if (!within(root, target)) throw fail('Path escapes the project.');
    let cursor = root; const parts = rel.split('/').filter(Boolean);
    for (let i = 0; i < parts.length; i++) {
      cursor = path.join(cursor, parts[i]);
      try {
        const st = await fs.lstat(cursor);
        if (st.isSymbolicLink()) throw fail('Symbolic links and junctions are not followed.', 'LINK_REJECTED');
        if (i < parts.length - 1 && !st.isDirectory()) throw fail('Parent path is not a directory.');
        if (st.isFile() && st.nlink > 1) throw fail('Hard-linked files are excluded.', 'LINK_REJECTED');
      } catch (e) { if (allowMissing && i === parts.length - 1 && e.code === 'ENOENT') return { root, target, relative: rel, exists: false }; throw e; }
    }
    const real = await fs.realpath(target); if (!within(root, real)) throw fail('Resolved path escapes the project.');
    return { root, target, relative: rel, exists: true };
  }
  async listDirectory(project, rel = '', options = {}) {
    const { target, root } = await this.resolve(project, rel, { agent: options.agent });
    const all = await fs.readdir(target, { withFileTypes: true });
    if (all.length > 6000) throw fail('This directory has more than 6,000 entries. Choose a narrower folder.');
    const filtered = all.filter(e => (options.showHidden || !e.name.startsWith('.')) && (options.excludeCommon === false || !GENERATED.has(e.name)) && (!options.agent || !sensitive(e.name)));
    filtered.sort((a,b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));
    const result = [];
    for (const e of filtered) {
      let st; try { st = await fs.lstat(path.join(target, e.name)); } catch { continue; }
      result.push({ name: e.name, path: path.relative(root, path.join(target, e.name)).split(path.sep).join('/'), type: st.isSymbolicLink() || (st.isFile() && st.nlink > 1) ? 'symlink' : st.isDirectory() ? 'directory' : st.isFile() ? 'file' : 'other', size: st.isFile() ? st.size : null, modifiedAt: st.mtime.toISOString() });
    }
    return result;
  }
  async readFile(project, rel, maxBytes = 2097152, agent = false) {
    const { target, relative } = await this.resolve(project, rel, { agent });
    const limit = Math.max(1024, Math.min(8388608, Number(maxBytes) || 2097152));
    const handle = await fs.open(target, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
    try {
      const st = await handle.stat(); if (!st.isFile() || st.nlink > 1) throw fail('Only regular, non-linked files can be read.');
      if (st.size > limit) return { path: relative, size: st.size, tooLarge: true, binary: false, content: '' };
      const buf = Buffer.alloc(limit + 1); let length = 0;
      while (length <= limit) { const r = await handle.read(buf, length, buf.length - length, length); if (!r.bytesRead) break; length += r.bytesRead; }
      if (length > limit) return { path: relative, size: length, tooLarge: true, binary: false, content: '' };
      const contentBytes = buf.subarray(0, length); let content = '', binary = contentBytes.includes(0);
      if (!binary) try { content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(contentBytes); } catch { binary = true; }
      return { path: relative, size: length, tooLarge: false, binary, content, sha: hash(contentBytes) };
    } finally { await handle.close(); }
  }
  async walk(project, { maxFiles = 1500, maxVisits = 30000, signal, textOnly = false, showHidden = true, excludeCommon = true } = {}) {
    const root = await this.root(project); const files = []; let visited = 0, skipped = 0, truncated = false;
    // git ls-files honors repository ignore rules without running hooks or a shell.
    let gitFiles;
    try { const r = await exec('git', ['--no-optional-locks','-c','core.fsmonitor=false','-C',root,'ls-files','-co','--exclude-standard','-z','--','.'], { timeout: 8000, maxBuffer: 4000000, windowsHide: true, env: cleanEnvironment(), shell: false }); gitFiles = [...new Set(r.stdout.split('\0').filter(Boolean))]; } catch { /* Non-Git fallback below. */ }
    const accept = rel => {
      const parts = rel.split('/');
      return !sensitive(rel) && !parts.includes('.git') && (showHidden || !parts.some(p => p.startsWith('.'))) && (!excludeCommon || !parts.some(p => GENERATED.has(p))) && (!textOnly || supportedText(rel)) && (!textOnly || !/(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock)$/.test(rel));
    };
    if (gitFiles) {
      for (const raw of gitFiles) {
        aborted(signal); if (++visited > maxVisits || files.length >= maxFiles) { truncated = true; break; }
        let rel; try { rel = relativePath(raw); if (!accept(rel)) continue; const p = await this.resolve(project, rel, { agent: true }); if (!(await fs.lstat(p.target)).isFile()) continue; files.push(rel); } catch { skipped++; }
        if (visited % 50 === 0) await tick();
      }
      return { files: files.sort(), truncated, skipped, visited, respectsGitignore: true };
    }
    const queue = [''];
    while (queue.length && !truncated) {
      aborted(signal); const rel = queue.shift(); let directory;
      try { const p = await this.resolve(project, rel, { agent: true }); directory = await fs.opendir(p.target); } catch { skipped++; continue; }
      for await (const e of directory) {
        aborted(signal); if (++visited > maxVisits || files.length >= maxFiles) { truncated = true; break; }
        const child = rel ? rel + '/' + e.name : e.name;
        if (e.isSymbolicLink() || sensitive(child) || e.name === '.git' || (excludeCommon && GENERATED.has(e.name)) || (!showHidden && e.name.startsWith('.'))) continue;
        if (e.isDirectory()) { if (child.split('/').length < 24) queue.push(child); else { skipped++; truncated = true; break; } }
        else if (e.isFile() && accept(child)) files.push(child);
        if (visited % 50 === 0) await tick();
      }
    }
    return { files: files.sort(), truncated, skipped, visited, respectsGitignore: false };
  }
  async search(project, query, { content = false, maxResults = 60, signal, showHidden = true, excludeCommon = true } = {}) {
    text(query, 'Search query', 500); const needle = query.toLowerCase();
    const scan = await this.walk(project, { maxFiles: 3000, signal, textOnly: content, showHidden, excludeCommon }); const results = [];
    if (!content) {
      const directories = new Set();
      for (const file of scan.files) { const parts = file.split('/');for (let i = 1; i < parts.length; i++) directories.add(parts.slice(0,i).join('/')); }
      for (const dir of [...directories].sort()) { if (results.length >= maxResults) break;if (dir.toLowerCase().includes(needle)) results.push({ name: path.basename(dir), path: dir, type: 'directory' }); }
    }
    for (const rel of scan.files) {
      aborted(signal); if (results.length >= maxResults) break;
      if (rel.toLowerCase().includes(needle)) { results.push({ name: path.basename(rel), path: rel, type: 'file' }); continue; }
      if (!content) continue;
      try { const file = await this.readFile(project, rel, 256000, true); if (file.tooLarge || file.binary) continue; const rows = file.content.split('\n'); for (let i=0;i<rows.length && results.length<maxResults;i++) if (rows[i].toLowerCase().includes(needle)) results.push({ name: path.basename(rel), path: rel, type: 'file', line: i+1, text: rows[i].slice(0,400) }); } catch { /* A file can disappear during a search. */ }
    }
    return { results, truncated: scan.truncated || results.length >= maxResults };
  }
  async gitStatus(project) {
    const root = await this.root(project);
    try { const { stdout } = await exec('git', ['--no-optional-locks','-c','core.fsmonitor=false','-C',root,'status','--porcelain=v1','--branch','-z','--untracked-files=normal'], { timeout: 8000, maxBuffer: 2000000, windowsHide: true, shell: false, env: cleanEnvironment() }); const r = parseStatus(stdout); return { available: true, ...r, dirty: r.files.length > 0 }; }
    catch (e) { return { available: false, branch: '', files: [], dirty: false, error: e.code === 'ENOENT' ? 'Git is not installed or not on PATH.' : 'Git status is unavailable for this folder.' }; }
  }
  async prepareWrite(project, args) {
    text(args.path, 'File path', 4000); text(args.content, 'New content', 256000, true); text(args.expectedSha, 'Expected file SHA (or new)', 64);
    const p = await this.resolve(project, args.path, { allowMissing: true, agent: true });
    if (!p.relative) throw fail('Choose a file, not the project root.');
    const old = p.exists ? await this.readFile(project, args.path, 256000, true) : { content: '', sha: 'new' };
    if (old.binary || old.tooLarge) throw fail('Only small UTF-8 text files can be edited.');
    if (old.sha !== args.expectedSha) throw fail('The file has changed. Read it again before proposing an edit.', 'FILE_CONFLICT');
    return { path: p.relative, content: args.content, expectedSha: old.sha, before: old.content, isNew: !p.exists };
  }
  async commitWrite(project, proposal) {
    const checked = await this.prepareWrite(project, proposal);
    const p = await this.resolve(project, checked.path, { allowMissing: true, agent: true });
    if (checked.isNew) { await fs.writeFile(p.target, checked.content, { encoding: 'utf8', flag: 'wx', mode: 0o644 }); }
    else {
      const tmp = path.join(path.dirname(p.target), '.june-edit-' + uid()); const st = await fs.stat(p.target);
      try {
        await fs.writeFile(tmp, checked.content, { encoding: 'utf8', flag: 'wx', mode: st.mode & 0o777 });
        // Recheck after approval and immediately before the atomic replacement.
        await this.prepareWrite(project, proposal); await fs.rename(tmp, p.target);
      } finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
    }
    return { written: checked.path, sha: hash(Buffer.from(checked.content)), bytes: Buffer.byteLength(checked.content) };
  }
}
async function runCommand(workspace, project, args, signal) {
  text(args.executable, 'Executable', 2000);
  if (/\.(?:cmd|bat)$/i.test(args.executable)) throw fail('Use a real executable, not a .cmd/.bat wrapper.');
  if (!Array.isArray(args.args) || args.args.length > 80) throw fail('Arguments must be an array of strings.');
  args.args.forEach(a => text(a, 'Argument', 8000, true));
  const { target: cwd } = await workspace.resolve(project, args.cwd || '', { agent: true });
  if (!(await fs.stat(cwd)).isDirectory()) throw fail('Command working directory must be a directory.');
  aborted(signal);
  return new Promise((resolve, reject) => {
    const child = spawn(args.executable, args.args, { cwd, shell: false, windowsHide: true, detached: process.platform !== 'win32', env: cleanEnvironment(), stdio: ['ignore','pipe','pipe'] });
    let stdout = '', stderr = '', bytes = 0, limited = false, timedOut = false;
    const kill = () => {
      if (!child.pid) return;
      if (process.platform === 'win32') execFile('taskkill.exe', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, shell: false }, () => {});
      else try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
    };
    const timer = setTimeout(() => { timedOut = true; kill(); }, 60000);
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    signal?.addEventListener('abort', kill, { once: true }); if (signal?.aborted) kill();
    const consume = (stream, key) => { stream.setEncoding('utf8'); stream.on('data', s => { bytes += Buffer.byteLength(s); if (bytes > 96000) { limited = true; kill(); return; } if (key === 'stdout') stdout += s; else stderr += s; }); };
    consume(child.stdout, 'stdout'); consume(child.stderr, 'stderr');
    child.once('error', e => { cleanup(); reject(fail(`Could not launch command: ${e.code || 'process error'}.`)); });
    child.once('close', code => { cleanup(); if (signal?.aborted) reject(signal.reason); else resolve({ code, stdout, stderr, truncated: limited, timedOut }); });
  });
}
module.exports = { Workspace, relativePath, sensitive, supportedText, parseStatus, runCommand, GENERATED };
