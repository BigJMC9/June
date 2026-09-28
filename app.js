const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const desktop = window.juneDesktop || null;

if (desktop?.isDesktop) {
  document.documentElement.dataset.runtime = 'desktop';
}

const defaultSettings = {
  theme: 'dark',
  density: 'comfortable',
  rememberProject: true,
  showHidden: false,
  excludeCommon: true,
  previewLimit: 2097152,
  agentMode: 'agent',
  backendUrl: 'http://127.0.0.1:8765',
  defaultModel: '',
  contextBudget: 32768,
  requireApproval: true,
  allowTerminal: false,
  allowNetwork: false
};

function loadSettings() {
  try {
    const parsed = JSON.parse(localStorage.getItem('june.settings') || '{}');
    return { ...defaultSettings, ...parsed };
  } catch {
    return { ...defaultSettings };
  }
}

const state = {
  projects: [],
  project: null,
  activeFile: '',
  openFolders: new Set(),
  settings: loadSettings(),
  searchTimer: null
};

const projectButton = $('#projectButton');
const projectMenu = $('#projectMenu');
const projectName = $('.project-name');
const palette = $('#commandPalette');
const paletteInput = $('#paletteInput');
const paletteResults = $('#paletteResults');
const composer = $('#composerInput');
const fileTree = $('#fileTree');
const filePreview = $('#filePreview');
const filePreviewCode = $('#filePreviewCode code');
const settingsModal = $('#settingsModal');

function saveSettings() {
  localStorage.setItem('june.settings', JSON.stringify(state.settings));
  applySettings();
  $('#settingsSaveState').textContent = 'Saved.';
  clearTimeout(saveSettings._timer);
  saveSettings._timer = setTimeout(() => {
    $('#settingsSaveState').textContent = 'Settings save automatically.';
  }, 1200);
}

function applySettings() {
  document.documentElement.dataset.theme = state.settings.theme;
  document.documentElement.dataset.density = state.settings.density;
  $('#modeBtn').innerHTML = '<span class="mode-dot"></span>' +
    state.settings.agentMode.charAt(0).toUpperCase() +
    state.settings.agentMode.slice(1) + ' <span>⌄</span>';
}

