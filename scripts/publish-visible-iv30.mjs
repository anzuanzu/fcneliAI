import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {importVisibleIV30} from './import-visible-iv30.mjs';
import {validateIV30} from '../assets/current-iv30.mjs';
const repo=resolve(fileURLToPath(new URL('..',import.meta.url)));
const failed=process.argv[2]==='--failed';
const capture=failed ? null : JSON.parse(await readFile(process.argv[2],'utf8'));
const temporary=await mkdtemp(join(tmpdir(),'fcneli-iv30-publish-'));
const checkout=join(temporary,'checkout');
const git=(args,cwd=repo)=>execFileSync('git',args,{cwd,encoding:'utf8'}).trim();
let attached=false;
try {
  // An isolated checkout leaves the user's working files and branch untouched.
  git(['fetch','origin','main']);git(['worktree','add','--detach',checkout,'origin/main']);attached=true;
  const output=join(checkout,'assets/current-iv30.json');
  const snapshot=failed ? validateIV30(JSON.parse(await readFile(output,'utf8'))) : await importVisibleIV30(capture,output);
  const status={schemaVersion:1,outcome:failed ? 'failed' : 'success',attemptedAt:new Date().toISOString(),lastSuccessAt:snapshot.observedAt};
  await writeFile(join(checkout,'assets/iv30-update-status.json'),JSON.stringify(status,null,2)+'\n');
  git(['add','assets/current-iv30.json','assets/iv30-update-status.json'],checkout);
  git(['commit','-m',failed ? 'Record failed IV30 refresh; preserve last successful snapshot' : 'Update shared IV30 from the visible public rankings table'],checkout);
  // A concurrent main update rejects this push; no force push or overwrite.
  git(['push','origin','HEAD:main'],checkout);
  execFileSync('gh',['api','--method','POST','repos/anzuanzu/fcneliAI/pages/builds'],{cwd:checkout,stdio:'inherit'});
  execFileSync(process.execPath,[fileURLToPath(new URL('./verify-iv30-publication.mjs',import.meta.url))],{cwd:checkout,stdio:'inherit'});
  console.log(failed ? 'Published failure status; last successful IV30 snapshot unchanged.' : `Published and verified ${snapshot.records.length} shared IV30 records.`);
} finally {
  if(attached) git(['worktree','remove','--force',checkout]);
  await rm(temporary,{recursive:true,force:true});
}
