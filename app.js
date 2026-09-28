/* June renderer. Native capabilities remain behind the existing preload bridge. */
const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const desktop = window.juneDesktop || null;
document.documentElement.dataset.runtime = desktop?.isDesktop ? 'desktop' : 'web';

// A single, local SVG vocabulary. No icon fonts, CDN, or arbitrary SVG input.
const paths = {
  plus: '<path d="M12 5v14M5 12h14"/>',
  minus: '<path d="M4 12h16"/>',
  maximize: '<rect x="4" y="4" width="16" height="16"/>',
  restore: '<path d="M8 4h12v12M4 8h12v12H4z"/>',
  x: '<path d="m6 6 12 12M18 6 6 18"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  folder: '<path d="M3 7V5h6l2 2h10v12H3z"/>',
  'folder-plus': '<path d="M3 7V5h6l2 2h10v12H3zM12 10v6M9 13h6"/>',
  file: '<path d="M14 3H5v18h14V8zM14 3v5h5"/>',
  chat: '<path d="M21 14a3 3 0 0 1-3 3H8l-5 4V6a3 3 0 0 1 3-3h12a3 3 0 0 1 3 3z"/>',
  'chevron-down': '<path d="m6 9 6 6 6-6"/>',
  'chevron-right': '<path d="m9 6 6 6-6 6"/>',
  'arrow-up': '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  'arrow-right': '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  branch: '<path d="M6 6v12m0-6h6a6 6 0 0 0 6-6"/><circle cx="6" cy="4" r="2"/><circle cx="6" cy="20" r="2"/><circle cx="18" cy="4" r="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M6 7a7 7 0 0 1 11-2l3 3M4 16l3 3a7 7 0 0 0 11-2"/>',
  external: '<path d="M14 3h7v7m0-7-10 10M10 3H3v18h18v-7"/>',
  settings: '<path d="m9 3-1 3-3 1-2 4 2 2v3l4 3 3-1 3 1 4-3v-3l2-2-2-4-3-1-1-3z"/><circle cx="12" cy="12" r="3"/>',
  sliders: '<path d="M4 6h6m4 0h6M4 12h10m4 0h2M4 18h2m4 0h10"/><circle cx="12" cy="6" r="2"/><circle cx="16" cy="12" r="2"/><circle cx="8" cy="18" r="2"/>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v4a6 6 0 0 1-12 0zm6 10v3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  edit: '<path d="m15 4 5 5-11 11H4v-5zm-2 2 5 5"/>',
  trash: '<path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/>',
  check: '<path d="m5 12 4 4L19 6"/>'
};
function icon(name) {
  const node = document.createElement('span');
  node.className = 'icon';
  node.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${paths[name] || paths.file}</svg>`;
  return node;
}
$$('[data-icon]').forEach(node => node.replaceWith(icon(node.dataset.icon)));
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { $('#toast').hidden = true; }, 4500);
}
function readJSON(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function store(key, value) {
  try { localStorage.setItem(key, typeof value === 'string' ? value : JSON.stringify(value)); return true; }
  catch { toast('Device storage is full or unavailable. Your latest changes could not be saved.'); return false; }
}
const defaults = {
  theme: 'dark', density: 'comfortable', rememberProject: true, showHidden: false,
  excludeCommon: true, previewLimit: 2097152, backendUrl: 'http://127.0.0.1:8765',
  agentMode: 'agent', defaultModel: '', contextBudget: 32768,
  requireApproval: true, allowTerminal: false, allowNetwork: false
};
const enums = { theme: ['dark', 'midnight', 'light'], density: ['comfortable', 'compact'], agentMode: ['agent', 'ask', 'plan'], previewLimit: [524288, 1048576, 2097152, 4194304] };
function validSetting(key, value) {
  if (key in enums) return enums[key].includes(value);
  if (typeof defaults[key] === 'boolean') return typeof value === 'boolean';
  if (key === 'contextBudget') return Number.isInteger(value) && value >= 1024 && value <= 2097152;
  if (key === 'backendUrl') {
    if (!value) return true;
    try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash; } catch { return false; }
  }
  return typeof value === 'string' && value.length <= 500;
}
const savedSettings = readJSON('june.settings', {});
const settings = { ...defaults };
for (const key of Object.keys(defaults)) if (validSetting(key, savedSettings?.[key])) settings[key] = savedSettings[key];
const savedChats = readJSON('june.chats', []);
const chats = (Array.isArray(savedChats) ? savedChats : []).filter(chat => chat && typeof chat.id === 'string').map(chat => ({
  ...chat, title: typeof chat.title === 'string' ? chat.title : 'Untitled chat',
  projectPath: typeof chat.projectPath === 'string' ? chat.projectPath : '',
  messages: (Array.isArray(chat.messages) ? chat.messages : []).filter(message => message && typeof message.content === 'string' && ['user', 'assistant', 'system'].includes(message.role))
}));
const loadedDrafts = readJSON('june.drafts', {});
const state = {
  settings, chats, projects: [], project: null, activeChatId: '', file: '', inspector: '',
  drafts: loadedDrafts && typeof loadedDrafts === 'object' && !Array.isArray(loadedDrafts) ? loadedDrafts : {},
  epoch: 0, fileSeq: 0, treeSeq: 0, gitSeq: 0, searchSeq: 0, healthSeq: 0,
  expanded: new Set(), searchIndex: -1, searchActions: [],
  collapsed: readJSON('june.sidebarCollapsed', 0) === 1,
  chatsExpanded: readJSON('june.chatsExpanded', true) !== false
};
const composer = $('#composerInput');
const rootPath = () => state.project?.path || '';
const currentChat = () => state.chats.find(chat => chat.id === state.activeChatId && chat.projectPath === rootPath());
const projectChats = () => state.chats.filter(chat => chat.projectPath === rootPath()).sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
const draftKey = () => state.activeChatId || `new:${rootPath()}`;
const basename = path => String(path).split(/[\\/]/).filter(Boolean).pop() || path;
function bytes(size) { return size < 1024 ? `${size} B` : size < 1048576 ? `${(size / 1024).toFixed(1)} KB` : `${(size / 1048576).toFixed(1)} MB`; }
const live = epoch => epoch === state.epoch;
async function native(name, ...args) {
  if (typeof desktop?.[name] !== 'function') throw new Error('Open June in the desktop app to use local workspace features.');
  return desktop[name](...args);
}
function saveDraft() {
  state.drafts[draftKey()] = composer.value;
  return store('june.drafts', state.drafts);
}
function sizeComposer() {
  composer.style.height = 'auto';
  composer.style.height = Math.min(180, Math.max(82, composer.scrollHeight)) + 'px';
  $('#sendBtn').disabled = !composer.value.trim();
}
function restoreDraft() { composer.value = typeof state.drafts[draftKey()] === 'string' ? state.drafts[draftKey()] : ''; sizeComposer(); }
function saveChats() { return store('june.chats', state.chats); }
function hideProjectMenu(returnFocus = false) {
  $('#projectMenu').hidden = true;
  $('#projectButton').setAttribute('aria-expanded', 'false');
  if (returnFocus) $('#projectButton').focus();
}
function syncSidebar() {
  const mobile = matchMedia('(max-width: 760px)').matches;
  const visible = mobile ? $('#appShell').classList.contains('mobile-nav') : !state.collapsed;
  $('#appShell').classList.toggle('is-collapsed', !mobile && state.collapsed);
  $('#sidebar').inert = !visible;
  $('#sidebarToggle').setAttribute('aria-expanded', String(visible));
  $('#sidebarScrim').hidden = !(mobile && visible);
}
function closeMobileSidebar() { $('#appShell').classList.remove('mobile-nav'); syncSidebar(); }
function toggleSidebar() {
  hideProjectMenu();
  if (matchMedia('(max-width: 760px)').matches) $('#appShell').classList.toggle('mobile-nav');
  else { state.collapsed = !state.collapsed; store('june.sidebarCollapsed', state.collapsed ? '1' : '0'); }
  syncSidebar();
  const target = $('#sidebar').inert ? $('#sidebarToggle') : $('#projectButton');
  target.focus();
}
function renderProjectMenu() {
  const list = $('#projectList');
  list.replaceChildren();
  if (!state.projects.length) list.append(el('p', 'chat-empty', 'No projects yet. Open a folder below.'));
  for (const project of state.projects) {
    const button = el('button', 'project-entry');
    button.setAttribute('aria-current', String(project.path === rootPath()));
    const label = el('div');
    label.append(el('strong', '', project.name), el('small', '', project.path));
    button.append(icon('folder'), label);
    if (project.path === rootPath()) button.append(icon('check'));
    button.addEventListener('click', () => switchProject(project));
    list.append(button);
  }
}
function renderChats() {
  const list = $('#chatList');
  list.hidden = !state.chatsExpanded;
  $('#chatsToggle').setAttribute('aria-expanded', String(state.chatsExpanded));
  list.replaceChildren();
  const visible = projectChats();
  if (!visible.length) list.append(el('p', 'chat-empty', 'Your conversations will appear here.'));
  for (const chat of visible) {
    const button = el('button', 'chat-item');
    button.setAttribute('aria-current', String(chat.id === state.activeChatId));
    button.title = chat.title;
    button.append(icon('chat'), el('span', 'chat-label', chat.title));
    button.addEventListener('click', () => selectChat(chat.id));
    list.append(button);
  }
}
function renderConversation() {
  const chat = currentChat();
  const empty = !chat?.messages.length;
  $('#chatTitle').textContent = chat?.title || 'New chat';
  document.title = chat ? `${chat.title} - June` : 'June';
  $('#chatOptionsBtn').hidden = !chat;
  $('#conversation').dataset.empty = String(empty);
  $('#welcome').hidden = !empty;
  $('#chatHistory').hidden = empty;
  $('#welcomeText').textContent = state.project ? 'Explore your files, then start a conversation.' : 'Open a project to get started, or capture an idea below.';
  const action = $('#welcomeAction');
  action.dataset.action = state.project ? 'files' : 'add-project';
  action.replaceChildren(icon(state.project ? 'folder' : 'folder-plus'), el('span', '', state.project ? 'Browse project files' : 'Open a project'));
  const history = $('#chatHistory');
  history.replaceChildren();
  for (const message of chat?.messages || []) {
    const article = el('article', 'message');
    article.append(el('div', 'message-role', message.role === 'user' ? 'You' : message.role === 'assistant' ? 'June' : 'Note'), el('div', 'message-body', message.content));
    if (message.role === 'user') article.append(el('div', 'message-footnote', 'Saved on this device'));
    history.append(article);
  }
  history.scrollTop = history.scrollHeight;
}
function showChat() {
  state.fileSeq++;
  state.file = '';
  $('#filePreview').hidden = true;
  $('#conversation').hidden = false;
  $$('.tree-row').forEach(row => row.removeAttribute('aria-current'));
  requestAnimationFrame(sizeComposer);
}
function selectChat(id = '') {
  saveDraft();
  state.activeChatId = state.chats.some(chat => chat.id === id && chat.projectPath === rootPath()) ? id : '';
  store('june.activeChatId', state.activeChatId);
  showChat(); renderChats(); renderConversation(); restoreDraft(); closeMobileSidebar();
  composer.focus();
}
function switchProject(project, preferredChat = '') {
  saveDraft(); hideProjectMenu();
  state.epoch++; state.searchSeq++; state.treeSeq++; state.gitSeq++;
  state.project = project;
  state.expanded.clear();
  const visible = projectChats();
  state.activeChatId = visible.find(chat => chat.id === preferredChat)?.id || visible[0]?.id || '';
  store('june.activeChatId', state.activeChatId);
  if (state.settings.rememberProject) store('june.lastProjectPath', rootPath());
  $('#projectName').textContent = project?.name || 'Select project';
  $('#projectButton').title = project?.path || 'Open or switch a project';
  $('#removeCurrentProjectBtn').disabled = !project;
  showChat(); renderProjectMenu(); renderChats(); renderConversation(); restoreDraft(); closeMobileSidebar();
  // Invalidate old project surfaces before any replacement data arrives.
  $('#fileTree').replaceChildren(); $('#changesList').replaceChildren();
  if (state.inspector) openInspector(state.inspector);
}
async function addProject() {
  const button = $('#welcomeAction');
  button.disabled = true;
  try {
    const project = await native('selectProjectDirectory');
    if (!project) return;
    if (!state.projects.some(item => item.path === project.path)) state.projects.unshift(project);
    switchProject(project);
  } finally { button.disabled = false; }
}
function emptyState(container, message, withProjectAction = false) {
  const node = el('div', 'empty-state', message);
  if (withProjectAction) { const button = el('button', 'secondary-button', 'Open a project'); button.dataset.action = 'add-project'; node.append(button); }
  container.replaceChildren(node);
}
function openInspector(panel, load = true) {
  state.inspector = panel;
  $('#inspector').hidden = false;
  $('#workspaceBody').classList.add('has-inspector');
  for (const name of ['files', 'changes']) {
    const selected = name === panel;
    $(`#${name}Button`).setAttribute('aria-pressed', String(selected));
    $(`#${name}Tab`).setAttribute('aria-selected', String(selected));
    $(`#${name}Tab`).tabIndex = selected ? 0 : -1;
    $(`#${name}Panel`).hidden = !selected;
  }
  if (load) void (panel === 'files' ? renderFiles() : renderChanges());
}
function toggleInspector(panel) { if (state.inspector === panel) closeInspector(); else openInspector(panel); }
function closeInspector() {
  const previous = state.inspector;
  state.inspector = '';
  $('#inspector').hidden = true;
  $('#workspaceBody').classList.remove('has-inspector');
  for (const name of ['files', 'changes']) $(`#${name}Button`).setAttribute('aria-pressed', 'false');
  if (previous) $(`#${previous}Button`).focus();
}
const browseOptions = () => ({ showHidden: state.settings.showHidden, excludeCommon: state.settings.excludeCommon });
async function renderFiles() {
  const container = $('#fileTree');
  const epoch = state.epoch, seq = ++state.treeSeq, project = rootPath();
  $('#filesProjectName').textContent = state.project?.name || 'No project selected';
  $('#filesProjectName').title = project;
  $('#revealProjectBtn').disabled = $('#refreshFilesBtn').disabled = !project;
  if (!project) { emptyState(container, 'Open a project to browse its files.', true); return; }
  container.replaceChildren(el('p', 'tree-notice', 'Loading files...'));
  const fresh = () => live(epoch) && seq === state.treeSeq;
  try {
    const entries = await native('listDirectory', project, '', browseOptions());
    if (!fresh()) return;
    container.replaceChildren();
    if (!entries.length) container.append(el('p', 'tree-notice', 'No visible files. Check Workspace settings for hidden folders.'));
    for (const entry of entries) container.append(treeEntry(entry, project, fresh));
  } catch (error) { if (fresh()) emptyState(container, `Could not read this folder. ${error.message}`); }
}
function treeEntry(entry, project, fresh) {
  if (entry.type !== 'directory') {
    const row = el('button', 'tree-row');
    row.dataset.path = entry.path;
    row.title = entry.path;
    row.append(icon('file'), el('span', 'file-name', entry.name), el('span', 'file-meta', entry.type === 'file' ? bytes(entry.size || 0) : entry.type));
    row.disabled = entry.type !== 'file';
    if (entry.path === state.file) row.setAttribute('aria-current', 'true');
    row.addEventListener('click', () => { if (fresh()) void openFile(entry.path); });
    return row;
  }
  const folder = el('details', 'folder');
  folder.dataset.path = entry.path;
  const summary = el('summary');
  summary.append(icon('chevron-right'), icon('folder'), el('span', 'file-name', entry.name));
  const children = el('div', 'folder-children');
  folder.append(summary, children);
  let loading = null;
  folder.loadChildren = () => {
    if (loading) return loading;
    children.replaceChildren(el('p', 'tree-notice', 'Loading...'));
    loading = native('listDirectory', project, entry.path, browseOptions()).then(entries => {
      if (!fresh() || !folder.isConnected) return;
      children.replaceChildren();
      for (const item of entries) children.append(treeEntry(item, project, fresh));
      if (!entries.length) children.append(el('p', 'tree-notice', 'Empty folder'));
    }).catch(error => { loading = null; if (fresh()) children.replaceChildren(el('p', 'tree-notice', error.message)); });
    return loading;
  };
  folder.addEventListener('toggle', () => {
    if (!fresh()) return;
    if (folder.open) { state.expanded.add(entry.path); void folder.loadChildren(); }
    else state.expanded.delete(entry.path);
  });
  folder.open = state.expanded.has(entry.path);
  return folder;
}
async function revealDirectory(path) {
  openInspector('files', false);
  // Wait for this render explicitly; older concurrent renders are invalidated.
  await renderFiles();
  const epoch = state.epoch;
  let prefix = '';
  for (const part of path.split('/').filter(Boolean)) {
    if (!live(epoch)) return;
    prefix = prefix ? `${prefix}/${part}` : part;
    const folder = $$('.folder').find(node => node.dataset.path === prefix);
    if (!folder) return;
    folder.open = true;
    await folder.loadChildren();
    if (prefix === path) { folder.querySelector('summary').focus(); folder.scrollIntoView({ block: 'nearest' }); }
  }
}
async function openFile(path) {
  const epoch = state.epoch, seq = ++state.fileSeq, project = rootPath();
  if (!project) return;
  saveDraft();
  state.file = path;
  $('#conversation').hidden = true;
  $('#filePreview').hidden = false;
  $('#filePreviewName').textContent = basename(path);
  $('#filePreviewPath').textContent = path;
  $('#filePreviewMeta').textContent = 'Reading...';
  $('#filePreviewCode code').textContent = '';
  $('#filePreviewCode').hidden = false;
  $('#filePreviewNotice').hidden = true;
  $('#revealFileBtn').disabled = false;
  $$('.tree-row').forEach(row => row.setAttribute('aria-current', String(row.dataset.path === path)));
  const fresh = () => live(epoch) && seq === state.fileSeq;
  try {
    const file = await native('readTextFile', project, path, state.settings.previewLimit);
    if (!fresh()) return;
    $('#filePreviewMeta').textContent = `${bytes(file.size)} / Read-only`;
    if (file.binary || file.tooLarge) {
      $('#filePreviewCode').hidden = true;
      $('#filePreviewNotice').hidden = false;
      $('#filePreviewNotice').textContent = file.binary ? 'This binary file cannot be previewed as text. Use Reveal to locate it.' : `This file exceeds your ${bytes(state.settings.previewLimit)} preview limit. Change the limit in Workspace settings.`;
    } else $('#filePreviewCode code').textContent = file.content;
  } catch (error) {
    if (!fresh()) return;
    $('#filePreviewMeta').textContent = '';
    $('#filePreviewCode').hidden = true;
    $('#filePreviewNotice').hidden = false;
    $('#filePreviewNotice').textContent = `Could not open this file. ${error.message}`;
  }
}
async function renderChanges() {
  const epoch = state.epoch, seq = ++state.gitSeq, project = rootPath(), list = $('#changesList');
  $('#changesSummary').textContent = '';
  $('#refreshChangesBtn').disabled = !project;
  $('#branchSummary').textContent = project ? 'Checking Git...' : 'No project selected';
  if (!project) { emptyState(list, 'Open a project to see its Git changes.', true); return; }
  list.replaceChildren(el('p', 'tree-notice', 'Loading changes...'));
  const fresh = () => live(epoch) && seq === state.gitSeq;
  try {
    const result = await native('getGitStatus', project);
    if (!fresh()) return;
    if (!result.available) {
      $('#branchSummary').textContent = 'Git unavailable';
      emptyState(list, result.error || 'Git status could not be read.'); return;
    }
    $('#branchSummary').textContent = result.branch || 'HEAD';
    $('#changesSummary').textContent = `${result.files.length} changed ${result.files.length === 1 ? 'file' : 'files'}`;
    list.replaceChildren();
    if (!result.files.length) emptyState(list, 'Your working tree is clean.');
    for (const change of result.files) {
      const button = el('button', 'git-change');
      const label = el('div'); label.append(el('strong', '', basename(change.path)), el('small', '', change.path));
      button.append(el('span', 'git-status', change.status.trim() || '?'), label);
      // A deletion or untracked folder has no current text file to preview.
      button.disabled = change.status.includes('D') || change.path.endsWith('/');
      button.title = button.disabled ? 'No current file to preview' : 'Preview current file (not a diff)';
      button.addEventListener('click', () => { if (fresh()) void openFile(change.path); });
      list.append(button);
    }
  } catch (error) { if (fresh()) { $('#branchSummary').textContent = 'Git unavailable'; emptyState(list, error.message); } }
}
function showDialog(id) {
  hideProjectMenu(); closeMobileSidebar();
  const dialog = $('#' + id);
  if (!dialog.open) dialog.showModal();
}
function openSettings(tab = 'general') {
  syncSettings(); selectSettingsTab(tab); showDialog('settingsModal');
}
function selectSettingsTab(name) {
  $$('[data-settings]').forEach(tab => {
    const active = tab.dataset.settings === name;
    tab.setAttribute('aria-selected', String(active)); tab.tabIndex = active ? 0 : -1;
    $('#' + tab.getAttribute('aria-controls')).hidden = !active;
  });
}
function syncSettings() {
  $$('[data-setting]').forEach(input => {
    const value = state.settings[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = value; else input.value = value;
  });
}
function applyAppearance() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.density = state.settings.density;
}
function resetHealth() { state.healthSeq++; $('#backendTestResult').textContent = 'Not tested.'; $('#backendTestResult').dataset.status = ''; $('#testBackendBtn').disabled = false; }
async function testBackend() {
  const input = $('#settingBackendUrl');
  if (!validSetting('backendUrl', input.value.trim()) || !input.value.trim()) { input.setCustomValidity('Enter an HTTP or HTTPS base URL without credentials, query, or fragment.'); input.reportValidity(); return; }
  input.setCustomValidity('');
  const url = input.value.trim(), seq = ++state.healthSeq;
  $('#testBackendBtn').disabled = true;
  $('#backendTestResult').textContent = 'Testing...';
  try {
    const result = await native('checkBackend', url);
    if (seq !== state.healthSeq) return;
    $('#backendTestResult').textContent = result.ok ? 'Server reachable. Agent integration is still pending.' : (result.message || 'Server unavailable.');
    $('#backendTestResult').dataset.status = result.ok ? 'ok' : 'error';
  } catch (error) { if (seq === state.healthSeq) { $('#backendTestResult').textContent = error.message; $('#backendTestResult').dataset.status = 'error'; } }
  finally { if (seq === state.healthSeq) $('#testBackendBtn').disabled = false; }
}
function ask(title, message, initial, confirmLabel) {
  return new Promise(resolve => {
    const dialog = $('#actionDialog'), input = $('#actionInput');
    $('#actionTitle').textContent = title; $('#actionMessage').textContent = message;
    $('#actionInputLabel').hidden = initial === undefined;
    input.required = initial !== undefined; input.value = initial || '';
    $('#actionConfirm').textContent = confirmLabel;
    dialog.returnValue = '';
    dialog.addEventListener('close', () => resolve(dialog.returnValue === 'confirm' ? (initial === undefined ? true : input.value.trim()) : null), { once: true });
    showDialog('actionDialog');
    if (initial !== undefined) { input.focus(); input.select(); }
  });
}
async function editChat(remove) {
  const chat = currentChat();
  if (!chat) return;
  $('#chatOptions').close();
  const answer = await ask(remove ? 'Delete chat?' : 'Rename chat', remove ? 'This removes this conversation from June on this device. Project files are not affected.' : 'Give this conversation a useful name.', remove ? undefined : chat.title, remove ? 'Delete chat' : 'Save name');
  if (!answer) return;
  const previous = state.chats;
  state.chats = remove ? state.chats.filter(item => item.id !== chat.id) : state.chats.map(item => item.id === chat.id ? { ...item, title: answer } : item);
  if (!saveChats()) { state.chats = previous; return; }
  if (remove) { delete state.drafts[chat.id]; store('june.drafts', state.drafts); state.activeChatId = ''; }
  store('june.activeChatId', state.activeChatId);
  renderChats(); renderConversation(); restoreDraft();
}
async function removeProject() {
  const project = state.project;
  if (!project) return;
  const answer = await ask('Remove project?', `Remove ${project.name} from June? Files and saved chats are kept. Reopen the folder to see its chats again.`, undefined, 'Remove project');
  if (!answer) return;
  await native('removeProject', project.path);
  state.projects = state.projects.filter(item => item.path !== project.path);
  if (state.project?.path === project.path) switchProject(null);
  renderProjectMenu();
}
function paletteCommands(query = '') {
  return [
    ['plus', 'New chat', 'Start a conversation', () => selectChat()],
    ['folder-plus', 'Open project', 'Choose a local folder', addProject],
    ['folder', 'Browse files', 'Open the file browser', () => openInspector('files')],
    ['branch', 'View changes', 'Inspect Git status', () => openInspector('changes')],
    ['settings', 'Settings', 'Appearance, workspace, and backend', () => openSettings()]
  ].filter(item => item[1].toLowerCase().includes(query));
}
function renderSearchResults(results, caption) {
  $('#searchScope').textContent = caption;
  state.searchActions = results.map(item => item[3]); state.searchIndex = results.length ? 0 : -1;
  const list = $('#paletteResults'); list.replaceChildren();
  if (!results.length) list.append(el('p', 'empty-state', 'No matches in this project.'));
  results.forEach(([symbol, title, description], index) => {
    const button = el('button', 'search-result');
    const text = el('div'); text.append(el('strong', '', title), el('small', '', description));
    button.append(icon(symbol), text);
    button.addEventListener('click', () => void chooseSearch(index));
    list.append(button);
  });
  highlightSearch();
}
function highlightSearch() { $$('.search-result').forEach((button, index) => button.classList.toggle('is-selected', index === state.searchIndex)); }
async function chooseSearch(index) {
  const action = state.searchActions[index];
  $('#commandPalette').close();
  try { await action?.(); } catch (error) { toast(error.message); }
}
function openSearch() {
  state.searchSeq++; clearTimeout(openSearch.timer);
  $('#paletteInput').value = '';
  renderSearchResults(paletteCommands(), 'Quick actions');
  showDialog('commandPalette'); $('#paletteInput').focus();
}
async function search(query, seq) {
  const needle = query.trim().toLowerCase(), epoch = state.epoch, project = rootPath();
  if (!needle) { renderSearchResults(paletteCommands(), 'Quick actions'); return; }
  const results = paletteCommands(needle);
  for (const chat of projectChats().filter(chat => chat.title.toLowerCase().includes(needle) || chat.messages.some(message => message.content.toLowerCase().includes(needle))).slice(0, 20)) results.push(['chat', chat.title, 'Chat in this workspace', () => selectChat(chat.id)]);
  let errorText = '';
  if (project && needle.length >= 2) {
    try {
      const files = await native('searchFiles', project, query, browseOptions());
      for (const file of files.filter(file => ['file', 'directory'].includes(file.type))) results.push([file.type === 'directory' ? 'folder' : 'file', file.name, file.path, () => file.type === 'directory' ? revealDirectory(file.path) : openFile(file.path)]);
    } catch { errorText = ' File search unavailable.'; }
  }
  if (seq !== state.searchSeq || !live(epoch) || !$('#commandPalette').open) return;
  renderSearchResults(results, `${state.project?.name || 'No project'} / Chats and commands${project ? ' / File names (up to 100)' : ''}${needle.length < 2 && project ? ' - type 2 characters for files' : ''}${errorText}`);
}
function saveMessage(event) {
  event.preventDefault();
  const content = composer.value.trim();
  if (!content) return;
  const now = Date.now(), oldDraftKey = draftKey();
  let chat = currentChat();
  const isNew = !chat;
  if (isNew) chat = { id: crypto.randomUUID(), title: content.length > 52 ? content.slice(0, 49) + '...' : content, projectPath: rootPath(), messages: [], createdAt: now, updatedAt: now, mode: state.settings.agentMode };
  const message = { role: 'user', content, createdAt: now };
  const previousUpdatedAt = chat.updatedAt;
  chat.messages.push(message); chat.updatedAt = now;
  if (isNew) state.chats.push(chat);
  if (!saveChats()) { chat.messages.pop(); chat.updatedAt = previousUpdatedAt; if (isNew) state.chats = state.chats.filter(item => item !== chat); return; }
  state.activeChatId = chat.id;
  state.drafts[oldDraftKey] = ''; state.drafts[chat.id] = '';
  store('june.drafts', state.drafts); store('june.activeChatId', chat.id);
  composer.value = ''; renderChats(); renderConversation(); sizeComposer(); composer.focus();
}
const actions = {
  sidebar: toggleSidebar, 'add-project': addProject, personal: () => switchProject(null),
  'new-chat': () => selectChat(), search: openSearch, settings: () => openSettings(),
  connection: () => openSettings('backend'), files: () => toggleInspector('files'), changes: () => toggleInspector('changes'),
  'close-inspector': closeInspector, 'close-file': () => { showChat(); composer.focus(); },
  'refresh-files': renderFiles, 'refresh-changes': renderChanges,
  'reveal-project': () => rootPath() && native('revealPath', rootPath(), ''),
  'reveal-file': () => rootPath() && state.file && native('revealPath', rootPath(), state.file),
  'remove-project': removeProject, 'test-backend': testBackend,
  'chat-options': () => currentChat() && showDialog('chatOptions'),
  'rename-chat': () => editChat(false), 'delete-chat': () => editChat(true)
};
document.addEventListener('click', async event => {
  const close = event.target.closest('[data-close]');
  if (close) { $('#' + close.dataset.close).close(); return; }
  const action = event.target.closest('[data-action]');
  if (action && !action.disabled) { try { await actions[action.dataset.action]?.(); } catch (error) { toast(error.message); } }
  if (!event.target.closest('.project-picker')) hideProjectMenu();
});
$('#projectButton').addEventListener('click', () => {
  const open = $('#projectMenu').hidden;
  $('#projectMenu').hidden = !open;
  $('#projectButton').setAttribute('aria-expanded', String(open));
  if (open) $('#projectMenu button')?.focus();
});
$('#chatsToggle').addEventListener('click', () => { state.chatsExpanded = !state.chatsExpanded; store('june.chatsExpanded', state.chatsExpanded); renderChats(); });
$('#sidebarScrim').addEventListener('click', closeMobileSidebar);
$$('[data-panel]').forEach(tab => tab.addEventListener('click', () => openInspector(tab.dataset.panel)));
$$('[data-settings]').forEach(tab => tab.addEventListener('click', () => selectSettingsTab(tab.dataset.settings)));
$$('[role="tablist"]').forEach(list => list.addEventListener('keydown', event => {
  const tabs = $$('[role="tab"]', list), index = tabs.indexOf(document.activeElement);
  if (index < 0) return;
  let next;
  if (['ArrowDown', 'ArrowRight'].includes(event.key)) next = (index + 1) % tabs.length;
  else if (['ArrowUp', 'ArrowLeft'].includes(event.key)) next = (index - 1 + tabs.length) % tabs.length;
  else if (event.key === 'Home') next = 0; else if (event.key === 'End') next = tabs.length - 1; else return;
  event.preventDefault(); tabs[next].focus(); tabs[next].click();
}));
$$('[data-setting]').forEach(input => {
  input.addEventListener('input', () => { input.setCustomValidity(''); if (input.dataset.setting === 'backendUrl') resetHealth(); });
  input.addEventListener('change', () => {
    const key = input.dataset.setting;
    let value = input.type === 'checkbox' ? input.checked : input.value.trim();
    if (['previewLimit', 'contextBudget'].includes(key)) value = Number(value);
    if (!validSetting(key, value)) { input.setCustomValidity(key === 'backendUrl' ? 'Use an HTTP or HTTPS base URL without credentials, query, or fragment.' : 'Enter a valid value within the allowed range.'); input.reportValidity(); $('#settingsSaveState').textContent = 'Fix the highlighted value to save it.'; return; }
    const next = { ...state.settings, [key]: value };
    if (!store('june.settings', next)) { $('#settingsSaveState').textContent = 'Could not save changes.'; return; }
    state.settings = next; applyAppearance(); $('#settingsSaveState').textContent = 'Saved on this device.';
    if (key === 'rememberProject') store('june.lastProjectPath', value ? rootPath() : '');
    if (['showHidden', 'excludeCommon'].includes(key) && state.inspector === 'files') void renderFiles();
    if (key === 'previewLimit' && state.file) void openFile(state.file);
    if (key === 'backendUrl') resetHealth();
  });
});
$('#actionForm').addEventListener('submit', event => { event.preventDefault(); if ($('#actionInput').required && !$('#actionInput').value.trim()) return; $('#actionDialog').close('confirm'); });
$('#composerForm').addEventListener('submit', saveMessage);
composer.addEventListener('input', () => { sizeComposer(); saveDraft(); });
composer.addEventListener('keydown', event => { if (event.key === 'Enter' && !event.shiftKey && !event.isComposing && event.keyCode !== 229) { event.preventDefault(); $('#composerForm').requestSubmit(); } });
$('#paletteInput').addEventListener('input', () => {
  const seq = ++state.searchSeq;
  clearTimeout(openSearch.timer);
  state.searchActions = []; state.searchIndex = -1;
  $('#paletteResults').replaceChildren(el('p', 'tree-notice', 'Searching...'));
  openSearch.timer = setTimeout(() => void search($('#paletteInput').value, seq), 160);
});
$('#commandPalette').addEventListener('close', () => { state.searchSeq++; clearTimeout(openSearch.timer); });
$('#paletteInput').addEventListener('keydown', event => {
  const length = state.searchActions.length;
  if (['ArrowDown', 'ArrowUp'].includes(event.key) && length) {
    event.preventDefault(); state.searchIndex = (state.searchIndex + (event.key === 'ArrowDown' ? 1 : -1) + length) % length;
    highlightSearch(); $$('.search-result')[state.searchIndex]?.scrollIntoView({ block: 'nearest' });
  }
  if (event.key === 'Enter') { event.preventDefault(); if (state.searchIndex >= 0) void chooseSearch(state.searchIndex); }
});
$$('dialog').forEach(dialog => dialog.addEventListener('click', event => {
  if (event.target !== dialog) return;
  const rect = dialog.getBoundingClientRect();
  if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
}));
document.addEventListener('keydown', event => {
  if ($('dialog[open]')) return; // Native dialog handles Esc and traps focus.
  if (event.key === 'Escape') {
    if (!$('#projectMenu').hidden) hideProjectMenu(true);
    else if ($('#appShell').classList.contains('mobile-nav')) { closeMobileSidebar(); $('#sidebarToggle').focus(); }
    else if (state.file) { showChat(); composer.focus(); }
    else if (state.inspector) closeInspector();
    return;
  }
  if (!(event.ctrlKey || event.metaKey) || event.altKey) return;
  const map = { n: () => selectChat(), k: openSearch, p: openSearch, b: toggleSidebar, ',': () => openSettings() };
  const action = map[event.key.toLowerCase()];
  if (action) { event.preventDefault(); action(); }
});
let windowStateRequest = 0;
function setMaximizeIcon(maximized) { const button = $('#windowMaximizeBtn'); button.replaceChildren(icon(maximized ? 'restore' : 'maximize')); button.title = maximized ? 'Restore' : 'Maximize'; button.setAttribute('aria-label', button.title); }
async function syncWindowState() {
  if (!desktop?.isWindowMaximized) return;
  const seq = ++windowStateRequest;
  try { const maximized = await desktop.isWindowMaximized(); if (seq === windowStateRequest) setMaximizeIcon(maximized); } catch { /* Closing a window may invalidate its webContents. */ }
}
for (const [id, method] of [['windowMinimizeBtn', 'minimizeWindow'], ['windowCloseBtn', 'closeWindow'], ['windowMaximizeBtn', 'toggleMaximizeWindow']]) $('#' + id).addEventListener('click', async () => {
  try { const value = await native(method); if (method === 'toggleMaximizeWindow') { windowStateRequest++; setMaximizeIcon(value); } } catch (error) { toast(error.message); }
});
window.addEventListener('resize', () => { syncSidebar(); void syncWindowState(); });
window.addEventListener('focus', () => void syncWindowState());
window.addEventListener('beforeunload', saveDraft);
async function init() {
  applyAppearance(); syncSettings(); syncSidebar(); renderChats(); renderConversation(); restoreDraft();
  if (!desktop) { renderProjectMenu(); return; }
  try {
    const info = await native('getRuntimeInfo');
    $('#runtimeInfo').textContent = `June ${info.appVersion} / Electron ${info.electronVersion} / ${info.platform}`;
    if (info.platform === 'darwin') $$('[data-shortcut]').forEach(key => { key.textContent = `Cmd ${key.dataset.shortcut}`; });
    void syncWindowState();
  } catch (error) { toast(error.message); }
  try {
    state.projects = (await native('listProjects')).filter(project => project && typeof project.path === 'string' && typeof project.name === 'string');
    const remembered = state.settings.rememberProject ? localStorage.getItem('june.lastProjectPath') : '';
    const id = localStorage.getItem('june.activeChatId') || '';
    switchProject(state.projects.find(project => project.path === remembered) || null, id);
  } catch (error) { renderProjectMenu(); toast(`Could not load projects: ${error.message}`); }
}
void init();
