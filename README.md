# June - simplified workspace

A conversation-first redesign of the existing June Electron frontend. One
project-aware sidebar, a focused composer, and Files/Changes when needed.

## Apply this update

This ZIP is a renderer source update, not a standalone app or installer.
It targets BigJMC9/June's existing `desktop-electron` branch, starting from
`c27d5b9efa7726960a4a3c3f0491f58e120bfc7c`.

1. Fully close June. Back up or commit any local frontend edits.
2. Extract this ZIP into a temporary folder.
3. Copy `index.html`, `styles.css`, and `app.js` into your existing June project
   root, replacing those three files. Keep your existing `electron/`,
   `package.json`, lockfile, LICENSE, and other project files.
4. In the existing June project, run `npm run dev`.

No new npm dependencies are needed. The included test and documentation files
are optional. The final GitHub branch update was blocked; `git pull` alone will
not install this redesign.

## Layout

The sidebar contains the project selector, New chat, Search, collapsible Chats,
and Settings. Ctrl/Cmd+B collapses the whole sidebar. A new conversation has a
centered welcome and composer; after saving a message, the composer sits at the
bottom. Files and Changes open an optional workbench, closed by default. On
narrow screens it overlays the conversation instead of compressing it.

The duplicate project metadata, second session header, inactive attachment and
terminal controls, and unused Runs panel have been removed. The title bar keeps
only minimize, maximize/restore, and close. All controls use consistent local
SVG geometry, with no icon fonts or external asset requests.

## Functional behavior

- Existing preload methods provide project selection, lazy directory browsing,
  read-only text previews, file size/binary/error notices, file search, Git
  working-tree status, and operating-system reveal.
- Chats are scoped to the current project. Search includes this project's chats,
  file names/paths, and commands. Directory results expand their location.
- Chat rename and confirmed deletion work. Drafts survive chat and project
  switching, using the existing app's local storage alongside a new draft key.
- Existing `june.chats` and `june.settings` data is retained. Removing a project
  does not delete its files or saved chats; reopening the folder restores chats.
- Async responses are checked against the current project/request, so a slow
  older result cannot replace a newer search or file preview.
- Native dialogs retain keyboard focus and support Escape. Settings tabs support
  arrow keys. Collapsed navigation is not keyboard-focusable.

Shortcuts: Ctrl/Cmd+N new chat; K or P search; B sidebar; comma settings.
Enter saves a local message; Shift+Enter adds a line. IME composition is not
submitted prematurely.

## Settings and backend boundary

Settings is organized into General, Workspace, and Backend. The existing model,
mode, context budget, and tool-policy preferences remain under Pipeline
preferences. They are saved for future integration, not enforced permissions.

Messages are saved locally; there is no model response, agent execution, terminal
execution, or patch application in this update. A successful GET /health test
means the server is reachable, not that agent functionality is enabled.

The Electron main process, preload APIs, and packaging are unchanged. This UI
update is not a security audit of the existing filesystem/agent host.
Project content is rendered as text. The renderer CSP disallows direct network
connections; future streaming requires a validated bridge or a deliberate CSP
change.

## Validation

`node --check app.js` passed. The included Playwright suite passed 60 renderer
checks in system Chromium, using the documented offline mode with simulated
Electron methods and in-memory test storage. Screenshots are actual renders of
the included UI; project/file fixtures are simulated.

Native Windows/Electron behavior, OS folder dialogs, actual filesystem access,
CSP/module loading, and real storage persistence were not tested in that mode.
Those still require a local desktop smoke test after applying the update.

To run the optional tests normally:

```sh
python -m pip install playwright
python -m playwright install chromium
python tests/ui_smoke.py
```

For an environment that does not allow localhost navigation:

```sh
JUNE_OFFLINE_TEST=1 python tests/ui_smoke.py
```

PowerShell equivalent:

```powershell
$env:JUNE_OFFLINE_TEST = "1"
python tests/ui_smoke.py
```

Test output goes to `test-results/`. The included `validation/results.json`
records the completed run. No fonts or third-party asset packages are bundled.
