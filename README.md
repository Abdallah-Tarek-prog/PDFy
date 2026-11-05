# PDFy

A PDF editor for Windows. Everything Xodo does is the goal, plus pasting images and converting
their theme between light and dark, and study tools: a dictionary with Arabic, equations, and
Markdown notes. See [FEATURES.md](FEATURES.md) for what works today.

## Next: a completely new look

**We will design completely new UI pages and a new look for PDFy, far from Xodo, Adobe Acrobat
and similar editors. It must be unique, distinctive and good to use.** Today's ribbon is a
stand-in. The direction is in [DESIGN.md](DESIGN.md), with a picture of it in
[design/concept.html](design/concept.html). Nothing in it is built yet.

## Run it

Double-click `app/PDFy.exe`. To open a file directly, use "Open with" in Explorer and pick that exe.

Needs the .NET 10 Desktop Runtime and the WebView2 runtime. Windows 11 already has WebView2.

To add PDFy to the Start menu and to "Open with" for PDF files, for your Windows user only:

```bash
powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

`scripts/uninstall.ps1` removes that again.

## Which part does what

| Part | Job | Where |
|---|---|---|
| Windows window | Native window, opens files, restarts the engine after a crash | `host/` |
| Page drawing | pdf.js, reads files in pieces on demand | `src/core/engine.ts`, `src/view/viewer.ts` |
| Saving | pdf-lib, in a background worker that stops when idle | `src/workers/edit.worker.ts` |
| Theme conversion | Our own engine, in a background worker | `src/theme/engine.ts` |
| Crash recovery | Writes edits to a local database a few seconds after each change | `src/features/recovery.ts` |
| OCR | Tesseract, loaded only while it runs | `src/features/ocr.ts` |
| Study tools | Dictionary, read from picture, equations, Markdown notes, fonts, colours, preference sets | `src/study/` |
| Notes and equations in saved files | Printed by the engine into a small PDF, placed as real vector text | `src/study/box.ts`, `host/Program.cs` |
| Offline dictionary | Wiktionary data, split into small files that load on demand | `vendor-dict/`, built by `scripts/build-dictionary.mjs` |
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
| `node tests/browser-run.mjs --commands` | Every ribbon command through its real dialog |
| `node tests/browser-run.mjs --study` | Study tools: equations, Markdown, dictionary, read from picture, fonts, colours, sets |
| `node tests/study-host-test.mjs` | Study tools in the real `PDFy.exe`: vector saving, Windows fonts, the reference window |
| `node tests/browser-run.mjs --visual` | Screenshots of each screen, into `tests/output/shots` |
| `node tests/host-test.mjs` | The real `PDFy.exe`, including a forced crash |
| `node tests/clipboard-test.mjs` | Real Ctrl+V in the real exe. Briefly uses your clipboard, then restores it |
| `node tests/real-web-test.mjs` | Theme conversion scored against real websites |
| `node tests/bigfile-test.mjs` | Real memory on a 144 MB file, which is deleted afterwards |
| `node tests/scroll-test.mjs` | Scrolling smoothness in the real exe |

Copy `dist` to `app/web` before the two exe tests. `node tests/make-fixtures.mjs` and
`node tests/make-office-fixtures.mjs` recreate the test files.
