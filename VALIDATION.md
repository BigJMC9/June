# Validation

Latest source: 30 Node tests + 60 baseline renderer checks + 49 added renderer
checks passed. Syntax checks passed. Renderer flows had no uncaught JS errors.

## Exercised
Node tests use real temporary filesystem fixtures for GGUF/cache discovery,
external symlink exclusion, scan caps, save destination handling and cancellation.
Electron, executable version output and network responses are mocked. Other unit
tests cover scoped knowledge, approvals, import validation, safe command quoting,
compaction, export escaping, and temporary request-context construction.

Renderer tests use Chromium and Playwright with a simulated Electron bridge and
in-memory localStorage. The implemented DOM/CSS/event code is exercised for menus,
knowledge creation/approval/import, model configurations, context settings, export
requests, temporary chat/draft isolation and restoration, and responsive layouts.

A unique temporary message/draft sentinel was checked against all stored test
values. Temporary operations did not change persistent chat/draft/library values;
reload discarded ephemeral content and restored the normal session. Copy/export
requires a confirmation. The data-only context helper separately excludes all
memories/skills from temporary requests.

## Limits
The execution environment blocks ordinary localhost navigation. The renderer
suite uses about:blank and tests/renderer_loader.py to inline the ES modules for
render-only checks. This does NOT validate native ES-module loading, CSP, actual
Electron localStorage, clipboard, folder/save dialogs, OS window controls,
packaging or printToPDF. PDF export plumbing and HTML escaping were tested, not an
actual Electron PDF. Native platforms need the smoke test in INSTALL.md.

The original Electron project host is unchanged and not comprehensively audited.
This is not a security certification or a claim of provider-side private mode.
No agent backend is connected; model/tool/extraction behavior is not simulated.

## Running
npm test

For renderer tests, install Python Playwright and Chromium, then:
JUNE_OFFLINE_TEST=1 python tests/ui_smoke.py
python tests/features_ui.py

Test result JSON and Node test output are included under validation/.
