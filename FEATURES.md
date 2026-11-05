# PDFy — Feature List

Goal: everything Xodo does, plus PDFy's own features, without crashing and with low memory use.
Adobe Acrobat is listed as the reference for what a full editor can do.

**Status key**

| Mark | Meaning |
|---|---|
| ✅ | Built and tested by running it |
| 🟡 | Works, with a limit stated in the row |
| 🔵 | Built, but no test has clicked through it yet |
| ⬜ | Not built yet |
| ☁️ | Needs an outside service, so not built |

Last updated 2026-11-06. See "How this was checked" at the end.

---

## 1. PDFy's own features (the reason this app exists)

| Feature | What the user sees | Status |
|---|---|---|
| Paste image directly | Ctrl+V drops a copied image onto the page. Tested with the real Windows clipboard in the real app | ✅ |
| Paste with no document open | A new document is created around the image | ✅ |
| Stacked pasting | Each paste lands under the last and flows to a new page when full | ✅ |
| Dark → Light | A dark screenshot becomes a real light version, on exact target colours | ✅ |
| Light → Dark | The same in the other direction | ✅ |
| Style targets | Gemini, ChatGPT, Claude, GitHub, VS Code, Neutral, Sepia. Gemini checked against its real public page. The others are from memory, not measured | 🟡 |
| Custom colours | Choose your own background, panel and text colours | ✅ |
| Match page | Picks light or dark from the page behind the image and matches its background | ✅ |
| Colours keep their meaning | Blue stays blue and red stays red, with readable contrast. Not a negative-photo invert | ✅ |
| Looks like the real theme | Compared with real sites in their real light mode. See the scores below | ✅ |
| Photos stay untouched | Photos inside a screenshot are found and left alone, including on JPEG screenshots | ✅ |
| Non-destructive | One click returns to the exact original until the document is saved | ✅ |
| Hold to compare | Hold a button to see the original | ✅ |
| Convert automatically on paste | Choose Keep, Match page, Light or Dark for all future pastes | ✅ |
| Convert all images at once | One step, one undo | ✅ |
| Theme snip | Drag over anything on a PDF page and convert that area | ✅ |
| Convert whole pages | Light or dark for a page range. Text underneath stays searchable | ✅ |
| Crop pasted image | Theme conversion still works afterwards | ✅ |

**How close a conversion gets to the real thing.** Real sites were captured in their real dark and light modes. PDFy converted one to the other, using the target's colours, and the result was compared pixel by pixel. The number is the average colour error from 0 to 255, where lower is better.

| Site | Before converting | Dark to light | Light to dark |
|---|---|---|---|
| Python docs | 207 | 3.2 | 2.7 |
| Gemini (public start page) | 217 | 4.6 | 11.3 |
| TypeScript handbook | 193 | 14.7 | 14.5 |
| MDN docs | 206 | 16.0 | 14.9 |
| GitHub | 209 | 23.0 | 27.8 |

What is left is mostly design choices no converter can guess, such as GitHub's folder icons being grey in dark mode and blue in light mode, or its header staying black in both. Gemini's conversation screen needs a sign-in, so only its start page has been compared.

---

## 1a. Layout, keys, window and themes (2026-11-06)

Laid out like the Xodo app installed on this PC (Xodo 6.3.4, the Microsoft Store version).

