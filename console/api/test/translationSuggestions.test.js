import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,statSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createPublicKey,verify} from 'node:crypto';
import {submitTranslationCorrection} from '../src/services/translationSuggestions.js';
import {validateCorrection,submissionMessage} from '../src/services/translationContract.js';
import {applyReviewedCorrections,handleI18nRoute,isSafeReviewedTranslation,SUPPORTED_LANGUAGES,getReviewedSourcePhrases} from '../src/services/i18nService.js';
import {evaluate} from '../src/policy.js';
const catalog={languages:[{code:'DE'}],sourceStrings:['Home','{count0} of {count1}']};
test('only reviewed phrases with intact placeholders can be submitted',()=>{
  for(const input of [{lang:'DE',source:'Private Player Name',translation:'Name'},{lang:'DE',source:'Home',translation:'<script>x</script>'},{lang:'EN',source:'Home',translation:'Home'},{lang:'DE',source:'{count0} of {count1}',translation:'Missing count'}])assert.throws(()=>validateCorrection(input,catalog));
  assert.equal(validateCorrection({lang:'DE',source:'{count0} of {count1}',translation:'{count0} von {count1}'},catalog).translation,'{count0} von {count1}');
});
test('relay signs only the correction using a persistent private identity, with no server credentials',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'translation-relay-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  const bodies=[];
  const fetchImpl=async(url,options)=>{assert.equal(url,'https://dunedocker.app/api/v1/translations/suggestions');assert.equal(options.redirect,'error');const body=JSON.parse(options.body);bodies.push(body);assert.ok(verify(null,Buffer.from(submissionMessage(body)),createPublicKey({key:Buffer.from(body.publicKey,'base64'),format:'der',type:'spki'}),Buffer.from(body.signature,'base64')));return {ok:true,json:async()=>({id:body.id})};};
  for(let i=0;i<2;i++)await submitTranslationCorrection({lang:'DE',source:'Home',translation:'Start',credit:'Translator',current:'Startseite',password:'never-export-this'}, {secretsDir:directory},catalog,{fetchImpl});
  assert.equal(bodies[0].publicKey,bodies[1].publicKey);assert.notEqual(bodies[0].id,bodies[1].id);
  assert.equal(statSync(join(directory,'translation-contributor-key.pem')).mode&0o777,0o600);
  assert.ok(!JSON.stringify(bodies).includes('never-export-this'));
  assert.equal(Object.keys(bodies[0]).sort().join(','),'credit,current,id,lang,publicKey,signature,source,translation');
});
test('reviewed human corrections override older generated caches and reject unknown keys',()=>{
  const db={translations:{DE:{Home:'Old machine wording'}}};
  applyReviewedCorrections(db,{DE:{Home:'Reviewed Startseite',PrivateName:'do not import'}});
  assert.equal(db.translations.DE.Home,'Reviewed Startseite');assert.equal(db.translations.DE.PrivateName,undefined);
});
test('a missing review endpoint gives an actionable message instead of raw Not Found',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'translation-unavailable-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));
  for(const status of [404,410])await assert.rejects(
    submitTranslationCorrection({lang:'DE',source:'Home',translation:'Start'}, {secretsDir:directory},catalog,{fetchImpl:async()=>({ok:false,status,json:async()=>({error:'Not Found'})})}),
    /translation review service is not available yet/
  );
});
test('suggestion route rejects anonymous and invalid CSRF requests before any outbound call',async()=>{
  let calls=0,status;
  await handleI18nRoute({req:{method:'POST',headers:{},authSession:{tier:'observer',csrf:'valid'}},res:{},path:'/api/i18n/suggestions',url:new URL('http://local/api/i18n/suggestions'),config:{},auth:{requireAuth(){throw new Error('Use the already resolved session');}},json(_res,code){status=code;},fetchImpl(){calls++;throw new Error('No external requests allowed');}});
  assert.equal(status,403);assert.equal(calls,0);
  for(const tier of ['owner','admin','moderator','player','observer'])assert.equal(evaluate({tier},'community:suggest-translation'),true);
  assert.equal(evaluate({tier:'observer'},'settings:write'),false);
});
test('authenticated submission takes its current translation from the catalog, not browser data',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'translation-route-'));t.after(()=>rmSync(directory,{recursive:true,force:true}));let status,wire;
  await handleI18nRoute({req:{method:'POST',headers:{'x-csrf-token':'valid'},authSession:{tier:'observer',csrf:'valid'}},res:{},path:'/api/i18n/suggestions',url:new URL('http://local/api/i18n/suggestions'),config:{generatedDir:directory,secretsDir:join(directory,'secrets')},readJson:async()=>({lang:'DE',source:'Home',translation:'Reviewed Startseite',credit:'Helper',current:'PRIVATE RUNTIME TEXT',password:'PRIVATE PASSWORD'}),json(_res,code){status=code;},fetchImpl:async(_url,options)=>{wire=JSON.parse(options.body);return{ok:true,json:async()=>({id:wire.id})};}});
  assert.equal(status,201);assert.notEqual(wire.current,'PRIVATE RUNTIME TEXT');assert.ok(!JSON.stringify(wire).includes('PRIVATE PASSWORD'));
});
test('all checked-in reviewed language files and the public source catalog are valid',()=>{
  const directory=new URL('../data/i18n-reviewed/',import.meta.url);
  for(const file of readdirSync(directory)){
    const value=JSON.parse(readFileSync(new URL(file,directory),'utf8'));
    if(file==='credits.json'){
      for(const [lang,names]of Object.entries(value)){assert.ok(SUPPORTED_LANGUAGES.some(item=>item.code===lang));assert.ok(Array.isArray(names)&&names.every(name=>typeof name==='string'&&name.length<=60));}
      continue;
    }
    const lang=file.slice(0,-5);assert.ok(SUPPORTED_LANGUAGES.some(item=>item.code===lang&&lang!=='EN'));
    assert.equal(typeof value,'object');assert.equal(Array.isArray(value),false);
    for(const [source,translation]of Object.entries(value))assert.ok(isSafeReviewedTranslation(source,translation),`${lang}: ${source}`);
  }
  const publicCatalog=JSON.parse(readFileSync(new URL('../data/i18n-source-catalog.json',import.meta.url)));
  assert.deepEqual(publicCatalog.sourceStrings,getReviewedSourcePhrases());
});
