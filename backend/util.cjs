'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');

function fail(message, code = 'INVALID_INPUT') { const e = new Error(message); e.code = code; return e; }
function text(value, name = 'Text', max = 100000, allowEmpty = false) {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || Buffer.byteLength(value) > max || value.includes('\0')) throw fail(`${name} is missing or exceeds its size limit.`);
  return value;
}
function integer(value, min, max, name) {
  if (!Number.isInteger(value) || value < min || value > max) throw fail(`${name} must be an integer between ${min} and ${max}.`);
  return value;
}
function object(value, name = 'Object') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(`${name} must be an object.`);
  return value;
}
function within(root, target) { const rel = path.relative(root, target); return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); }
const hash = data => crypto.createHash('sha256').update(data).digest('hex');
const uid = () => crypto.randomUUID();
const tick = () => new Promise(resolve => setImmediate(resolve));
const aborted = signal => { if (signal?.aborted) throw signal.reason || fail('Cancelled.', 'CANCELLED'); };
function endpoint(raw, { allowRemote = false, name = 'Endpoint' } = {}) {
  text(raw, name, 2000);
  let u; try { u = new URL(raw); } catch { throw fail(`${name} must be a valid URL.`); }
  if (!['http:', 'https:'].includes(u.protocol) || u.username || u.password || u.hash || u.search) throw fail(`${name} must use HTTP(S) without credentials, a query, or a fragment.`);
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname);
  if (!loopback && (!allowRemote || u.protocol !== 'https:')) throw fail(`${name}: remote connections require HTTPS and explicit permission.`);
  return u;
}
async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + uid() + '.tmp';
  try { await fs.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600, flag: 'wx' }); await fs.rename(tmp, file); }
  finally { await fs.rm(tmp, { force: true }).catch(() => {}); }
}
async function readJSON(file, fallback, maxBytes = 1000000) {
  try { const st = await fs.stat(file); if (st.size > maxBytes) throw fail('Saved settings are too large.'); return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return structuredClone(fallback); throw e; }
}
async function responseText(response, max = 2000000) {
  if (!response.body) return '';
  const reader = response.body.getReader(); let size = 0; const chunks = [];
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > max) throw fail('Remote response exceeded the limit.', 'RESPONSE_LIMIT'); chunks.push(Buffer.from(value)); } }
  finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}
// A UTF-8 streaming parser: byte boundaries need not coincide with characters or lines.
async function* lines(body, signal, maxLine = 1024 * 1024) {
  if (!body) throw fail('The server returned no response body.', 'EMPTY_RESPONSE');
  const reader = body.getReader(); const decoder = new TextDecoder(); let pending = '';
  try {
    for (;;) {
      aborted(signal); const { done, value } = await reader.read();
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      let nl;
      while ((nl = pending.indexOf('\n')) !== -1) { const line = pending.slice(0, nl).replace(/\r$/, ''); pending = pending.slice(nl + 1); if (Buffer.byteLength(line) > maxLine) throw fail('Stream line exceeded limit.'); yield line; }
      if (Buffer.byteLength(pending) > maxLine) throw fail('Stream line exceeded limit.');
      if (done) { if (pending) yield pending.replace(/\r$/, ''); break; }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
function cleanEnvironment(extraNames = []) {
  const names = ['PATH', 'Path', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'LANG'];
  const env = {};
  for (const name of [...names, ...extraNames]) if (typeof process.env[name] === 'string') env[name] = process.env[name];
  // Do not leak NODE_OPTIONS, API keys, or Electron process flags implicitly.
  return env;
}
module.exports = { fail, text, integer, object, within, hash, uid, tick, aborted, endpoint, atomicJSON, readJSON, responseText, lines, cleanEnvironment };
