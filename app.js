const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];

const state = {
  project: localStorage.getItem('june.project') || 'June',
  sidebarCollapsed: false,
};

const projectButton = $('#projectButton');
const projectMenu = $('#projectMenu');
const projectName = $('.project-name');
const palette = $('#commandPalette');
const paletteInput = $('#paletteInput');
const composer = $('#composerInput');

function setProject(name) {
  state.project = name;
  localStorage.setItem('june.project', name);
  projectName.textContent = name;
  $('.breadcrumb span').textContent = name;
  $('.conversation-toolbar p').textContent = `Agent session · ${name}`;
  projectMenu.classList.add('hidden');
  projectButton.setAttribute('aria-expanded', 'false');
}

setProject(state.project);

projectButton.addEventListener('click', () => {
  const open = projectMenu.classList.toggle('hidden') === false;
  projectButton.setAttribute('aria-expanded', String(open));
});

$$('#projectMenu [data-project]').forEach(btn => btn.addEventListener('click', () => setProject(btn.dataset.project)));

document.addEventListener('click', (e) => {
  if (!projectButton.contains(e.target) && !projectMenu.contains(e.target)) {
    projectMenu.classList.add('hidden');
    projectButton.setAttribute('aria-expanded', 'false');
  }
});

function openPalette() {
  palette.classList.remove('hidden');
  requestAnimationFrame(() => paletteInput.focus());
}
function closePalette() { palette.classList.add('hidden'); }

$('#searchBtn').addEventListener('click', openPalette);
$$('.rail-btn[data-view="search"]').forEach(b => b.addEventListener('click', openPalette));
$('.header-actions .icon-btn').addEventListener('click', openPalette);
palette.addEventListener('click', e => { if (e.target === palette) closePalette(); });

$('#newChatBtn').addEventListener('click', newChat);
function newChat() {
  $$('.chat-item').forEach(i => i.classList.remove('active'));
  const item = document.createElement('button');
  item.className = 'chat-item active';
  item.innerHTML = '<span class="chat-title">New coding session</span><span class="chat-meta">now</span>';
  $('#chatList').prepend(item);
  $('#chatHistory').innerHTML = '';
  $('.conversation-toolbar h1').textContent = 'New coding session';
  composer.focus();
}

$('#sidebarToggle').addEventListener('click', () => {
  if (window.innerWidth <= 860) $('.sidebar').classList.toggle('mobile-open');
  else document.body.classList.toggle('sidebar-collapsed');
});

$$('.chat-item').forEach(item => item.addEventListener('click', () => {
  $$('.chat-item').forEach(i => i.classList.remove('active'));
  item.classList.add('active');
  $('.conversation-toolbar h1').textContent = $('.chat-title', item).textContent;
}));

$$('.workbench-tab').forEach(tab => tab.addEventListener('click', () => {
  $$('.workbench-tab').forEach(t => t.classList.remove('active'));
  tab.classList.add('active');
  $$('.workbench-content').forEach(p => p.classList.toggle('hidden', p.dataset.panel !== tab.dataset.tab));
}));

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

function sendMessage() {
  const text = composer.value.trim();
  if (!text) return;
  const msg = document.createElement('article');
  msg.className = 'message user-message';
  msg.innerHTML = `<div class="message-role">You</div><div class="message-body"></div>`;
  $('.message-body', msg).textContent = text;
  $('#chatHistory').appendChild(msg);
  composer.value = '';
  composer.style.height = 'auto';
  $('#chatHistory').scrollTop = $('#chatHistory').scrollHeight;
  setTimeout(() => appendAgentPlaceholder(text), 250);
}

function appendAgentPlaceholder(text) {
  const msg = document.createElement('article');
  msg.className = 'message assistant-message';
  msg.innerHTML = `<div class="message-role"><span class="agent-orb"></span>June</div><div class="message-body"><p>I’ve queued that request for the active <strong>${state.project}</strong> workspace.</p><div class="agent-step active"><span>↻</span><div><strong>Waiting for agent backend</strong><small>Connect this UI to your custom pipeline stream to replace this placeholder.</small></div></div></div>`;
  $('#chatHistory').appendChild(msg);
  $('#chatHistory').scrollTop = $('#chatHistory').scrollHeight;
}

document.addEventListener('keydown', e => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'k') { e.preventDefault(); openPalette(); }
  if (mod && e.key.toLowerCase() === 'n') { e.preventDefault(); newChat(); }
  if (e.key === 'Escape') { closePalette(); projectMenu.classList.add('hidden'); $('.sidebar').classList.remove('mobile-open'); }
});

$('#addProjectBtn').addEventListener('click', () => {
  const name = prompt('Project name');
  if (!name) return;
  const btn = document.createElement('button');
  btn.dataset.project = name;
  btn.innerHTML = `<span class="project-dot"></span><span>${name}</span><small>Local project</small>`;
  btn.addEventListener('click', () => setProject(name));
  $('#projectMenu').insertBefore(btn, $('.project-menu-sep'));
  setProject(name);
});