| Feature | What the user sees | Status |
|---|---|---|
| Xodo's layout | One toolbar row with icons and labels. **Read** has Open, Save, Print, Actions, Undo, Edit, Study, panels, View and More. **Edit** has Xodo's markup tools in Xodo's order. **Study** has the study tools. Close or Escape goes back to Read | ✅ |
| One Actions menu | Every document tool (pages, convert, protect and sign, forms, tools) in one menu with a search box. Ctrl+K opens it | ✅ |
| Nothing cut off | Tools that do not fit the window move into More | ✅ |
| Xodo's keyboard shortcuts | The same keys as the installed Xodo, read from its own shortcut list: H highlight, U underline, G squiggly, C sticky, I ink, M marker, E eraser, T text box, R square, O oval, L line, A arrow, S signature, K stamper, P pan, Ctrl+M multi-select, Ctrl+L lasso, Ctrl+R read aloud, Ctrl+1 to 9 for documents, F11 full screen | ✅ |
| Changing the shortcuts | F1 lists every shortcut, grouped as in Xodo. Change any key, see clashes, and reset to Xodo's keys | ✅ |
| Keys with an Arabic layout | Shortcuts follow the key's position, so they work while typing Arabic | ✅ |
| Multi-select and lasso | Drag a box, or draw a loop, around objects to select them together | ✅ |
| No Windows title bar | PDFy's own header holds minimise, maximise and close. All four edges and corners resize. Maximised, it fills the screen exactly. Checked in the real app on this PC at 125% scaling | ✅ |
| Moving and snapping the window | Drag the header to move it, double-click to maximise, Snap to screen edges. Built on Windows' own support, but not yet tried with a real mouse | 🔵 |
| Floating controls | Page number bottom left and zoom bottom right, as in Xodo. Style options float above the page only when something is chosen, so the page never jumps | ✅ |
| Interface themes | Slate (default dark), Midnight, Mocha, Dracula, Nord, Forest, Ember, Daylight (default light) and Paper, under View. All text passes the readability contrast check (at least 4.5 to 1; secondary labels at least 3.9 to 1) | ✅ |
| Livelier note themes | Refreshed dark Markdown note themes, plus Tokyo Night, Catppuccin, Dracula and Nord | ✅ |

## 1b. Study tools (added 2026-11-05)

All of these are under **Study** in the toolbar.

| Feature | What the user sees | Status |
|---|---|---|
| Equations | Type LaTeX with a live preview and a palette of symbols. It lands on the page as a movable, resizable object. Double-click to edit. Saved as sharp vector drawing, and stays editable after reopening | ✅ |
| Markdown notes | Click the page and type Markdown. Click away and it becomes formatted notes, like Obsidian: headings, bold, highlights, callouts, tasks, tables, code, equations. Double-click to edit the Markdown again | ✅ |
| Note themes | 8 ready-made looks. Every font, size, spacing and colour can be changed. Editing a ready-made one makes your own copy | ✅ |
| Notes in the saved file | The desktop app saves notes and equations as real vector text, the same as on screen. In testing, three boxes took 0.9 s to save, and 4 ms when unchanged | ✅ |
| Arabic in saved notes | Shows correctly, right to left, as real text. Copying it out of the saved PDF gives the joined letter shapes in display order, because that is how the print engine writes Arabic | 🟡 |
| Any installed font | The font picker lists every font on this PC, 365 on this one, each shown in its own letters. Star to keep at the top. Add your own font files; they are kept and embedded in saved files | ✅ |
| Any colour | Colour field, hue bar, hex and RGB codes, eyedropper for anywhere on screen, ready-made palettes, recent and starred colours | ✅ |
| Preference sets | One click sets fonts, colours, note look, reading mode and word lookup: Study notes, Exam revision, Clean report, Night reading, Arabic notes. Save your own | ✅ |
| Word lookup | Turn it on, then double-click or select a word. A pop-up shows UK and US pronunciation with play buttons, Arabic meanings right to left, and English meanings with examples. Also on the selection bar, the right-click menu and Ctrl+L | ✅ |
| Cambridge, Oxford and Longman inside the pop-up | When online, the pop-up reads each publisher's own page for the word and lays it out in tabs: headword, part of speech, level, UK and US pronunciation, numbered meanings with signposts, and examples. Cambridge English–Arabic adds an Arabic translation for each meaning. Oxford's other entries (such as the verb) are one click. In the real app each page took 0.45 to 0.75 s | ✅ |
| Open the publisher's page | One click opens the full page in a small PDFy window, plus Reverso example sentences and whole-sentence translation | ✅ |
| Pin to the side | The pop-up can stay open at the side of the window while you read | ✅ |
| Read text from a picture | Drag over a pasted screenshot, a scan or any part of a page. Each word found becomes a clickable spot right where it sits. Dark screenshots work: 84 words read from the test screenshot | ✅ |
| Hearing words | Online: the publisher's own recordings, including Longman's spoken example sentences; tested playing in the real app. Then Wiktionary's recordings. Offline: a Windows voice. This PC has US English and Arabic voices but no UK voice, so offline UK uses the US voice | ✅ |
| If a publisher changes its page layout | That tab shows "could not read this page" and offers to open it. The reader for that site then needs updating | 🟡 |

