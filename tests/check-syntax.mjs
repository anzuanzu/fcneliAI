import {readFile} from 'node:fs/promises';
import {Script} from 'node:vm';
import {execFileSync} from 'node:child_process';
const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
let count = 0;
for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!match[1].includes('src=') && !match[1].includes('type="module"')) { new Script(match[2]); count++; }
}
for (const path of ['assets/iv-ui.mjs','assets/iv-import.mjs','assets/iv-engine.mjs','assets/historical-volatility.mjs','assets/fcn-model.mjs','assets/fcn-simulation-worker.mjs','worker/src/index.js','worker/src/options.js','worker/src/history.js']) {
  execFileSync(process.execPath, ['--check', new URL(`../${path}`, import.meta.url).pathname]);
}
console.log(`Syntax valid: ${count} inline scripts and all IV/Worker modules.`);
