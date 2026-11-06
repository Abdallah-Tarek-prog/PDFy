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
- Tests: engine 26, features 60, interface 30, commands 22, study 26, update 22. All pass.

## Next
1. Run the two exe tests (`node tests/host-test.mjs`, `node tests/study-host-test.mjs`) with no PDFy window open. They could not run on 2026-11-06 because the owner had PDFy open.
2. Try the pen settings with the owner's real graphics tablet, and pinch on a real touchpad: so far only simulated events were tested.
3. Ask the owner what "the cross option and a" meant for the tablet, if the new pointer choices do not cover it.
4. Ideas: pressure-sensitive strokes (needs a filled-outline stroke type), Xodo's "Extra window".

## Rules
Disk: ask before anything of 200 MB or more, and report sizes. Plain-language reports. Only mark things done after a test or a check by eye. Commit as the user, with no Co-Authored-By line.
