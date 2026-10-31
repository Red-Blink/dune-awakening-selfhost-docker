import { pathToFileURL } from 'node:url';
import { validateCorrection } from '../src/services/translationContract.js';
import { getReviewedSourcePhrases,SUPPORTED_LANGUAGES } from '../src/services/i18nService.js';

const repository='Red-Blink/dune-awakening-selfhost-docker';
const uuid=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export async function prepareTranslationPRs({token,fetchImpl=globalThis.fetch}={}){
  if(!token)throw new Error('GitHub Actions token is required.');
  async function api(path,body,method=body?'POST':'GET',optional=false){
    const response=await fetchImpl(`https://api.github.com/repos/${repository}/${path}`,{method,headers:{authorization:`Bearer ${token}`,accept:'application/vnd.github+json','content-type':'application/json','x-github-api-version':'2022-11-28'},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(20000),redirect:'error'});
    if(optional&&response.status===404)return null;
    if(!response.ok)throw new Error(`GitHub request failed (${response.status}) for ${path.split('?')[0]}.`);
    return response.status===204?{}:response.json();
  }
  const response=await fetchImpl('https://dunedocker.app/api/v1/translations/releases/pending',{signal:AbortSignal.timeout(15000),redirect:'error'});
  if(!response.ok)throw new Error('The approved translation queue could not be loaded.');
  const data=await response.json();
  if(!Array.isArray(data.batches)||data.batches.length>50)throw new Error('Invalid approved batch response.');
  const catalog={sourceStrings:getReviewedSourcePhrases(),languages:SUPPORTED_LANGUAGES};
  const results=[];
  for(const batch of data.batches){
    if(!uuid.test(batch.id)||!Array.isArray(batch.entries)||!batch.entries.length||batch.entries.length>500)throw new Error('Invalid approved translation batch.');
    const entries=batch.entries.map(entry=>validateCorrection(entry,catalog));
    const branch=`translations/${batch.id}`;
    const existing=await api(`pulls?state=all&head=${encodeURIComponent('Red-Blink:'+branch)}`);
    if(existing.length){
      const pr=existing.find(item=>item.head?.ref===branch&&item.base?.repo?.full_name===repository);
      if(pr){
        if(pr.state==='open'&&pr.head?.sha){
          const runs=await api(`actions/workflows/ci.yml/runs?event=workflow_dispatch&head_sha=${encodeURIComponent(pr.head.sha)}&per_page=1`);
          if(!runs.workflow_runs?.length)await api('actions/workflows/ci.yml/dispatches',{ref:branch});
        }
        results.push({id:batch.id,url:pr.html_url,existing:true});continue;
      }
    }
    let ref=await api(`git/ref/heads/${branch}`,undefined,'GET',true);
    if(!ref){const main=await api('git/ref/heads/main');ref=await api('git/refs',{ref:'refs/heads/'+branch,sha:main.object.sha});}
    const parent=ref.object.sha;
    const commit=await api(`git/commits/${parent}`);
    async function file(path){
      let result=await api(`contents/${path}?ref=${encodeURIComponent(branch)}`,undefined,'GET',true);
      if(!result)return {};
      if(typeof result.content!=='string'&&/^[a-f0-9]{40}$/.test(result.sha||''))result=await api(`git/blobs/${result.sha}`);
      if(typeof result.content!=='string')throw new Error('A reviewed translation file could not be read.');
      return JSON.parse(Buffer.from(result.content,'base64').toString('utf8'));
    }
    const languages=[...new Set(entries.map(entry=>entry.lang))].sort();
    const tree=[];
    for(const lang of languages){
      const path=`console/api/data/i18n-reviewed/${lang}.json`;
      const previous=await file(path);
      for(const entry of entries.filter(item=>item.lang===lang))previous[entry.source]=entry.translation;
      tree.push({path,mode:'100644',type:'blob',content:JSON.stringify(Object.fromEntries(Object.entries(previous).sort(([a],[b])=>a.localeCompare(b))),null,2)+'\n'});
    }
    const creditPath='console/api/data/i18n-reviewed/credits.json';
    const credits=await file(creditPath);
    for(const entry of entries){if(entry.credit)credits[entry.lang]=[...new Set([...(credits[entry.lang]||[]),entry.credit])].sort();}
    tree.push({path:creditPath,mode:'100644',type:'blob',content:JSON.stringify(credits,null,2)+'\n'});
    const nextTree=await api('git/trees',{base_tree:commit.tree.sha,tree});
    if(nextTree.sha!==commit.tree.sha){
      const next=await api('git/commits',{message:`Review community translation corrections (${batch.id})`,tree:nextTree.sha,parents:[parent]});
      await api(`git/refs/heads/${branch}`,{sha:next.sha,force:false},'PATCH');
    }
    const names=[...new Set(entries.map(entry=>entry.credit).filter(Boolean))].map(name=>'`'+name.replace(/`/g,'')+'`').join(', ');
    const pr=await api('pulls',{title:`Improve ${languages.join(', ')} community translations`,head:branch,base:'main',body:`Applies ${entries.length} corrections approved in the DuneDocker translation review queue.\n\nBatch: \`${batch.id}\`\n\nReviewed translations take precedence over generated caches. No automatic release or installation update is performed.\n\nCommunity Contributions: ${names||'Anonymous contributors'}.`});
    // Token-created PR workflows can require manual approval. Explicit dispatch
    // runs the existing full CI on the exact proposed branch and is retryable.
    await api('actions/workflows/ci.yml/dispatches',{ref:branch});
    results.push({id:batch.id,url:pr.html_url,existing:false});
  }
  return results;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const results=await prepareTranslationPRs({token:process.env.GITHUB_TOKEN});
  for(const result of results)console.log(`${result.id}: ${result.url}${result.existing?' (already prepared)':''}`);
}
