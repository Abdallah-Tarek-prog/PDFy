# PDFy design direction

> **Update 2026-11-06.** The owner changed direction after using Xodo side by side. PDFy now follows
> Xodo's structure: the same tool layout, Xodo's keyboard shortcuts, and a window with no Windows title
> bar. PDFy keeps its own colours. The rest of this file is the earlier "page margin" idea. It is kept as
> a possible later addition (notes level with their line), not as the plan.
>
> **Later on 2026-11-06.** The Study toolbar was merged into Edit, a full-screen page editor and a Home
> screen with collections were added, and Settings became a window with sections and theme pictures.
> README.md and FEATURES.md describe what is built.

**We will design completely new UI pages and a completely new look for PDFy, far from Xodo, Adobe Acrobat and similar editors. It must be unique, distinctive and good to use.** The ribbon goes. Every feature stays reachable.

Recorded 2026-11-05. Direction only: nothing here is built yet. Picture of it: [design/concept.html](design/concept.html), open it in a browser.

## The one idea: every page gets a margin

Each PDF page sits on a coloured desk with a **working margin attached to it**, divided by one thin red line, like a school exercise book. The margin belongs to the page, not the window, and scrolls with it. Whatever you make of a line stays beside that line.

What you see:
- You click "hierarchy". A marker runs over the word and the meaning opens under it.
- You press Keep in margin. The word and its Arabic move level with that line and stay there.
- A week later you scroll back. The meaning is waiting beside the line.
- The rail on the far right shows the whole file. Every coloured dash is a page you marked.

Why it suits studying from PDFs:
- Studying is going back and forth between a line and what you made of it. Other editors put that in a panel, a list, or a pop-up that vanishes.
- You stop losing the words you looked up. The second read is faster because the meanings are already there.
- The printed text stays clean. Nothing covers it unless you put it there.
- The idea has deep roots: Arabic manuscripts carried commentary (hashiya) in the margin beside the line it explained. We borrow the idea, not the ornament.

It pairs with the signature feature: **what you bring to the page takes the page's colours; what you think about the page stays beside the line.**

| Word used here | What it means |
|---|---|
| Desk | The window's coloured ground |
| Leaf | One PDF page plus its margin |
| Hand list | Short list of words on the left: what your mouse is holding |
| Strip | Small row of actions that appears at the thing you touched |
| Look-up line | The one search box. Finds tools, words, pages and text |
| Index | A full page listing every tool, like the back of a textbook |
| Page edge | The rail on the far right, showing the whole file |
| Slip | A small floating sheet, such as the dictionary |
| Pen colour | The colour of everything you wrote yourself |

## What replaces the ribbon

Nothing runs across the window. Four things, from most used to least:

1. **Strips, at what you touch.** Select text: Highlight, Look up, Comment, Copy, Edit text. Select a picture: Original, Match page, Light, Dark, Hold to compare, Crop. Click empty page: Note, Equation, Paste, Picture. Your eye never leaves the line.
2. **Hand list, always on the left.** Words, not icons: Read, Mark, Pen, Note, Math, Shape, Sign. The active one has a marker swipe and its options open underneath. Below: Contents, Marks. At the bottom: Pages, Send out, Index, Settings.
3. **Look-up line, Ctrl K.** One box for everything. Type "comp": Compress and Compare, the word "compiler" with its Arabic, and "3 places in this file". Enter runs the first.
4. **Index, F1.** Every tool on one page, by the job you want done, or A to Z. Limits sit next to the name, such as "PowerPoint: pages as pictures". The old shortcuts list is part of it.

Right-click menus stay, with the same actions as the strips. To make a file smaller without knowing where that lives: Ctrl K, type "smaller", Enter. About 3 seconds. Or Index, Send out, Smaller file.

Today's reading screen has about 48 clickable things (counted in `02-tab-home.png`). The new one has about 25.

