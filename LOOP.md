# PDFy enhancement loop: state for the next session

Read this first, continue from "Next", then update this file.

## Done on 2026-11-06 (built and tested)
- Xodo-style frame: title bar with window buttons, Read, Edit and Study modes, Actions menu with search, More overflow, floating page and zoom controls, a floating style row, and tool tips at the bottom.
- Xodo's shortcuts (from the installed Xodo 6.3.4's XodoShortcuts.json), and the F1 editor.
- Multi-select (Ctrl+M) and lasso (Ctrl+L) tools.
- Frameless window, checked in the real exe: no caption, all edges resize, and maximised it fills the work area exactly.
- Nine interface themes, livelier note themes, and a contrast checker (scripts/check-themes.mjs).
- Test runner fix: it now closes its hidden Edge fully and refuses a busy port. Eight old runs had left browsers open.
- Tests: features 60, interface 30, commands 22, study 26, exe 22 + 18. All pass.

## Next
1. Fix what the Codex review of 2026-11-06 found (its report is in the session; rerun the review if needed).
2. Try moving the window by its header, double-click maximise, and Snap with a real mouse. Code in host/FramelessWindow.cs.
3. Ideas: a theme picker in Preferences with swatches; Xodo's "Extra window" (same document in a second window); per-tool style pop-up as in Xodo.

## Waiting for the user
- About 1.1 GB of leftover test-browser profiles in %TEMP% (folders named pdfy-edge-*). Deleting them was blocked by a permission check, so the user decides.

## Rules
Disk: ask before anything of 200 MB or more, and report sizes. Plain-language reports. Only mark things done after a test or a check by eye. Commit as the user, with no Co-Authored-By line.