function formatBytes(bytes) {
  if (bytes == null) return '';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function basename(filePath) {
  return String(filePath || '').split(/[\\/]/).filter(Boolean).pop() || '';
}

function fileTypeLabel(filePath) {
  const ext = basename(filePath).split('.').pop()?.toUpperCase() || 'FILE';
  return ext.slice(0, 4);
}

function setActiveRail(view) {
  $$('.rail-btn').forEach(btn => btn.classList.toggle('active', btn.dataset.view === view));
}

function activateWorkbenchTab(name) {
  $$('.workbench-tab').forEach(tab => tab.classList.toggle('active', tab.dataset.tab === name));
  $$('.workbench-content').forEach(panel => panel.classList.toggle('hidden', panel.dataset.panel !== name));
}

function showChatSurface() {
  filePreview.classList.add('hidden');
  $('#chatHistory').classList.remove('hidden');
  $('.composer-wrap').classList.remove('hidden');
  state.activeFile = '';
}

function showFileSurface() {
  $('#chatHistory').classList.add('hidden');
  $('.composer-wrap').classList.add('hidden');
  filePreview.classList.remove('hidden');
}

function setProjectUi(project) {
  projectName.textContent = project?.name || 'Select project';
  $('.breadcrumb span').textContent = project?.name || 'No project';
  $('.conversation-toolbar p').textContent = project
    ? 'Agent session · ' + project.name
    : 'No local project selected';

  const contextRows = $$('.project-context .context-row');
  if (contextRows[0]) contextRows[0].querySelector('small').textContent = project?.path || 'No project';
  if (contextRows[1] && !project) contextRows[1].querySelector('small').textContent = '—';

  projectMenu.classList.add('hidden');
  projectButton.setAttribute('aria-expanded', 'false');
}

async function setProject(project, { persist = true } = {}) {
  state.project = project || null;
  state.openFolders.clear();
  showChatSurface();
  setProjectUi(state.project);

  if (persist) {
    if (state.project && state.settings.rememberProject) {
      localStorage.setItem('june.lastProjectPath', state.project.path);
    } else if (!state.settings.rememberProject) {
      localStorage.removeItem('june.lastProjectPath');
    }
  }

  if (!state.project) {
    renderNoProject();
    return;
  }

  await refreshWorkspace();
}

function renderNoProject() {
  fileTree.innerHTML = '<div class="empty-state compact">Add a local project to browse files.</div>';
  $('#changesList').innerHTML = '<div class="empty-state compact">Git changes will appear here.</div>';
  $('#changesSummary').textContent = 'No project selected';
  $('#branchSummary').textContent = 'Select a local project';
  $('.workbench-tab[data-tab="changes"] .badge').textContent = '0';
}

function renderProjectMenu() {
  $$('#projectMenu [data-project], #projectMenu .project-entry').forEach(node => node.remove());
  const sep = $('.project-menu-sep', projectMenu);

  for (const project of state.projects) {
    const btn = document.createElement('button');
    btn.className = 'project-entry';
    btn.dataset.project = project.name;
    btn.dataset.path = project.path;

    const dot = document.createElement('span');
    dot.className = 'project-dot';

    const label = document.createElement('span');
    label.textContent = project.name;

    const detail = document.createElement('small');
    detail.textContent = project.path;

    const remove = document.createElement('span');
    remove.className = 'project-remove';
    remove.textContent = '×';
    remove.title = 'Remove project from June';
    remove.addEventListener('click', async event => {
      event.stopPropagation();
      await removeProject(project);
    });

    btn.append(dot, label, detail, remove);
    btn.addEventListener('click', () => setProject(project));
    projectMenu.insertBefore(btn, sep);
  }

  if (!state.projects.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-state compact project-entry';
    empty.textContent = 'No local projects yet.';
    projectMenu.insertBefore(empty, sep);
  }
}

async function addProject() {
  if (!desktop?.selectProjectDirectory) {
    alert('Local project access is available in the desktop app.');
    return;
  }

  try {
    const project = await desktop.selectProjectDirectory();
    if (!project) return;

    const existingIndex = state.projects.findIndex(item => item.path === project.path);
    if (existingIndex >= 0) state.projects[existingIndex] = project;
    else state.projects.unshift(project);

    renderProjectMenu();
    await setProject(project);
  } catch (error) {
    console.error(error);
    alert('Could not add project: ' + error.message);
  }
}

async function removeProject(project) {
  if (!desktop || !project) return;
  try {
    await desktop.removeProject(project.path);
    state.projects = state.projects.filter(item => item.path !== project.path);
    if (state.project?.path === project.path) {
      localStorage.removeItem('june.lastProjectPath');
      await setProject(state.projects[0] || null);
    }
    renderProjectMenu();
  } catch (error) {
    console.error(error);
    alert('Could not remove project: ' + error.message);
  }
}

async function refreshWorkspace() {
  if (!desktop || !state.project) return;
  await Promise.all([renderRootFiles(), refreshGitStatus()]);
}

async function renderRootFiles() {
  fileTree.innerHTML = '<div class="tree-loading">Loading project…</div>';
  try {
    const entries = await desktop.listDirectory(state.project.path, '', {
      showHidden: state.settings.showHidden,
      excludeCommon: state.settings.excludeCommon
    });
    fileTree.innerHTML = '';
    if (!entries.length) {
      fileTree.innerHTML = '<div class="empty-state compact">This folder is empty.</div>';
      return;
    }
    entries.forEach(entry => fileTree.appendChild(createTreeEntry(entry, 0)));
  } catch (error) {
    console.error(error);
    fileTree.innerHTML = '<div class="empty-state compact">Unable to read this project.</div>';
  }
}

function createTreeEntry(entry, depth) {
  const wrapper = document.createElement('div');
  wrapper.className = 'tree-node';

  const row = document.createElement('div');
  row.className = 'tree-row ' + entry.type;
  row.dataset.path = entry.path;
  row.style.paddingLeft = (5 + depth * 14) + 'px';

  const chevron = document.createElement('span');
  chevron.className = 'tree-chevron';
  chevron.textContent = entry.type === 'directory' ? '›' : '·';

  const label = document.createElement('span');
  label.className = 'tree-label';
  label.textContent = entry.name;

  const meta = document.createElement('span');
  meta.className = 'tree-meta';
  meta.textContent = entry.type === 'file' ? formatBytes(entry.size) : '';

  row.append(chevron, label, meta);
  wrapper.appendChild(row);

  if (entry.type === 'directory') {
    const children = document.createElement('div');
    children.className = 'tree-children hidden';
    wrapper.appendChild(children);

    row.addEventListener('click', async () => {
      const open = !children.classList.contains('hidden');
      if (open) {
        children.classList.add('hidden');
        chevron.textContent = '›';
        state.openFolders.delete(entry.path);
        return;
      }

      children.classList.remove('hidden');
      chevron.textContent = '⌄';
      state.openFolders.add(entry.path);

      if (!children.dataset.loaded) {
        children.innerHTML = '<div class="tree-loading" style="padding-left:' + (depth + 2) * 14 + 'px">Loading…</div>';
        try {
          const nested = await desktop.listDirectory(state.project.path, entry.path, {
            showHidden: state.settings.showHidden,
            excludeCommon: state.settings.excludeCommon
          });
          children.innerHTML = '';
          nested.forEach(item => children.appendChild(createTreeEntry(item, depth + 1)));
          if (!nested.length) children.innerHTML = '<div class="tree-loading">Empty folder</div>';
          children.dataset.loaded = '1';
        } catch (error) {
          console.error(error);
          children.innerHTML = '<div class="tree-loading">Unable to read folder</div>';
        }
      }
    });
  } else if (entry.type === 'file') {
    row.addEventListener('click', () => openFile(entry.path));
  }

  return wrapper;
}

async function openFile(relativePath) {
  if (!desktop || !state.project) return;
  state.activeFile = relativePath;

  $$('.tree-row').forEach(row => row.classList.toggle('active-file', row.dataset.path === relativePath));
  showFileSurface();

  $('#filePreviewName').textContent = basename(relativePath);
  $('#filePreviewPath').textContent = relativePath;
  $('#filePreviewMeta').textContent = 'Loading…';
  filePreviewCode.textContent = '';
  $('#filePreviewNotice').classList.add('hidden');

  try {
    const file = await desktop.readTextFile(
      state.project.path,
      relativePath,
      Number(state.settings.previewLimit)
    );

    $('#filePreviewMeta').textContent = formatBytes(file.size);

    if (file.tooLarge) {
      $('#filePreviewCode').parentElement.classList.add('hidden');
      $('#filePreviewNotice').textContent = 'This file is larger than the configured preview limit (' +
        formatBytes(Number(state.settings.previewLimit)) + ').';
      $('#filePreviewNotice').classList.remove('hidden');
      return;
    }

    if (file.binary) {
      $('#filePreviewCode').parentElement.classList.add('hidden');
      $('#filePreviewNotice').textContent = 'Binary file preview is not supported.';
      $('#filePreviewNotice').classList.remove('hidden');
      return;
    }

    $('#filePreviewCode').parentElement.classList.remove('hidden');
    filePreviewCode.textContent = file.content;
  } catch (error) {
    console.error(error);
    $('#filePreviewCode').parentElement.classList.add('hidden');
    $('#filePreviewNotice').textContent = 'Unable to open this file.';
    $('#filePreviewNotice').classList.remove('hidden');
  }
}

async function refreshGitStatus() {
  if (!desktop || !state.project) return;
  const list = $('#changesList');
  list.innerHTML = '<div class="tree-loading">Checking Git status…</div>';

  try {
    const status = await desktop.getGitStatus(state.project.path);
    const branchNode = $$('.project-context .context-row')[1]?.querySelector('small');

    if (!status.available) {
      $('#changesSummary').textContent = 'Git unavailable';
      $('#branchSummary').textContent = status.error || 'Not a Git repository';
      if (branchNode) branchNode.textContent = 'Not a Git repo';
      $('.workbench-tab[data-tab="changes"] .badge').textContent = '0';
      list.innerHTML = '<div class="empty-state compact">' + (status.error || 'Git unavailable') + '</div>';
      return;
    }

    if (branchNode) branchNode.textContent = status.branch || 'HEAD';
    $('#branchSummary').textContent = status.branch || 'HEAD';
    $('#changesSummary').textContent = status.files.length
      ? status.files.length + ' changed file' + (status.files.length === 1 ? '' : 's')
      : 'Working tree clean';
    $('.workbench-tab[data-tab="changes"] .badge').textContent = String(status.files.length);
    list.innerHTML = '';

    if (!status.files.length) {
      list.innerHTML = '<div class="empty-state compact">No uncommitted changes.</div>';
      return;
    }

    for (const change of status.files) {
      const btn = document.createElement('button');
      btn.className = 'git-change';

      const badge = document.createElement('span');
      badge.className = 'git-status';
      badge.textContent = change.status.trim() || '?';

      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = basename(change.path);
      const pathText = document.createElement('small');
      pathText.textContent = change.path;
      info.append(title, pathText);

      const type = document.createElement('span');
      type.className = 'tree-meta';
      type.textContent = fileTypeLabel(change.path);

      btn.append(badge, info, type);
      btn.addEventListener('click', () => openFile(change.path));
      list.appendChild(btn);
    }
  } catch (error) {
    console.error(error);
    list.innerHTML = '<div class="empty-state compact">Unable to read Git status.</div>';
  }
}

function openPalette() {
  palette.classList.remove('hidden');
  paletteInput.value = '';
  renderPaletteHome();
  requestAnimationFrame(() => paletteInput.focus());
}

function closePalette() {
  palette.classList.add('hidden');
}

function renderPaletteHome() {
  paletteResults.innerHTML = `
    <div class="palette-section-label">Quick actions</div>
    <button class="palette-item" data-command="new-chat"><span>＋</span><div><strong>New chat</strong><small>Start a new agent session</small></div><kbd>Ctrl N</kbd></button>
    <button class="palette-item" data-command="add-project"><span>◇</span><div><strong>Add project</strong><small>Open a local folder</small></div></button>
    <button class="palette-item" data-command="settings"><span>⚙</span><div><strong>Settings</strong><small>Workspace and agent configuration</small></div></button>
  `;
  bindPaletteCommands();
}

function bindPaletteCommands() {
  $$('[data-command]', paletteResults).forEach(item => {
    item.addEventListener('click', async () => {
      closePalette();
      if (item.dataset.command === 'new-chat') newChat();
      if (item.dataset.command === 'add-project') await addProject();
      if (item.dataset.command === 'settings') openSettings();
    });
  });
}

async function searchPalette(query) {
  if (!query.trim()) {
    renderPaletteHome();
    return;
  }

  if (!desktop || !state.project) {
    paletteResults.innerHTML = '<div class="empty-state compact">Select a local project before searching files.</div>';
    return;
  }

  paletteResults.innerHTML = '<div class="tree-loading">Searching…</div>';

  try {
    const results = await desktop.searchFiles(state.project.path, query, {
      showHidden: state.settings.showHidden,
      excludeCommon: state.settings.excludeCommon
    });

    paletteResults.innerHTML = '<div class="palette-section-label">Project files</div>';

    if (!results.length) {
      paletteResults.insertAdjacentHTML('beforeend', '<div class="empty-state compact">No matching files or folders.</div>');
      return;
    }

    results.forEach(result => {
      const item = document.createElement('button');
      item.className = 'palette-item';

      const icon = document.createElement('span');
      icon.textContent = result.type === 'directory' ? '◇' : '·';

      const info = document.createElement('div');
      const title = document.createElement('strong');
      title.textContent = result.name;
      const small = document.createElement('small');
      small.className = 'search-result-path';
      small.textContent = result.path;
      info.append(title, small);

      item.append(icon, info);
      item.addEventListener('click', async () => {
        closePalette();
        activateWorkbenchTab('files');
        setActiveRail('files');
        if (result.type === 'file') await openFile(result.path);
      });

      paletteResults.appendChild(item);
    });
  } catch (error) {
    console.error(error);
    paletteResults.innerHTML = '<div class="empty-state compact">Search failed.</div>';
  }
}

function openSettings() {
  settingsModal.classList.remove('hidden');
  syncSettingsForm();
}

function closeSettings() {
  settingsModal.classList.add('hidden');
}

function syncSettingsForm() {
  const map = {
    settingTheme: 'theme',
    settingDensity: 'density',
    settingRememberProject: 'rememberProject',
    settingShowHidden: 'showHidden',
    settingExcludeCommon: 'excludeCommon',
    settingPreviewLimit: 'previewLimit',
    settingAgentMode: 'agentMode',
    settingBackendUrl: 'backendUrl',
    settingDefaultModel: 'defaultModel',
    settingContextBudget: 'contextBudget',
    settingRequireApproval: 'requireApproval',
    settingAllowTerminal: 'allowTerminal',
    settingAllowNetwork: 'allowNetwork'
  };

  Object.entries(map).forEach(([id, key]) => {
    const el = $('#' + id);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = Boolean(state.settings[key]);
    else el.value = state.settings[key];
  });
}

async function initRuntimeInfo() {
  if (!desktop?.getRuntimeInfo) return;
  try {
    const info = await desktop.getRuntimeInfo();
    $('#aboutAppVersion').textContent = 'June ' + info.appVersion;
    $('#aboutElectronVersion').textContent = info.electronVersion || '—';
    $('#aboutPlatform').textContent = info.platform || '—';
  } catch (error) {
    console.error(error);
  }
}

function newChat() {
  showChatSurface();
  $$('.chat-item').forEach(i => i.classList.remove('active'));

  const item = document.createElement('button');
  item.className = 'chat-item active';
  item.innerHTML = '<span class="chat-title">New coding session</span><span class="chat-meta">now</span>';
  item.addEventListener('click', () => selectChatItem(item));
  $('#chatList').prepend(item);

  $('#chatHistory').innerHTML = '';
  $('.conversation-toolbar h1').textContent = 'New coding session';
  composer.focus();
}

function selectChatItem(item) {
  showChatSurface();
  $$('.chat-item').forEach(i => i.classList.remove('active'));
  item.classList.add('active');
  $('.conversation-toolbar h1').textContent = $('.chat-title', item).textContent;
}

function sendMessage() {
  const text = composer.value.trim();
  if (!text) return;

  const msg = document.createElement('article');
  msg.className = 'message user-message';
  msg.innerHTML = '<div class="message-role">You</div><div class="message-body"></div>';
  $('.message-body', msg).textContent = text;
  $('#chatHistory').appendChild(msg);

  composer.value = '';
  composer.style.height = 'auto';
  $('#chatHistory').scrollTop = $('#chatHistory').scrollHeight;

  const placeholder = document.createElement('article');
  placeholder.className = 'message assistant-message';
  placeholder.innerHTML = '<div class="message-role"><span class="agent-orb"></span>June</div>' +
    '<div class="message-body"><p>Ready to send this request to <strong>' +
    (state.settings.backendUrl || 'your configured backend') +
    '</strong>.</p><div class="agent-step active"><span>↻</span><div><strong>Agent backend not connected yet</strong>' +
    '<small>The frontend now has local workspace context. Wire the pipeline endpoint to replace this placeholder.</small></div></div></div>';
  $('#chatHistory').appendChild(placeholder);
  $('#chatHistory').scrollTop = $('#chatHistory').scrollHeight;
}

projectButton.addEventListener('click', () => {
  const open = projectMenu.classList.toggle('hidden') === false;
  projectButton.setAttribute('aria-expanded', String(open));
});

$('#addProjectBtn').addEventListener('click', addProject);
$('#searchBtn').addEventListener('click', openPalette);
$('.header-actions .icon-btn').addEventListener('click', openPalette);
$('#newChatBtn').addEventListener('click', newChat);
$('#refreshFilesBtn').addEventListener('click', renderRootFiles);
$('#refreshChangesBtn').addEventListener('click', refreshGitStatus);
$('#revealProjectBtn').addEventListener('click', () => {
  if (desktop && state.project) desktop.revealPath(state.project.path, '');
});
$('#revealFileBtn').addEventListener('click', () => {
  if (desktop && state.project && state.activeFile) desktop.revealPath(state.project.path, state.activeFile);
});
$('#closeFileBtn').addEventListener('click', showChatSurface);

$('.project-context .section-title-row button').addEventListener('click', refreshWorkspace);

$('#sidebarToggle').addEventListener('click', () => {
  if (window.innerWidth <= 860) $('.sidebar').classList.toggle('mobile-open');
  else document.body.classList.toggle('sidebar-collapsed');
});

$$('.chat-item').forEach(item => item.addEventListener('click', () => selectChatItem(item)));

$$('.workbench-tab').forEach(tab => tab.addEventListener('click', () => {
  activateWorkbenchTab(tab.dataset.tab);
}));

$$('.rail-btn').forEach(btn => btn.addEventListener('click', () => {
  const view = btn.dataset.view;
  if (view === 'search') {
    openPalette();
    return;
  }
  if (view === 'settings') {
    openSettings();
    return;
  }
  setActiveRail(view);
  if (view === 'files') activateWorkbenchTab('files');
  if (view === 'chat') showChatSurface();
}));

palette.addEventListener('click', e => {
  if (e.target === palette) closePalette();
});

paletteInput.addEventListener('input', () => {
  clearTimeout(state.searchTimer);
  state.searchTimer = setTimeout(() => searchPalette(paletteInput.value), 180);
});

composer.addEventListener('input', () => {
  composer.style.height = 'auto';
  composer.style.height = Math.min(composer.scrollHeight, 180) + 'px';
});

composer.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});