| Feature group (FEATURES.md) | New home |
|---|---|
| Open, new, save, tabs, recent | File names at the top of the desk; Start; usual keys |
| Views, zoom, rotate view, full screen, day, sepia, night, text-only, read aloud | Words at top right; Index |
| Thumbnails, contents, bookmarks, layers, attachments, comment list | Pages; page edge preview; Contents; Marks. Layers and attachments show only if the file has them |
| Search with highlighted hits | Look-up line; hits become dashes on the page edge |
| Highlight, underline, strike, squiggly, pen, marker, eraser | Mark and Pen; strip on selected text |
| Text box, callout, sticky note, Markdown box, equation | Note and Math. Comments, replies and status live in the margin |
| Shapes, measure, stamps, signatures, digital ID | Shape and Sign |
| Picture, web link, pinned file, voice note | Strip on empty page |
| Move, recolour, layer order, align, delete, edit PDF text | Strip on the object or text; right-click |
| Merge, split, reorder, rotate, delete, insert, extract, crop, numbers, watermark, Bates | Pages |
| Forms: fill, create, detect, flatten | Fill and sign, which opens by itself on a form |
| Convert out, compress, PDF/A, print, notes out and in, flatten | Send out |
| Images, Office, web page, scan, HEIC, DICOM to PDF; Word editor; OCR | Start, "Make a PDF from"; OCR is offered on scanned pages |
| Password, redact, remove hidden information, compare, batch, properties, checks | Send out and Index. Redact is also a black marker |
| Paste and theme conversion, snip, convert all, convert pages | Strip on the picture; strip on empty page; Pages |
| Dictionary switch, read from picture | Under Read in the Hand list |

Every one is also in the Index and in the Look-up line.

## Every page and surface

**Start.** No drop box, no empty panels. One large item: your last file, shown with its margin. "You stopped on page 41 of 212. 12 words kept, 1 comment open." Enter puts you back on that line. Beside it: Open a file, Paste a picture (Ctrl V starts a new document), New blank pages, Make a PDF from. Below: recent files as real thumbnails. After a crash, the recovered file waits at the top: "Bring back your unsaved work."

**Reading.**
- Desk, Hand list on the left, leaf in the middle, page edge on the right. No status bar. The page number sits large at the top of each margin; click it to type a page.
- At 1366 wide the page is 790 px, about 100% of A4, with a 340 px margin. One key folds the margin to small ticks, and the page grows to about 1100 px.
- Two-page view puts margins on the outer sides, and folds them on small screens.
- Night is one word at top right. It changes desk, margin and page together. An option keeps the page white.

**Annotating.**
- Choose Mark, pick a marker, drag over text. The stroke has slightly uneven ends, like a real marker.
- Everything you add uses your pen colour, so printed text and yours never mix up.
- Comments sit in the margin level with their line, as plain writing. No bubbles, no avatars. Reply and Done sit under them.
- A tick on the red line marks each item. Hover it: a dotted thread draws to its word, which lights up. On a crowded page, items push down and the thread shows where each belongs.

**Dictionary pop-up.**
- Click a word. A slip opens under it and never covers that line: word, part of speech, UK and US pronunciation with play buttons, numbered meanings, and the Arabic, right to left, in larger type.
- Keep in margin, Longman and Oxford along the bottom. Longman and Oxford open the real page.
- The Words switch under Read turns lookup off. Then a click on a word only places the cursor.
- No entry: "No entry for this word", with Longman and Oxford still offered. Kept words collect under Marks as a word list for the file.

**Read text from picture.** Under Read, choose From picture and drag over an image. Each word it can read gets a thin yellow outline. Click one for the same slip. Nothing readable: "No text found here. Try a bigger area."

**Markdown box.** Click empty page, choose Note, type Markdown; its symbols show dimmed. Click away and it becomes formatted notes, like Obsidian. Double-click to go back. The strip on the box holds its set, font, size, colour and spacing. Arabic paragraphs flow right to left by themselves.

**Equation editor.** Choose Math and click the page. The object appears and a slip opens under it. Type LaTeX and the object changes as you type, so there is no separate preview. A palette offers common symbols plus fraction, power and subscript. A typing mistake keeps the last good version, underlines the bad part and says what is wrong in one line. Click away: it stays a movable object.

**Paste with theme conversion, the signature moment.** Ctrl V. The picture lands under the last paste, and a line sweeps across it as it takes on the page's colours, in about a third of a second. The strip sits on the picture: Original, Match page, Light, Dark, style, Keep photos, Hold to compare, Crop, On paste. Hold to compare runs the sweep back; drag the line to compare any part. Today's bar across the window and its toast both go.

**Pages.** All pages laid out on the desk; Bigger and Smaller set the size. Drag to reorder. Coloured tabs mean you marked that page. Choose pages and a row appears: Rotate, Duplicate, Extract, Delete, Insert, Crop, Numbers, Watermark. Click a gap between pages to cut; one cut makes two files. Drop another PDF here to merge; its pages arrive tinted until placed.

