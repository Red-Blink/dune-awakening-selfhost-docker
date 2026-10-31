import { previewVersionTask, sampleLogs, sampleResponse } from './sampleData';
const notice='Explore the Console with sample data. Server management actions are disabled.';
const previewDetails='This preview is close to v1.4.59. Some values and details are simplified or not yet populated.';
const mutation=/^(start|stop|restart|save|delete|install|uninstall|update|rebuild|redeploy|deploy|restore|grant|give|send|create|add|remove|apply|reset|wipe|purge|clean|clear|repair|fix|kick|ban|unban|teleport|upload|import|export|download|run|execute|enable|disable|set|refill|unlock|complete|promote|demote|revoke|transfer|purchase|buy|sell|check for updates|prepare|sync|suggest|fill missing|sign out|log out|logout|login|qa tester login)\b/i;
export function isManagementAction(label:string){return mutation.test(label.trim());}
export function previewLanguageFile(code:string){const lang=code.toUpperCase();return /^[A-Z]{2}(?:-[A-Z]{2,4})?$/.test(lang)?'/preview-data/'+lang+'.json':null;}
export function previewApiResponse(url:URL,method='GET') {
 if(method.toUpperCase()==='POST'&&['/api/updates/check-stack','/api/updates/check-game'].includes(url.pathname))return new Response(JSON.stringify({task:previewVersionTask(url.pathname.endsWith('game')?'game':'stack')}),{headers:{'content-type':'application/json'}});
 if(!['GET','HEAD'].includes(method.toUpperCase()))return new Response(JSON.stringify({error:'Preview Only — server management actions are disabled.'}),{status:405,headers:{'content-type':'application/json'}});
 try{return new Response(JSON.stringify(sampleResponse(url)),{headers:{'content-type':'application/json'}});}
 catch(error){window.dispatchEvent(new CustomEvent('dune-preview:missing-data',{detail:url.pathname}));return new Response(JSON.stringify({error:error instanceof Error?error.message:'Missing preview data'}),{status:501,headers:{'content-type':'application/json'}});}
}
export function installPreview(){
 const nativeFetch=window.fetch.bind(window);
 window.fetch=async(input,options)=>{
  const request=input instanceof Request?input:null;
  const url=new URL(request?.url||String(input),location.href);
  if(url.origin!==location.origin)throw new Error('External requests are disabled in the preview.');
  const method=options?.method||request?.method||'GET';
  if(url.pathname.startsWith('/api/')&&!['GET','HEAD'].includes(method.toUpperCase()))return previewApiResponse(url,method);
  if(url.pathname==='/api/i18n/languages')return nativeFetch('/preview-data/languages.json');
  if(url.pathname==='/api/i18n/translations'){
   const file=previewLanguageFile(url.searchParams.get('lang')||'EN');
   if(!file)return new Response('{}',{status:400});
   return nativeFetch(file);
  }
  if(url.pathname.startsWith('/api/'))return previewApiResponse(url,method);
  return nativeFetch(input,options);
 };
 // No EventSource request or upload can ever reach a management backend.
 class PreviewEventSource extends EventTarget {
  onmessage: ((event:MessageEvent)=>void)|null=null;onerror: (()=>void)|null=null;readyState=1;
  constructor(_url:string){super();queueMicrotask(()=>this.onmessage?.(new MessageEvent('message',{data:JSON.stringify({line:sampleLogs,stream:'stdout'})})));}
  close(){this.readyState=2;}
 }
 window.EventSource=PreviewEventSource as unknown as typeof EventSource;
 const originalOpen=XMLHttpRequest.prototype.open;
 XMLHttpRequest.prototype.open=function(this:XMLHttpRequest,method:string,url:string|URL,...rest:unknown[]){
  if(new URL(String(url),location.href).pathname.startsWith('/api/'))throw new Error('Uploads are disabled in the preview.');
  return Reflect.apply(originalOpen,this,[method,url,...rest]);
 } as typeof XMLHttpRequest.prototype.open;
 const banner=document.createElement('aside');banner.className='console-preview-notice';banner.setAttribute('role','note');
 const message=document.createElement('div');message.className='console-preview-copy';
 message.textContent=notice+' '+previewDetails;
 const link=document.createElement('a');link.href='https://github.com/Red-Blink/dune-awakening-selfhost-docker';link.textContent='Get the Console';link.target='_blank';link.rel='noopener noreferrer';
 banner.append(message,link);document.body.prepend(banner);document.title='Try the Console · Dune Docker';
 const markControls=()=>{
  document.querySelectorAll<HTMLButtonElement>('button').forEach(button=>{
   if(button.closest('.sidebar-nav,.playerAdmin_tabs,.playerAdmin_iconRailItems')||button.matches('.playerAdmin_toggleHeader')||button.hasAttribute('aria-expanded')||button.getAttribute('role')==='tab')return;
   const label=button.textContent||button.getAttribute('aria-label')||'';
   if(isManagementAction(label)){button.disabled=true;button.title='Preview Only — server management actions are disabled.';}
  });
  document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement>('input,textarea,select').forEach(field=>{
   const label=[field.getAttribute('aria-label'),field.getAttribute('placeholder'),field.getAttribute('name'),field.closest('label')?.textContent].join(' ');
   if(field.closest('.live-map-layers,.live-map-layer,.language-picker,.segmented-control,.database-schema-select,.playerAdmin_filterToolsRow')||/search|filter|page size|rows per|sort|select service|select map|category|schema|target|school/i.test(label)||field.getAttribute('type')==='search')return;
   if(field instanceof HTMLSelectElement||field.getAttribute('type')==='checkbox'||field.getAttribute('type')==='radio')field.disabled=true;
   else field.readOnly=true;
   field.title='Preview Only';
  });
 };
 let scheduled=false;
 new MutationObserver(()=>{if(scheduled)return;scheduled=true;queueMicrotask(()=>{scheduled=false;markControls();});}).observe(document.getElementById('root')!,{subtree:true,childList:true});
 markControls();
}