**How good the offline dictionary is.** Measured against lists of the most common English words.
Word forms such as "running" and "went" count as found when they lead to the right word.

| Words | Found | Pronunciation (IPA) | Real recording | Arabic from a translation table | Any Arabic |
|---|---|---|---|---|---|
| Top 1,000 | 99% | 98% | 97% | 86% | 90% |
| Top 5,000 | 98% | 94% | 92% | 73% | 81% |
| Top 10,000 | 95% | 89% | 86% | 65% | 74% |

- 497,000 entries in 23 MB. Built from Wiktionary (CC BY-SA 4.0) on 2026-11-05.
- "Any Arabic" adds meanings found by reading Wiktionary's Arabic entries backwards. The pop-up marks those as less certain.
- Words tagged with a dialect, such as Egyptian or Gulf, are shown apart from standard Arabic.
- **Accuracy, checked by reading.** In 40 random words from the top 5,000: 35 were clearly right,
  4 partly right (the right word with a weaker one first, or an untagged dialect form), and 1 wrong.
  This was my own reading, not a formal check.
- The Cambridge English–Arabic button, one click away, is the most reliable source for any single word.

---

## 2. Xodo features

Source: xodo.com tool list and the Xodo app store listings.

### Viewing and reading
| Feature | Status |
|---|---|
| Open with Windows "Open with" or the command line | ✅ |
| Open by file dialog and by drag and drop | ✅ dialog; 🔵 drag and drop |
| Multiple documents in tabs | ✅ |
| Continuous, single-page and two-page views | ✅ |
| Zoom: fit width, fit page, custom | ✅ |
| Zoom with Ctrl+wheel | ✅ |
| Rotate pages | ✅ |
| Thumbnails panel, click to jump, drag to reorder | ✅ |
| Outline (table of contents) | ✅ |
| User bookmarks, saved into the file's contents list | ✅ |
| Text search with highlighted results | ✅ |
| Text selection and copy | ✅ |
| Clickable links and internal jumps | ✅ |
| Night and sepia reading modes | ✅ |
| Reflow (text-only reading) view | ✅ |
| Read aloud | 🔵 |
| Full screen | ✅ |
| Right-click menus on pages, objects and thumbnails | ✅ |
| Shortcuts list (F1), Home, End, Space to pan, Ctrl+A for page text | ✅ |
| Recent files | ✅ |
| Print | Prepares every page with your edits. Sending to a real printer is not tested | 🟡 |
| Password-protected PDFs open | ✅ |
| Layers show and hide | ✅ |

### Annotating
| Feature | Status |
|---|---|
| Highlight, underline, strikeout, squiggly | ✅ |
| Freehand pen and marker | ✅ |
| Eraser | ✅ |
| Rectangle, ellipse, line, arrow | ✅ |
| Polygon, polyline, cloud | ✅ |
| Text box, with font, bold, italic | ✅ |
| Arabic, Cyrillic, Greek and other languages saved as real, selectable text | ✅ |
| Chinese, Japanese, Korean text saves as a sharp picture, so it is not selectable | 🟡 |
| Callout | ✅ |
| Sticky note comments | ✅ |
| Stamps, standard and custom | ✅ |
| Insert image | ✅ |
| Measure: distance, perimeter, area, with a scale | ✅ |
| Move, resize, recolour, delete | ✅ |
| Bring to front, send to back | ✅ |
| Select several objects, move, align and delete together | ✅ |
| Comment replies and review status, saved with the file | ✅ |
| Quick bar over selected text | ✅ |
| Edit annotations made in other apps | ✅ |
| Undo and redo | ✅ |
| Comments list | ✅ |
| Export and import annotations (XFDF) | ✅ |
| Flatten annotations, including ones from other apps | ✅ |
| Add web link | ✅ |
| File attachments, for the whole document | ✅ |
| File attachment pinned to a spot on a page | ✅ |
| Sound annotations | Voice notes record and pin to the page. They are stored as attached files, not the old PDF sound format, so other PDF apps open them as files | 🟡 |
| Real-time collaboration | ☁️ |