**Forms and signing.** On a form, fields get a soft yellow underline and the margin says "6 of 14 filled", listing what is missing. Tab moves between fields. Make fields: PDFy proposes dashed boxes from blank lines, click to accept. Saved signatures wait in the margin; drag one onto the page. A digital signature, including making your own ID, is plain steps in the margin.

**Send out.** A full page asks "What should this become?" Word, Excel, PowerPoint, Images, Text or HTML, PDF/A, A smaller file, A locked file, A clean file, Paper. Every row says what you will and will not get, in the same honest words as FEATURES.md. Pick one, see its few options, press one button. The PDF stays untouched and the new file goes next to it. "Do this to many files" uses the same page with a file list.

**Protect and check.** A locked file warns that a lost password cannot be recovered. Black out warns first: "This page becomes a picture, so the text is truly gone." Search and black out lists every hit in the margin to untick. Compare shows two leaves side by side, with differences as dashes on the page edge. The accessibility and PDF/A checks put results in the margin and say they are quick checks, not formal ones.

**Word editor.** The same leaf and desk, with a strip at the cursor for headings, lists and tables. One line up front says headers, footnotes and tracked changes are not kept.

**Settings and one-click sets.** Settings slide over from the right; the open page stays visible and changes live. At the top: Study notes, Exam revision, Clean report, Night reading, each shown as a real sample page. Click one and the file changes at once, with Undo right there. Below that: lookup and pronunciation, note fonts and spacing, pen and marker colours, On paste, desk colour, margin side. Save your own set. Memory figures move to About.

**Font and colour pickers.** Fonts: every Windows font plus added files, each name in its own letters, with tabs Favourites, All, Added, With Arabic. Star to keep at the top; fonts load as you scroll to them. Colours: square, hue bar, hex box, eyedropper, then Markers, On this page and Saved. One line says if the text stays readable: "On this page: 9.0 to 1, easy to read."

**When things go wrong.** Messages appear where you acted, in plain words, with the way out. No toasts, no red banners. Damaged file: "This file is damaged and could not be opened. Your other files are fine." Save failed, beside the file name: "Not saved. Your work is safe." plus Save somewhere else.

## The visual system

**The feeling.** A study desk at night: bottle-green desk, clean sheet, one red margin line, one fluorescent marker. The real setting is a laptop in the evening, hours at a time, with screenshots of every colour. So Day and Night are equals.

**Type.** All free to ship. Licences are from memory: check each file when it is added.

| Voice | Used for | Font | Sizes |
|---|---|---|---|
| Tools | Hand list, strips, menus | Alegreya Sans, 500 and 700 | 19, 16.5, 14.5 px |
| Reading | Headwords, margin notes, large page words | Alegreya | 15.5 body, 28 headword, 38 to 46 large |
| Arabic | All Arabic text | Noto Naskh Arabic | 1.35 times the English beside it |
| Pronunciation | IPA only | Charis SIL | 13 to 14.5 px |
| Source | Raw LaTeX and Markdown | JetBrains Mono | 12.5 to 13.5 px |
| Equations | The equation itself | MathJax's own drawing, which is shapes, not a font | Follows the object |

Use words, not icons, for tools. Nothing goes below 13 px. Page numbers and zoom use straight, equal-width digits. Never letter-space Arabic, and never set it in italic.

**Colour.** Green owns the window. Yellow means "on". Red appears only as the margin line and the unsaved dot. The numbers are contrast against the ground, computed; 4.5 to 1 is the minimum for text.

| Surface | Night: ground, text, quiet text | Day: ground, text, quiet text |
|---|---|---|
| Desk | `#103B2E`, `#E6F2E7` 10.8, `#A8CFBA` 7.3 | `#BAD7C3`, `#0C2C22` 9.7, `#2C5243` 5.7 |
| Search field | `#0B2C22` | `#F2F7F1` |
| Page | `#0F1513`, `#DCE5DF` 14.4, `#97A99F` 7.5 | `#FFFFFF`, `#1B211E` 16.4, `#5A6A61` 5.7 |
| Margin | `#17211D`, `#E6EDE8` 13.9, `#A0B3A8` 7.5 | `#F2F6EF`, `#17231D` 14.8, `#55675D` 5.5 |
| Slip | `#1E2B26`, `#EEF4EF` 13.2, `#A9BCB1` 7.4 | `#FFFFFF`, `#16211C` 16.6, `#586A60` 5.8 |

