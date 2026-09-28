# June - workspace tools

Source update for BigJMC9/June main at 7d79ac1db9eaa16f56e699daf42533202a49bb0c.

Close June and copy these files into your existing checkout, merging directories.
Keep the existing electron/main.cjs, package-lock.json and LICENSE. This is not a
standalone installer. The package entry point now loads electron/start.cjs, which
registers additional APIs and then loads the existing main process. Start with
npm run dev; no new npm dependencies were added. Restart Electron fully after
updating, because the preload and entry point also change.

## Features
- June chat title dropdown: rename, copy, Markdown/PDF export, save Markdown to
  Documents, reviewed context summary, chat mode/context settings, and deletion.
- Memories & skills: manual creation/editing/deletion, global/project scope,
  enable switches, search/filter/sort, explicit skill approval, reviewed imports
  from TXT/Markdown/JSON/SKILL.md or a public GitHub Markdown URL, JSON export.
- Cookbook: local GGUF/Hugging Face cache discovery, saved model setups, quoted
  launch/download commands, CPU/RAM and fixed executable version checks.
- Temporary chats: in-memory messages and drafts, excluded from saved history
  and knowledge, discard confirmation, normal draft restoration, and explicit
  warning before copying/exporting outside the temporary session.

## Honest boundaries
This remains a frontend for your custom pipeline. It does not send model
requests, execute agent tools, apply patches, extract memories automatically,
or assign confidence scores. Context compaction uses a summary you write/review.
Cookbook prepares commands; it does not launch servers, install software, or
download model files. Selecting a setup changes model preferences only.

Temporary mode prevents June from persisting conversation/draft content; it is
not anonymity, secure deletion, protection from OS swap/crash dumps, or a promise
about future backend/provider retention. Explicit exports/copies persist outside
June. Global settings and manually chosen model folders can still be saved.
Knowledge and setups are stored locally without encryption; do not enter secrets.

New native APIs validate the sender, restrict network imports to public GitHub
Markdown and use native save/folder dialogs. No raw Node, IPC or shell is exposed
to the renderer. Model scans have depth/entry/result limits and report partial
results. Imported skill code is never executed and approvals are not trusted.
The original project host is preserved; this update is not a full security audit.

Shortcuts: Ctrl/Cmd+N normal chat; Shift+N temporary chat; K/P search; B sidebar;
comma settings. Enter adds a message and Shift+Enter inserts a newline.

## Data and integration
New storage keys: june.knowledge.v1 and june.cookbook.v1. The selected model folder
is stored in Electron user data. Existing chats, drafts and settings are kept.
workspace-data.mjs exports buildContext for later integration: reviewed summary,
recent messages, eligible scoped knowledge, and explicit temporary/retention
flags. It performs no networking. The renderer's extras controller exposes a
requestContext method but never submits it automatically.

See INSTALL.md for application instructions and VALIDATION.md for exact test
scope. Run npm test for the dependency-free Node suite.