### Edit and pages
| Feature | Status |
|---|---|
| Edit PDF text. Covers a line with its background and types over it, in the closest standard font. The old text stays underneath unless redacted | 🟡 |
| Merge PDFs | ✅ |
| Split PDF, into a zip | ✅ |
| Delete, rearrange, rotate, duplicate pages | ✅ |
| Insert blank page, insert from PDF or image | ✅ |
| Extract pages | ✅ |
| Crop pages | ✅ |
| Compress PDF. 1.6 MB picture file became 0.2 MB in testing | ✅ |
| Redact, including search and redact. The page becomes a picture, so the text is truly gone | ✅ |

### Forms and signing
| Feature | Status |
|---|---|
| Fill in forms: text, checkbox, radio, dropdown, list | ✅ |
| Create form fields | ✅ |
| Auto-detect fields from blank lines and boxes | ✅ |
| Flatten forms | ✅ |
| Sign: draw, type or image, saved for reuse | ✅ |
| Certificate digital signature. Checked with openssl, which also rejects a tampered copy. Not yet tried in Acrobat | ✅ |
| Create your own digital ID | ✅ |
| Send for e-signature (Xodo Sign) | ☁️ |

### Convert
| Feature | Status |
|---|---|
| JPG, PNG and other images to PDF | ✅ |
| PDF to JPG or PNG | ✅ |
| PDF to Text | ✅ |
| PDF to HTML, with tables and pictures | ✅ |
| PDF to Word: headings, paragraphs, tables, pictures, in reading order. Page layout is simplified, so complex multi-column pages will not match exactly | 🟡 |
| PDF to Excel. Finds columns by where text lines up | 🟡 |
| PDF to PowerPoint. Each page is a picture on a slide, so text is not editable | 🟡 |
| Word to PDF. Headings, styles, lists, tables, pictures, right-to-left. Tested on a hand-built file, not yet on a file from Word itself | 🟡 |
| Excel to PDF. Tested the same way | 🟡 |
| PowerPoint to PDF. Text, pictures, shapes, layouts. No charts or SmartArt yet | 🟡 |
| OCR: scanned to searchable. English only so far | English, Arabic, French, German, Spanish, and Arabic with English. Arabic and English tested | ✅ |
| HEIC to PDF, JPG, PNG. Built, needs a real HEIC photo to test | ✅ |
| DICOM to PDF. Uncompressed scans only | 🟡 |
| PDF to PDF/A. Adds the label and colour profile. Fonts are not embedded yet, so strict validators may object | Adds the label and colour profile, and text you add uses embedded fonts. Fonts already in the original file are not changed, and no formal validator has checked it | 🟡 |
| Validate PDF/A. A quick check of the common requirements, not a formal validator | 🟡 |

### Compare, security, other
| Feature | Status |
|---|---|
| PDF compare: words and pictures, page by page | ✅ |
| Text compare | ✅ |
| Add or remove password (AES-256) | ✅ |
| Scan to PDF with a camera. Built, no camera to test with | Tested with a simulated camera only | 🟡 |
| Office viewer. Office files open as a converted PDF | 🟡 |
| DOCX editor | Text, headings, lists, tables, pictures, right-to-left. Page headers, footnotes and tracked changes are not kept | 🟡 |
| ASK PDF (AI questions about a document) | ☁️ |

---

## 3. Adobe Acrobat features beyond Xodo

Source: Adobe comparison material and third-party Acrobat Standard vs Pro comparisons.
Adobe's own matrix could not be fully read, so treat this list as close, not exhaustive.

| Feature | Status |
|---|---|
| Header, footer and page numbers | ✅ |
| Watermark | ✅ |
| Bates numbering | ✅ |
| Remove hidden information (metadata clean) | ✅ |
| Search and redact | ✅ |
| Edit document properties | ✅ |
| Batch actions on many files | ✅ |
| Form field auto-detect | ✅ |
| Create PDF from a web page | ✅ |
| Accessibility check. A quick check, no auto-tagging | 🟡 |
| Form scripting (JavaScript) | ⬜ |
| Preflight and PDF/X print production | ⬜ |
| PDF portfolios | ⬜ |
| Certificate-based encryption | ⬜ |
| Shared review tracking | ☁️ |
| AI assistant and generative summaries | ☁️ |

---

## 4. Reliability and memory