$('#sendBtn').addEventListener('click', sendMessage);

$('#closeSettingsBtn').addEventListener('click', closeSettings);
$('#closeSettingsFooterBtn').addEventListener('click', closeSettings);
settingsModal.addEventListener('click', event => {
  if (event.target === settingsModal) closeSettings();
});

$$('.settings-tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.settings-tab').forEach(item => item.classList.toggle('active', item === tab));
  $$('.settings-page').forEach(page => page.classList.toggle('hidden', page.dataset.settingsPage !== tab.dataset.settingsTab));
}));

const settingBindings = {
  settingTheme: 'theme',
  settingDensity: 'density',
  settingRememberProject: 'rememberProject',
  settingShowHidden: 'showHidden',
  settingExcludeCommon: 'excludeCommon',
  settingPreviewLimit: 'previewLimit',
  settingAgentMode: 'agentMode',
  settingBackendUrl: 'backendUrl',
  settingDefaultModel: 'defaultModel',
  settingContextBudget: 'contextBudget',
  settingRequireApproval: 'requireApproval',
  settingAllowTerminal: 'allowTerminal',
  settingAllowNetwork: 'allowNetwork'
};

Object.entries(settingBindings).forEach(([id, key]) => {
  const el = $('#' + id);
  const eventName = el?.type === 'text' || el?.type === 'url' || el?.type === 'number' ? 'input' : 'change';
  el?.addEventListener(eventName, async () => {
    let value = el.type === 'checkbox' ? el.checked : el.value;
    if (key === 'previewLimit' || key === 'contextBudget') value = Number(value);
    state.settings[key] = value;
    saveSettings();

    if (key === 'showHidden' || key === 'excludeCommon') {
      state.openFolders.clear();
      if (state.project) await renderRootFiles();
    }

    if (key === 'rememberProject' && !value) {
      localStorage.removeItem('june.lastProjectPath');
    }
  });
});

