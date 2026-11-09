# PDFy enhancement loop: state for the next session

Read this first, continue from "Next", then update this file.

## Done on 2026-11-06, second round (built and tested in the hidden browser)
- Full-screen page editor (Pages button), with a floating + for Insert PDF, Insert Image and Insert Page. Settings can switch the button back to the side list.
- The + beside the tabs: Browse file or Create document. Create document makes blank, lined, grid, dotted, graph, Cornell or music paper in common sizes, or a PDF from pictures (`src/ui/createdoc.ts`, a small hand-written PDF).
- Home screen (house button): recent files, recently closed (forgotten after 7 days), collections (`src/ui/home.ts`, `src/features/library.ts`). Only links to files are stored.
- Study mode merged into Edit. Settings window rebuilt (`src/ui/settings.ts`): theme gallery with live pictures, your own theme from five colours, Pen and tablet, Pages and moving around, Study tools, Quick setups (they no longer change the interface theme), General and help.
- Pen and tablet: pointer shapes, pen-only drawing, side button and eraser end, write straight away in Read, smoothing, Shift for straight lines, per-colour thickness and opacity, a test pad.
- Zoom and moving (`src/view/gestures.ts`): Ctrl+wheel and pinch at the pointer, middle-button drag, touch move and pinch, optional wheel-zooms.
- Read picture now lays invisible selectable text instead of yellow boxes; the words are searchable for the session.
- Voice notes: recorder with level meter and listen-back; one-click player that also works after saving and reopening.
- Forms: fields made in PDFy are fillable in Read and their values are saved; "How forms work" explainer; a notice when a PDF holds a form.
- Bookmarks: toolbar button, Ctrl+B, ribbon on bookmarked pages, page numbers in the list.
- Feature guide (`src/ui/guide.ts`): 12 illustrated steps, first start and once after each update (raise GUIDE_VERSION).
- Fixed: I did nothing when the keyboard was left in the Thickness box.
- Deleted 1.2 GB of old test browser profiles from Temp, 11 MB of old test output and 53 MB of .NET build scraps (host/bin, host/obj; recreated by dotnet publish when the host changes).
- Codex (gpt-6.1-sol, extra high) reviewed everything twice. First pass: 12 findings, all fixed with a test each. Second pass confirmed 9 fully fixed and found 3 loose ends (form-wide redraw flag, radio ticks after redraw, Undo across pages), all fixed and tested; no third pass was run (moved voice note kept its sound, typed answer kept on Ctrl+S, Ctrl+Z blocked in number boxes, saved answers drawn, bookmarks survive saving, radio questions, and smaller ones).
- Tests on 2026-11-06: engine 26, features 60, interface 30, commands 22, study 26, update 22. All passed then; on 2026-11-08 five of them fail (see below).

## Done on 2026-11-08
- One window: opening a PDF from Explorer while PDFy runs hands it to the open window as a new tab and brings that window forward; the second launch quits in about 0.1 s (`host/SingleInstance.cs`). The lock is per data folder, so tests with `PDFY_TEST_DATA_DIR` run beside the owner's open PDFy. This also removes the "could not start" errors (0x8007139F) in the old log, which come from two copies sharing one engine folder.
- Several files opened together, or dropped together, open A–Z in Explorer's order ("Part 2" before "Part 10"). Files handed over by Windows now open one after another, so tab order holds.
- Crash log (`host/CrashLog.cs`, `%LOCALAPPDATA%\PDFy\pdfy.log`): page errors (max 20 a minute, repeats counted), engine crashes with the code in words and the last memory reading, memory crossing each whole GB or the computer under 10% free, starts that fail, messages shown to the owner, sessions that did not close normally plus Windows' own crash note. The log moves to `pdfy.old.log` at 512 KB instead of being wiped. Engine crash dumps (~6.5 MB each) are kept to the newest 4.
- Minimise now sends Windows' own minimise command after the click finishes, and the engine's memory trim waits 2 s so it does not run during the animation. The owner reported the window sliding to the right edge; this could not be reproduced on film (what was seen was the normal shrink into the taskbar icon), so it is not confirmed fixed.
- `host-test.mjs` and `study-host-test.mjs` accept `PDFY_EXE=<path>`. New `tests/instance-test.mjs` (14 checks, real exe).
- Tests: instance 14/14, host 22/22, study exe 17/18, features 60/60, interface 30/30, update 22/22, commands 20/22, study 23/26. The 6 failures also fail with today's changes undone or on the old exe: commands "Open: ribbon button…" (history entry could not be saved) and "Save writes to the file…" (history does not start fresh), study "Font picker", "Colour picker", "Review: Enter on a font", and study exe full screen ("not granted" when the test window is not in front).
- Old log: engine crashes were all code 0x80000003 (the engine stopping itself on an internal check). Some may come from tests that force crashes without their own data folder. The computer had only about 2 GB of 16 GB free during today's tests.

