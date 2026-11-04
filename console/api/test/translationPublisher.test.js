import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareTranslationPRs} from '../scripts/prepare-translation-prs.mjs';
const id='125e4567-e89b-42d3-a456-426614174000';
test('approved batch writes only reviewed locale files, creates one PR and dispatches CI; retries are idempotent',async()=>{
  let pr=null,tree,dispatches=0,commits=0;const requests=[];
  const fetchImpl=async(url,options={})=>{
    requests.push([url,options]);const body=options.body?JSON.parse(options.body):null;
    let result={};let status=200;
    if(url==='https://dunedocker.app/api/v1/translations/releases/pending')result={batches:[{id,entries:[{reference:'TR-000123',lang:'DE',source:'Home',translation:'Reviewed Startseite',credit:'Desert Helper'}]}]};
    else if(url.includes('/pulls?'))result=pr?[pr]:[];
    else if(url.endsWith('/git/ref/heads/translations/'+id))status=404;
    else if(url.endsWith('/git/ref/heads/main'))result={object:{sha:'parent'}};
    else if(url.endsWith('/git/refs'))result={object:{sha:'parent'}};
    else if(url.endsWith('/git/commits/parent'))result={tree:{sha:'tree-before'}};
    else if(url.includes('/contents/'))status=404;
    else if(url.endsWith('/git/trees')){tree=body;result={sha:'tree-after'};}
    else if(url.endsWith('/git/commits')){commits++;result={sha:'reviewed-commit'};}
    else if(url.endsWith('/pulls')){pr={html_url:'https://github.com/Red-Blink/dune-awakening-selfhost-docker/pull/999',head:{ref:'translations/'+id,sha:'reviewed-commit'},base:{repo:{full_name:'Red-Blink/dune-awakening-selfhost-docker'}},state:'open'};result=pr;}
    else if(url.includes('/actions/workflows/ci.yml/runs?'))result={workflow_runs:[{id:1}]};
    else if(url.endsWith('/actions/workflows/ci.yml/dispatches')){dispatches++;status=204;}
    return{ok:status<400,status,json:async()=>result};
  };
  assert.equal((await prepareTranslationPRs({token:'synthetic-workflow-token',fetchImpl}))[0].existing,false);
  assert.deepEqual(tree.tree.map(item=>item.path),['console/api/data/i18n-reviewed/DE.json','console/api/data/i18n-reviewed/credits.json']);
  assert.equal(JSON.parse(tree.tree[0].content).Home,'Reviewed Startseite');assert.ok(tree.tree[1].content.includes('Desert Helper'));assert.equal(dispatches,1);
  assert.ok(requests.some(([url,options])=>url.endsWith('/pulls')&&JSON.parse(options.body).body.includes('[TR-000123](https://dunedocker.app/translations.html#TR-000123)')));
  assert.equal((await prepareTranslationPRs({token:'synthetic-workflow-token',fetchImpl}))[0].existing,true);assert.equal(commits,1);assert.equal(dispatches,1);
  assert.ok(requests.every(([url])=>url.startsWith('https://api.github.com/repos/Red-Blink/dune-awakening-selfhost-docker/')||url==='https://dunedocker.app/api/v1/translations/releases/pending'));
});
test('unreviewed source text and invalid language/path values never reach GitHub writes',async()=>{
  for(const entry of [{lang:'../../bad',source:'Home',translation:'bad'},{lang:'DE',source:'Private Player',translation:'bad'}]){
    let calls=0;
    await assert.rejects(prepareTranslationPRs({token:'test-token',fetchImpl:async()=>{calls++;return{ok:true,json:async()=>({batches:[{id,entries:[entry]}]})};}}));
    assert.equal(calls,1);
  }
});