$('#removeCurrentProjectBtn').addEventListener('click', async () => {
  if (!state.project) return;
  if (confirm('Remove "' + state.project.name + '" from June? This does not delete any files.')) {
    await removeProject(state.project);
  }
});

document.addEventListener('click', event => {
  if (!projectButton.contains(event.target) && !projectMenu.contains(event.target)) {
    projectMenu.classList.add('hidden');
    projectButton.setAttribute('aria-expanded', 'false');
  }
});

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;

  if (mod && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    openPalette();
  }

  if (mod && e.key.toLowerCase() === 'n') {
    e.preventDefault();
    newChat();
  }

  if (mod && e.key.toLowerCase() === ',') {
    e.preventDefault();
    openSettings();
  }

  if (e.key === 'Escape') {
    closePalette();
    closeSettings();
    projectMenu.classList.add('hidden');
    $('.sidebar').classList.remove('mobile-open');
  }
});

async function initProjects() {
  if (!desktop?.listProjects) {
    renderNoProject();
    return;
  }

  try {
    state.projects = await desktop.listProjects();
    renderProjectMenu();

    const remembered = state.settings.rememberProject
      ? localStorage.getItem('june.lastProjectPath')
      : '';

    const initial = state.projects.find(project => project.path === remembered) || state.projects[0] || null;
    await setProject(initial, { persist: false });
  } catch (error) {
    console.error(error);
    renderNoProject();
  }
}

applySettings();
syncSettingsForm();
initRuntimeInfo();
initProjects();