| Promise | Measured result | Status |
|---|---|---|
| Huge files open fast and are not loaded whole | 3,000 pages open in about 0.3 s. A 144 MB file opens in about 0.1 s | ✅ |
| Only visible pages use image memory | At most 4 pages live, 5.4 megapixels, while jumping around 3,000 pages. Page memory did not grow | ✅ |
| Extreme zoom stays safe | Whole-page canvas capped at 12 megapixels. Visible area stays sharp at 800% | ✅ |
| Interface never freezes on heavy work | Longest pause 7 ms during repeated theme conversion. 4K screenshot converts in about 70 ms | ✅ |
| Opening and closing returns memory | Memory did not grow over 12 open and close cycles | ✅ |
| Damaged files give a message, not a crash | Empty, fake and cut-off PDFs refused. Scrambled PDF repaired and opened | ✅ |
| Saved output is checked before replacing a file | Reopened, page count compared, and up to 3 pages (20 if the file looks damaged) compared with what was on screen | ✅ |
| Real-world PDFs | 1,055 odd and broken PDFs from the PDF.js test collection: 0 crashes, 0 hangs. 1,038 went through open, edit, save, reopen and compare. 11 need a password, 5 refused as broken, 1 page cannot be drawn. That full run was before the last two small fixes, which were rechecked on 15 of the files | ✅ |
| Files the save engine cannot read | Saved as page pictures with searchable text, and a note. Links, forms and bookmarks from the original are not kept | 🟡 |
| Failed save loses nothing | Tested by forcing a save to fail. Work stays safe, and it offers another place | ✅ |
| Work is recovered after a crash | Forced a crash in the real exe. The document came back, marked unsaved | ✅ |
| Engine crash is survived | Window stays open and reloads | ✅ |
| Closing asks about unsaved work | Tested in the real exe | ✅ |

**Honest numbers on size and memory**

- The app folder is about 49 MB. 23 MB of that is the offline dictionary and 2 MB the equation engine, both loaded only when used. It uses the WebView2 engine already in Windows 11.
- Memory for all of PDFy's processes together, not counting memory shared with Windows and other apps: 117 MB with nothing open, 160 MB with a normal document, 393 MB at peak with a 144 MB file, back to 150 MB after closing it.
- The app draws without the graphics card, which cut memory by about 40%. Scrolling stays above 60 frames a second: 165 normally, 123 in night mode, 80 zoomed to 300%. Measured on this PC.
- A fully native app would use less memory, but this was the way to get this many features tested in reasonable time.

---

## How this was checked

- **Theme engine and geometry:** 26 automatic tests (`npm test`).
- **Every toolbar and menu command through its real dialog:** 22 tests, with stand-ins only for Windows' own file pickers (`node tests/browser-run.mjs --commands`).
- **Features:** 59 tests run inside the app in a hidden Edge window. Most save a real file and read it back with a fresh engine (`node tests/browser-run.mjs`).
- **The real PDFy.exe:** 22 tests, including a forced crash, saving back to disk, and Office files through the real print engine (`node tests/host-test.mjs`).
- **By eye:** screenshots of the tabs, dialogs, panels and themes.
- **Real clipboard:** 6 tests of real Ctrl+V in the real app, for pictures and words (`node tests/clipboard-test.mjs`).
- **Signatures:** verified with openssl.

- **Memory and smoothness:** `node tests/bigfile-test.mjs` and `node tests/scroll-test.mjs`.
- **Real websites:** the theme scores above (`node tests/real-web-test.mjs`).
- **Real mouse and keyboard:** 25 tests that move the mouse, drag and type as a person would, including on rotated pages (`node tests/browser-run.mjs --ui`).
- **Study tools:** 26 tests in a hidden Edge window (`node tests/browser-run.mjs --study`), including reading the three publishers' live pages, and 18 in the real exe, including vector saving, the Windows font list, the publishers' pages and recordings, and the reference window (`node tests/study-host-test.mjs`). The live-page tests need the internet.

---

## The look

The layout now follows Xodo's, as asked on 2026-11-06: the same tool layout, the same keys and the same kind of window. The colours are PDFy's own themes. [DESIGN.md](DESIGN.md) records the earlier idea of a page margin for notes, which is not built.
