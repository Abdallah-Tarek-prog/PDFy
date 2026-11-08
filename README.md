# Meletiq PDF

A PDF editor for Windows. Everything Xodo does is the goal, plus pasting images and converting
their theme between light and dark, and study tools: a dictionary with Arabic, equations, and
Markdown notes. See [FEATURES.md](FEATURES.md) for what works today.

## How it is laid out

Like the Xodo app: a title bar with the window buttons (there is no Windows title bar), one toolbar row
with two modes, Read and Edit, and an Actions menu with every document tool and a search box. Edit holds
the markup tools and the study tools together (Markdown notes, equations, Read picture, word lookup).
The keyboard shortcuts are Xodo's, and F1 lists and changes them.

Beside the document tabs: the house button opens Home (recent files, documents closed in the last 7 days,
and collections), and the + opens a file or creates a document. Settings (under More) has Appearance,
Pen and tablet, Pages and moving around, Study tools, Quick setups, and General and help. A feature
guide opens on the first start and once after each update.

Each document tab keeps its page, scroll position, zoom and layout when you switch away and return.
Collections appear as coloured, collapsible tab groups. Right-click a group to rename it, change its
colour or close its open tabs; drag a document into a group to add it.

## Run it

Double-click `app/PDFy.exe`. To open a file directly, use "Open with" in Explorer and pick that exe.

Needs the .NET 10 Desktop Runtime and the WebView2 runtime. Windows 11 already has WebView2.

To add Meletiq PDF to the Start menu and to "Open with" for PDF files, for your Windows user only:

```bash
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

`scripts/uninstall.ps1` removes that again.

## Which part does what

| Part | Job | Where |
|---|---|---|
| Windows window | Native window, opens files, restarts the engine after a crash | `host/` |
| One window | A second launch hands its files to the open window and quits | `host/SingleInstance.cs` |
| Crash log | Every kind of failure, with memory at the time, in `%LOCALAPPDATA%\PDFy\pdfy.log` | `host/CrashLog.cs` |
| Page drawing | pdf.js, reads files in pieces on demand | `src/core/engine.ts`, `src/view/viewer.ts` |
| Saving | pdf-lib, in a background worker that stops when idle | `src/workers/edit.worker.ts` |
| Theme conversion | Our own engine, in a background worker | `src/theme/engine.ts` |
| Crash recovery | Writes edits to a local database a few seconds after each change | `src/features/recovery.ts` |
| OCR | Tesseract, loaded only while it runs | `src/features/ocr.ts` |
| Toolbars and menus | The Xodo-style rows, the More overflow, the Actions menu with search | `src/ui/chrome.ts`, `src/app.ts` |
| Keyboard shortcuts | Xodo's keys, matched by key position, and the editor | `src/ui/shortcuts.ts` |
| Window frame | No Windows caption, resize at every edge, header buttons | `host/FramelessWindow.cs` |
| Themes | Thirteen interface themes, with matching live previews and custom themes | `public/themes.css`, `src/ui/themes.ts` |
| Study tools | Dictionary, read from picture, equations, Markdown notes, fonts, colours, quick setups | `src/study/` |
| Page editor | All pages full screen: tick, rotate, delete, insert, drag to reorder | `src/ui/pageeditor.ts` |
| New documents | Blank, lined, grid, dotted, graph, Cornell and music paper, written as a small real PDF | `src/ui/createdoc.ts` |
| Home and library | Recent files, recently closed (7 days), collections. Keeps links to files only | `src/ui/home.ts`, `src/features/library.ts` |
| Settings | The Settings window, theme gallery and your own theme | `src/ui/settings.ts`, `src/ui/themes.ts` |
| Feature guide | The illustrated tour | `src/ui/guide.ts` |
| Voice notes | Recording with a level meter, and the player | `src/ui/voice.ts` |
| Moving around | Ctrl+wheel and pinch zoom, middle-button drag, touch | `src/view/gestures.ts` |
| Pen and tablet | Pen buttons, pen-only drawing, pointer shapes, per-colour sizes | `src/view/tools.ts` |
| Notes and equations in saved files | Printed by the engine into a small PDF, placed as real vector text | `src/study/box.ts`, `host/Program.cs` |
| Offline dictionary | Wiktionary data, split into small files that load on demand | `vendor-dict/`, built by `scripts/build-dictionary.mjs` |
| Publishers' pages | The Windows app reads the Cambridge, Oxford or Longman page for a looked-up word. PDFy takes out the words, pronunciations and recording addresses and lays them out again | `host/Program.cs`, `src/study/publishers.ts` |
| Equation engine | MathJax, loaded the first time an equation is needed | `vendor-math/` |

## Build

```bash
npm install
```

```bash
npm run build
```

```bash
dotnet publish host/PDFy.Host.csproj -c Release -r win-x64 --self-contained false -p:PublishSingleFile=true -p:DebugType=none -o app
```

Then copy `dist` to `app/web`.

The dictionary in `vendor-dict` is already built. To rebuild it from the newest Wiktionary data
(streams about 3 GB, stores nothing large, takes about 30 minutes):

```bash
node scripts/build-dictionary.mjs vendor-dict
```

## Test

```bash
npm test
```

| Command | What it tests |
|---|---|
| `npm test` | Theme engine and geometry, no browser |
| `node tests/browser-run.mjs` | Every feature, in a hidden Edge window |
| `node tests/browser-run.mjs --ui` | Real mouse and keyboard, in a hidden Edge window |
| `node tests/browser-run.mjs --commands` | Every toolbar and menu command through its real dialog |
| `node tests/browser-run.mjs --study` | Study tools: equations, Markdown, dictionary, read from picture, fonts, colours, sets |
| `node tests/browser-run.mjs --update` | The 2026-11-06 additions: pen shortcut, colours, Read picture, voice notes, bookmarks, new documents, page editor, zoom, pen settings, Settings, forms, library, guide |
| `node tests/browser-run.mjs --fixture forms-review-tests.js` | Form state, radio answers across pages, blank dropdowns and saved list selections. Other review fixtures: `navigation-review-tests.js`, `input-review-tests.js`, `session-review-tests.js` |
| `node tests/browser-run.mjs --update-visual` | Screenshots of the new screens, into `tests/output/shots` |
| `node tests/browser-run.mjs --fixture ui-enhance-visual.js` | Theme and menu screenshots, plus menu/settings bounds at 640, 1024 and 1920 pixels |
| `node tests/study-host-test.mjs` | Study tools in the real `PDFy.exe`: vector saving, Windows fonts, the reference window |
| `node tests/browser-run.mjs --visual` | Screenshots of each screen and every theme, into `tests/output/shots` |
| `node scripts/check-themes.mjs` | Readability contrast of every theme |
| `node tests/host-test.mjs` | The real `PDFy.exe`, including a forced crash |
| `node tests/instance-test.mjs` | One window, A–Z order, crash log and minimise in the real exe. Runs beside an open PDFy. `PDFY_EXE=<path>` tests another build (also for the two tests above) |
| `node tests/clipboard-test.mjs` | Real Ctrl+V in the real exe. Briefly uses your clipboard, then restores it |
| `node tests/real-web-test.mjs` | Theme conversion scored against real websites |
| `node tests/bigfile-test.mjs` | Real memory on a 144 MB file, which is deleted afterwards |
| `node tests/scroll-test.mjs` | Scrolling smoothness in the real exe |

Copy `dist` to `app/web` before the two exe tests. `node tests/make-fixtures.mjs` and
`node tests/make-office-fixtures.mjs` recreate the test files.
The host and study-host tests use temporary profiles to preserve your settings, recent files and recovery data.
