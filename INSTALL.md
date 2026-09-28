# Install the workspace-tools update

Base: BigJMC9/June main at 7d79ac1db9eaa16f56e699daf42533202a49bb0c.
This archive is a source update, not a standalone installer.

1. Fully close June/Electron. Commit or back up local source changes.
2. Extract the archive and copy its contents into your existing June checkout,
   merging directories. Preserve electron/main.cjs, package-lock.json and LICENSE.
3. Run npm run dev. There are no new npm dependencies; the existing installed
   dependencies can be reused. Missing dependencies still require npm install.

The package main entry changes to electron/start.cjs, which registers features
and loads the original main.cjs. The updated preload and the new .mjs files must
be copied too. Refreshing only the renderer is insufficient; restart Electron.

## Manual desktop smoke test
- Confirm project selection, real files/previews, Git status and window controls.
- Open the June chat menu; rename/copy a chat. Export Markdown and PDF, testing
  cancellation before saving. Inspect the exported PDF for Unicode and long lines.
- Add a memory and a skill, approve the skill, restart, and verify persistence.
- Import a small TXT/JSON/SKILL.md file; verify nothing saves until review.
- Start Temporary, type a unique message and draft, end/restart. Confirm neither
  appears in normal history and the normal draft is restored.
- Choose a real model folder and scan. Check dependencies; missing executables
  should be reported honestly, never displayed as successful installations.

The code does not execute launch/download commands or run the custom agent.
