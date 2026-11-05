// Prints the results of the in-app feature test.
import { readFileSync } from 'node:fs';

try {
  const r = JSON.parse(readFileSync(new URL('./output/test-progress.json', import.meta.url), 'utf8'));
  console.log(`done ${r.done}, passed ${r.passed}, memory in use ${r.heapMB} MB`);
  for (const t of r.results) {
    console.log(`${t.ok ? 'ok  ' : 'FAIL'} ${t.name}${t.ms ? ` [${t.ms} ms]` : ''}${t.note ? ` :: ${t.note}` : ''}${t.error ? `\n       ${t.error}` : ''}`);
  }
} catch (err) {
  console.log('No results yet:', err.message);
}
