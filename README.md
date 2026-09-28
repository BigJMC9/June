# June UI Prototype

A lightweight Odysseus-inspired frontend shell for an AI coding workspace.

## Included

- Project switcher with persistent active project
- New chat and search / command palette
- Chat session list
- Project / repository / branch context
- Conversation-first AI workspace
- Agent activity cards
- Coding composer with Agent mode
- Changes / Files / Runs workbench
- Responsive sidebar behavior
- Keyboard shortcuts: `Ctrl/Cmd+K`, `Ctrl/Cmd+N`, `Esc`

## Run

Open `index.html` directly, or serve the directory with any static server.

Example:

```bash
python -m http.server 8080
```

Then visit `http://localhost:8080`.

## Backend integration seams

The frontend is intentionally framework-light. Replace the placeholder send flow in `app.js` with your agent backend:

- `POST /api/chats`
- `POST /api/runs`
- SSE/WebSocket stream for agent events
- `GET /api/projects`
- `GET /api/projects/:id/files`
- `GET /api/runs/:id/changes`
- patch approval / apply endpoints

The current UI already separates project context, chat state, file changes, and run status, so those can be wired without changing the layout model.


## Desktop integration

The Electron shell currently provides:

- Native application window
- Single-instance behavior
- Secure context-isolated preload bridge
- Native project-folder picker
- External HTTP/HTTPS links opening in the system browser
- Windows NSIS packaging
- macOS DMG/ZIP packaging
- Linux AppImage packaging

The renderer does not receive direct Node.js, filesystem, shell, or child-process access. Add privileged desktop capabilities as explicit IPC methods as the local agent/backend is implemented.
