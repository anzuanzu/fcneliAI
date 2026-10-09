import {readFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {parseRows,saveSnapshot,SOURCE_URL} from './market-chameleon-iv30.mjs';
import {validateIV30,acceptIV30} from '../assets/current-iv30.mjs';

export function visibleSnapshot(capture,now=new Date()) {
  if(capture?.sourceUrl!==SOURCE_URL || !Number.isInteger(capture.expectedTotal) || capture.expectedTotal<1 || capture.expectedTotal>10000 || !Array.isArray(capture.headers) || !Array.isArray(capture.rows) || capture.rows.length!==capture.expectedTotal) throw new Error('IV30_CAPTURE_INCOMPLETE');
  const snapshot={schemaVersion:1,source:'Market Chameleon',sourceUrl:SOURCE_URL,ivUnit:'annualized-percent',observedAt:capture.observedAt,sourceAsOf:null,coverage:'volume-qualified-ranking',records:parseRows(capture.headers,capture.rows).sort((a,b)=>a.ticker.localeCompare(b.ticker))};
  validateIV30(snapshot,now);
  return snapshot;
}
export async function importVisibleIV30(capture,output) {
  const raw=visibleSnapshot(capture);
  let previous;
  try {previous=validateIV30(JSON.parse(await readFile(output,'utf8')));} catch(error) {if(error.code!=='ENOENT') throw error;}
  acceptIV30(previous,raw);
  await saveSnapshot(raw,output);
  return raw;
}
if(process.argv[1] && resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const capture=JSON.parse(await readFile(process.argv[2],'utf8'));
  const raw=await importVisibleIV30(capture,process.argv[3] || 'assets/current-iv30.json');
  console.log(`Validated ${raw.records.length} visible source rows; observed ${raw.observedAt}.`);
}