## Meletiq PDF update installed on 2026-11-08
- Switching tabs restores each document's reading position, zoom and page layout.
- Collections now appear as coloured, collapsible tab groups, with saved membership, rename/colour controls and drag-to-group.
- Build, typecheck and 63 relevant checks passed. Installed and hash-verified all 932 web files (45.3 MB), then reopened the app successfully. Previous web files are in `app/web-before-tabs-groups-20261108`.
- App source, assets and tests were pushed to `UI_Enhance`.

## Release update work on 2026-11-08
- Added a GitHub Releases updater: checks at startup/every six hours, verifies the archive and every app file, and applies after the normal save/close flow. Settings has automatic updates, Check for updates and Restart to update. Package installation keeps a previous-release backup and rolls back on failure.
- Every opening route sorts tabs in natural A–Z order while keeping collection groups together. Manual dragging still works after opening.
- Removed the titlebar light/dark shortcut. The selected appearance stays in Settings/View.
- Added a stable Windows app identity and a dedicated `Meletiq.ico` for the Start menu and existing pinned shortcuts, avoiding the stale executable-icon cache.
- Repository is public and release v0.2.0 is published (37.5 MB). All 94 relevant checks passed, including a complete public-release download/install/restart and Cancel on unsaved work. Installed and verified all 936 app files, retaining `.previous-release`.
- Start menu and pinned shortcuts use `Meletiq.ico` and `Meletiq.PDF`; the owner confirmed the eagle now appears in the taskbar menu.

## Formatted Markdown and wheel-click scrolling on 2026-11-09
- Version 0.4.0 adds middle-button toggle scrolling: click the wheel, move the pointer to control speed/direction, click again to stop. It stays inside its PDF pane and stops on tab changes, Escape or loss of focus.
- Markdown notes now open in a formatted editor with headings, bold/italic/underline, text colours, highlights, bullets, numbering, tasks, quote/code, undo/redo, note theme and size. Import .md and Source preserve the existing Markdown format; Done/outside click renders the finished note.
- Source mode retains equations, wiki links, callouts, tables and comments. Literal HTML and image Markdown remain inert while editing; only validated text-colour spans and underline are allowed as formatting. Added dependency licenses to the shipped web files.
- Typecheck/build, 26 unit checks, 9 formatted-editor checks, 7 auto-scroll checks, 18 editing/save regressions, 17 split-pane checks, affected study checks, 22 feature/settings checks, 20 real Windows-host checks and 7 package/rollback checks passed. Both full-window and narrow split-pane editor screenshots were checked. Published the 37.7 MB archive with 937 verified app files (47.4 MB installed).
- The real public 0.3.0→0.4.0 upgrade passed all 12 checks: download/digest verification, unsaved-work Cancel/retry, automatic restart, the new Markdown toolbar in the existing cached profile, previous-release backup, unrelated-document preservation and up-to-date status. The final editor check waits for the first page to finish loading.
- After the owner saved and closed the app, installed 0.4.0 through the verified update helper and hash-verified all 937 app files. `.previous-release` contains 0.3.0. Reopened the app successfully (PID 47904, responding, startup log confirms 0.4.0.0). Removed 188.6 MB of disposable upgrade-test installations; published archives and rollback files remain.

## Next
0. Side-by-side workspace shipped in v0.3.0. Both halves have their own selected document, tab bar, reading state and tools. Tabs can move between halves; toolbar/panels follow the selected pane. All 17 split-view checks, 17 Windows-host checks, typecheck/build, 26 unit checks and affected tab/library/session/reload regressions passed. Published the 37.5 MB release, verified the complete 0.2.0→0.3.0 upgrade with 12 checks (including new web assets in an existing profile), installed all 936 verified files and reopened the owner's app. `.previous-release` contains 0.2.0.
1. Future installations need the owner's Meletiq PDF closed; never close it for them. Version 0.4.0 is installed and tested.
2. Fix the 5 failing page tests listed above (history entries, font and colour pickers).
3. Ask the owner whether minimise still looks wrong after installing; if so, get a screen recording.
4. Try the pen settings with the owner's real graphics tablet, and pinch on a real touchpad: so far only simulated events were tested.
5. Ask the owner what "the cross option and a" meant for the tablet, if the new pointer choices do not cover it.
6. Ideas: pressure-sensitive strokes (needs a filled-outline stroke type), Xodo's "Extra window".

## Rules
Disk: ask before anything of 200 MB or more, and report sizes. Plain-language reports. Only mark things done after a test or a check by eye. Commit as the user, with no Co-Authored-By line.