| Accent | Night | Day |
|---|---|---|
| Marker, the "on" colour; text on it `#14231C` | `#EEF24A` (13.5) | `#F7EE2C` (13.4) |
| Margin line | `#FF7A6B` | `#E8483F` |
| Pen colour, on page | `#A9C4FF` (10.6) | `#1F3FA8` (9.0) |
| Note tint | `#151E2B` | `#F1F5FF` |

- Five markers for your own marks: yellow `#F7EE2C`, pink `#FF8FB5`, blue `#7CC9FF`, green `#8CE99A`, orange `#FFB35C`. At night they become soft washes, about 26% strength, and the word in focus goes solid.
- By day the marker barely stands out from the desk (1.3 to 1). So "on" always turns the word bold as well. Never colour alone.
- Sepia, not drawn yet: page `#F6EFDF`, margin `#EFE7D3`, text `#2A241A`. Desk colour is a setting: Green by default, Graphite as the quiet choice (`#2A2F2D` night, `#D9DEDA` day). Both are guesses.

**Spacing and shape.** Steps of 4, 8, 12, 16, 24 and 40 px: tight inside a group, wide between groups. Clickable words are at least 28 px tall. Sheets have 3 px corners. Slips have 12 px corners and one soft shadow, no border. A swipe (the active word or the main button) has uneven corners, like a marker stroke. No cards inside cards, no pills. The look is type, lines and flat colour only: no illustrations, textures or image files.

**Motion.** PDFy draws without the graphics card and must scroll above 60 frames a second. So no blur, no glass, and nothing animates across the whole window. Only these moments move. With Windows "reduce motion" on, they become instant.

| Moment | What moves | Time (starting guess) |
|---|---|---|
| Click a word | Marker sweeps over it, then the slip fades in | 120 + 120 ms |
| Keep in margin | Slip shrinks into the margin, thread draws | 180 ms |
| Theme conversion | Line sweeps across the picture, once the result is ready | 350 ms |
| Tool change | Swipe moves to the new word | 100 ms |

## Do not copy

- A ribbon, or any row of category tabs over a row of tools. Icons with captions in grouped rows.
- A left strip of small icons opening a thumbnail panel. A status bar with page and zoom boxes.
- A neutral grey canvas behind the page.
- A brand-red or corporate-blue accent. Today's red logo tile goes too; the half-circle mark stays.
- An "All tools" page of icon tiles. A floating pill toolbar at the bottom of the page.
- Comment bubbles with avatars and timestamps in a side panel.
- Modal boxes over a grey film for everyday tools. Toasts in a corner.
- A dashed drop box and empty panels on the start page.
- Our own traps: parchment, arabesques or manuscript ornament; cream paper with terracotta; near-black with neon glow.

## UX rules to test against

Each can be checked by a person looking at the screen.

1. On the reading screen at rest, count what can be clicked: 25 or fewer. Today is about 48.
2. Everything in the margin is level with its line, or a thread shows where it belongs.
3. The dictionary slip never covers the line holding the word.
4. Give someone new three tasks ("make this smaller", "add page numbers", "sign this"). They find each in under 15 seconds, by typing or through the Index.
5. Everyday tools never dim the window. The only dialogs allowed: Windows file pickers, passwords and the digital ID.
6. Apart from your own marks and pictures, the only bright colour is the marker. Red appears only on the margin line and the unsaved dot.
7. In greyscale, the active tool is still obvious, because it is bold too.
8. Every message appears within a hand's width of where you acted, and nothing appears at the bottom of the window.
9. Limits show before you commit, not after. After any one-click change, Undo is visible in the same place.
10. Arabic is never reversed or broken, and English words inside an Arabic line stay in order.
11. With Words off, clicking a word opens nothing, and the switch shows off.
12. Every screen is checked in Day and in Night, and nothing disappears in either.
13. One key folds the margin. The page grows at once and the ticks remain.
14. Reopen a file after a month: within 3 seconds you can tell where you stopped.
15. Speed stays as it is today: 3,000 pages open in about 0.3 s, and scrolling stays above 60 frames a second with a full margin.

## Keyboard and accessibility

