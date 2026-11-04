import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root=fileURLToPath(new URL('../../../',import.meta.url));
function sources(directory) {
 return readdirSync(directory,{withFileTypes:true}).flatMap(entry=>{
  const path=resolve(directory,entry.name);
  return entry.isDirectory()?sources(path):/\.[cm]?[jt]sx?$/.test(entry.name)?[path]:[];
 });
}
test('the Console image builder copies every runtime JSON catalog imported by the web tree',()=>{
 const dockerfile=readFileSync(resolve(root,'console/api/Dockerfile'),'utf8').split(/^FROM /m)[1];
 const copied=new Set([...dockerfile.matchAll(/^COPY\s+(runtime\/data\/\S+\.json)\s+/gm)].map(match=>match[1]));
 const imported=new Set();
 for(const path of ['console/web/src','console/web/preview'].flatMap(directory=>sources(resolve(root,directory)))){
  const text=readFileSync(path,'utf8');
  for(const match of text.matchAll(/(?:from\s*|import\(\s*)["']([^"']+\.json)["']/g)){
   const target=relative(root,resolve(path,'..',match[1]));
   if(target.startsWith('runtime/data/'))imported.add(target);
  }
 }
 assert.ok(imported.has('runtime/data/admin-items.json'),'preview item catalog must be covered');
 for(const path of imported)assert.ok(copied.has(path),`Missing web-build COPY for ${path}`);
});
