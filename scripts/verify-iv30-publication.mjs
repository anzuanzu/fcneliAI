import {readFile} from 'node:fs/promises';
import {setTimeout} from 'node:timers/promises';
const files=['current-iv30.json','iv30-update-status.json'];
const expected=await Promise.all(files.map(file=>readFile(`assets/${file}`,'utf8')));
// Bounded verification includes the status file: stale data alone is not success.
for(let attempt=0;attempt<30;attempt++) {
  const results=await Promise.allSettled(files.map(async file=>{
    const response=await fetch(`https://anzuanzu.github.io/fcneliAI/assets/${file}?verify=${Date.now()}`,{cache:'no-store',signal:AbortSignal.timeout(10000)});
    if(!response.ok) throw new Error('IV30_PUBLICATION_HTTP_FAILED');
    return response.text();
  }));
  if(results.every((r,i)=>r.status==='fulfilled' && r.value===expected[i])) {
    console.log('GitHub Pages serves the expected shared snapshot and refresh status.');
    process.exit(0);
  }
  await setTimeout(10000);
}
throw new Error('IV30_PUBLICATION_NOT_CONFIRMED');