- Everything works without a mouse. Tab order: Look-up line, Hand list, things on the page, then the margin.
- Single keys work outside text boxes: R Read, M Mark, P Pen, N Note, = Math, S Shape, G Sign, W word lookup on or off, \ fold the margin.
- Ctrl K opens the Look-up line, F1 the Index. Esc closes a slip and returns to the word. On the dictionary slip, 1 plays UK, 2 plays US and K keeps it. Today's keys stay: Ctrl V, Ctrl Z, Home, End, Space to pan, Ctrl A, Ctrl with the wheel.
- Focus is a clear 2 px ring in the text colour, in every look.
- Margin items are read out with their place: "Kept word, hierarchy, page 41." Not yet tried with Narrator.
- All text is at least 4.5 to 1, computed above. The margin line is decoration, and no meaning depends on it alone.

**Right-to-left Arabic.**
- Each paragraph takes its direction from its first strong letter, in notes, comments and dictionary alike. Arabic aligns right; pronunciation and numbers stay left to right inside it.
- On a mostly Arabic PDF the margin moves to the left of the page. It can also be set by hand.
- The interface stays English for now. If it ever becomes Arabic, the layout mirrors: Hand list on the right, page edge on the left. Plan for that; do not build it yet.
- Finding tools by typing Arabic needs Arabic names for about 150 tools. Not done yet, and your call.

## Build order

Each slice can ship by itself. Riskiest first.

| # | Slice | Why here | Ships when |
|---|---|---|---|
| 1 | Margin on real files inside today's app, behind a switch: Keep in margin, comments at their lines | The whole idea rests on it, and it can still fail | Above 60 frames a second on the big test file; zoom, rotated pages and two-page view behave |
| 2 | Look-up line and Index, with the ribbon still there | Proves every feature has a findable name | Every ribbon command runs from the Index; the three-task test passes |
| 3 | Hand list and strips, ribbon off behind a switch | The biggest change of habit | The command and mouse tests pass on the new layout |
| 4 | New look: fonts, colours, Day, Night, Sepia | Cheap once the layout is right | Readable at 100% Windows scaling; added size measured |
| 5 | Start and Pages | Standalone, low risk | Resume works; cutting and merging tested |
| 6 | Send out, Fill and sign | Many features, little new behaviour | Every conversion runs from the new page |
| 7 | Settings, sets, font and colour pickers | Depends on the look | Sets change a live page, with Undo |
| 8 | Remove the ribbon and the old look | Only once nothing needs them | Full test suite passes |

The surfaces being built now (dictionary, equation, Markdown, pickers, sets) can ship in today's look and get re-dressed in slice 4. Keep their controls attached to the object, not in the ribbon, so that little has to move.

## What is checked and what is a guess

**Checked.**
- The concept page, by eye, in Edge at 1400 px wide: Night, Day, Start, Index, Pages, Send out and the close-ups.
- The contrast figures, computed from the hex values above.
- Sizes: the 790 px page and 340 px margin, drawn at 1366 wide. Today's page is 1026 px wide in the 1374 px window of `02-tab-home.png`, with the Pages panel open.

**Guesses, and how to settle them.**
- That the margin stays smooth with no graphics card on 3,000 pages. Slice 1 measures it.
- That a page 23% narrower than today, with the margin open, still reads well. Folded, it is about 8% wider than today. Only real reading will tell.
- How the margin behaves at zooms wider than the window. The plan is that it folds and the ticks open slips. Untested.
- That kept words can be saved inside the PDF as ordinary notes, so other apps show them as sticky notes. Untested. It also needs a decision about whether margins print.
- That words are faster to learn than icons. The task tests in slices 2 and 3 settle it.
- That a green desk stays comfortable for hours. Live with it for a week; Graphite is the way out.
- The fonts, none of which has been seen in this design. The concept page uses Windows stand-ins (Candara, Sitka, Sakkal Majalla, Cascadia Mono) because nothing was downloaded. Alegreya Sans may need 1 px more at 100% scaling; Atkinson Hyperlegible Next is the fallback.
- That Charis SIL covers all the IPA symbols. Known from memory; check it. Fonts should add 1 to 2 MB to the app, which is 49 MB today, about half of it the offline dictionary. Not measured.
- All motion timings, which are starting values.
- The sample words, IPA and Arabic in the concept page. They were written for the picture and not checked against a dictionary.
- The cost of moving the tests. The 22 command tests drive the ribbon, and a few mouse tests and the screenshot run use it. They need re-pointing in slice 3.

**New behaviour beyond FEATURES.md, each your call.** Kept words in the margin with a word list for the file. Resume at your last line on Start. The page edge showing marks across the file. Click a gap to cut pages. One search box for tools, words and text.
