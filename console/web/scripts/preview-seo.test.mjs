import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {applyPreviewSeo} from './preview-seo.mjs';

test('preview builds publish indexable metadata, crawlable introductory content, and real crawler files',()=>{
 const out=fs.mkdtempSync(path.join(os.tmpdir(),'dune-preview-seo-'));
 try{
  fs.writeFileSync(path.join(out,'index.html'),'<html><head><title>Dune Docker Console</title><script src="/app.js"></script></head><body><div id="root"></div></body></html>');
  applyPreviewSeo(out);const html=fs.readFileSync(path.join(out,'index.html'),'utf8');
  assert.match(html,/<title>Try Dune: Awakening Server Console Online/);
  assert.match(html,/<link rel="canonical" href="https:\/\/try.dunedocker.app\/">/);
  assert.match(html,/<meta name="robots" content="index, follow/);
  assert.match(html,/<h1>Try the Dune: Awakening Server Console<\/h1>/);
  assert.match(html,/Server management actions are disabled/);
  assert.match(html,/<a href="https:\/\/docs.dunedocker.app\/">/);
  assert.match(html,/<script src="\/app.js"><\/script>/);
  const graph=JSON.parse(html.match(/<script type="application\/ld\+json">(.*?)<\/script>/)[1]);
  assert.equal(graph['@graph'][1]['@type'],'WebApplication');
  assert.match(fs.readFileSync(path.join(out,'robots.txt'),'utf8'),/Sitemap: https:\/\/try.dunedocker.app\/sitemap.xml/);
  assert.match(fs.readFileSync(path.join(out,'sitemap.xml'),'utf8'),/<loc>https:\/\/try.dunedocker.app\/<\/loc>/);
  assert.doesNotMatch(fs.readFileSync(path.join(out,'sitemap.xml'),'utf8'),/\/api\//);
 }finally{fs.rmSync(out,{recursive:true,force:true});}
});
