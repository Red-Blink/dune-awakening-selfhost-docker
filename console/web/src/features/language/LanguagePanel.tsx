import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowLeft, Check, Languages, Search, X } from 'lucide-react';
import { i18nApi, loadSelectedLanguage, saveSelectedLanguage, type LanguageCatalogResponse } from './i18nClient';

export function LanguagePanel({ onClose = () => {} }: { onClose?: () => void }) {
  const [catalog,setCatalog] = useState<LanguageCatalogResponse | null>(null);
  const [selected,setSelected] = useState(loadSelectedLanguage);
  const [search,setSearch] = useState('');
  const [suggesting,setSuggesting] = useState(false);
  const [lang,setLang] = useState(() => loadSelectedLanguage()==='EN'?'':loadSelectedLanguage());
  const [phrases,setPhrases] = useState<Record<string,string>>({});
  const [source,setSource] = useState('');
  const [translation,setTranslation] = useState('');
  const [credit,setCredit] = useState('');
  const [busy,setBusy] = useState(false);
  const [loadingPhrases,setLoadingPhrases] = useState(false);
  const [error,setError] = useState('');
  const [receipt,setReceipt] = useState('');
  const modal=useRef<HTMLDivElement>(null);
  useEffect(()=>{ let active=true;i18nApi.catalog().then(value=>{if(active)setCatalog(value);}).catch(()=>{if(active)setError('Languages could not be loaded. Please reopen the picker to try again.');});return()=>{active=false;};},[]);
  useEffect(()=>{
    const previous=document.activeElement as HTMLElement|null;
    const overflow=document.body.style.overflow;document.body.style.overflow='hidden';
    modal.current?.querySelector<HTMLInputElement>('input')?.focus();
    return()=>{document.body.style.overflow=overflow;previous?.focus();};
  },[]);
  useEffect(()=>{
    if(!suggesting||!lang){setPhrases({});setLoadingPhrases(false);return;}
    let active=true;setLoadingPhrases(true);setPhrases({});setSource('');setError('');
    Promise.all([i18nApi.translations(lang),i18nApi.translations('EN')]).then(([target,english])=>{
      if(active)setPhrases(Object.fromEntries(Object.keys(english.translations).map(text=>[text,target.translations[text]||text])));
    }).catch(()=>{if(active)setError('The phrase list could not be loaded. Choose the language again to retry.');}).finally(()=>{if(active)setLoadingPhrases(false);});
    return()=>{active=false;};
  },[suggesting,lang]);
  async function choose(code:string){
    setBusy(true);setError('');
    try{if(code!=='EN')await i18nApi.translations(code);saveSelectedLanguage(code);setSelected(code);onClose();}
    catch{setError('This language could not be loaded. Please try again.');}finally{setBusy(false);}
  }
  async function submit(event:React.FormEvent){
    event.preventDefault();setBusy(true);setError('');
    try{const result=await i18nApi.suggest({lang,source,translation,credit});setReceipt(result.id);}
    catch(reason){setError(reason instanceof Error?reason.message:'The correction could not be submitted. Please try again.');}finally{setBusy(false);}
  }
  const q=search.trim().toLocaleLowerCase();
  const available=catalog?.languages.filter(item=>`${item.name} ${item.nativeName} ${item.code}`.toLocaleLowerCase().includes(q))||[];
  const matches=q?Object.entries(phrases).filter(([text,current])=>`${text} ${current}`.toLocaleLowerCase().includes(q)).slice(0,40):[];
  return createPortal(<div className="modal-overlay language-picker-overlay" onMouseDown={event=>{if(event.target===event.currentTarget&&!busy)onClose();}}>
    <div ref={modal} className="confirm-modal language-panel language-picker" role="dialog" aria-modal="true" aria-labelledby="language-picker-title" onKeyDown={event=>{
      if(event.key==='Escape'&&!busy){event.stopPropagation();onClose();}
      if(event.key==='Tab'){
        const controls=[...event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, a[href]')].filter(item=>!item.hidden);
        const first=controls[0],last=controls.at(-1);
        if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}
        else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}
      }
    }}>
      <header className="language-picker-heading"><div><Languages size={22}/><h2 id="language-picker-title">{suggesting?'Suggest a Translation Fix':'Console Language'}</h2></div><button type="button" onClick={onClose} disabled={busy} aria-label="Close"><X size={20}/></button></header>
      {error&&<p role="alert" className="error-banner">{error}</p>}
      {receipt?<div className="language-thanks" role="status"><Check size={32}/><h3>Thank You for Your Suggestion</h3><p>Your correction is waiting for review. Approved corrections will be included in a future project update.</p><small><span>Reference</span>: <span data-no-translate>{receipt}</span></small><button onClick={onClose}>Done</button></div>:suggesting?<form onSubmit={submit}>
        <button type="button" className="language-back" onClick={()=>{setSuggesting(false);setSearch('');setSource('');setError('');}} disabled={busy}><ArrowLeft size={15}/>Back to Languages</button>
        <label>Language<select aria-label="Language" value={lang} onChange={event=>{setLang(event.target.value);setSource('');setTranslation('');setSearch('');}} disabled={busy} required><option value="">Choose a Language</option>{catalog?.languages.filter(item=>item.code!=='EN').map(item=><option key={item.code} value={item.code} data-no-translate>{item.nativeName} ({item.code})</option>)}</select></label>
        {!source?<><label>Find the Incorrect Text<input type="search" value={search} onChange={event=>setSearch(event.target.value)} disabled={!lang||busy} placeholder="Search by current translation or English phrase"/></label>
          <div className="language-phrase-results" aria-busy={loadingPhrases}>{loadingPhrases?<p>Loading Phrases…</p>:lang&&!q?<p>Search by current translation or English phrase</p>:lang&&matches.length===0?<p>No Matching Phrases</p>:matches.map(([text,current])=><button type="button" key={text} onClick={()=>{setSource(text);setTranslation(current);}}><span data-no-translate dir="auto">{current}</span><small data-no-translate dir="ltr">{text}</small></button>)}</div></>:<>
          <div className="language-original"><div><span>English Phrase</span><p data-no-translate dir="ltr">{source}</p></div><div><span>Current Translation</span><p data-no-translate dir="auto">{phrases[source]}</p></div></div>
          <button type="button" className="language-back" disabled={busy} onClick={()=>setSource('')}>Choose Different Text</button>
          <label>Your Correction<textarea dir="auto" value={translation} onChange={event=>setTranslation(event.target.value)} maxLength={1800} disabled={busy} rows={3} required/></label>
          {/\{[\w.-]+\}|%[sd]/.test(source)&&<p className="language-help">Keep placeholders such as {'{count0}'} unchanged.</p>}
          <label>Name for Credits (Optional)<input value={credit} onChange={event=>setCredit(event.target.value)} maxLength={60} disabled={busy}/></label>
          <p className="language-help">Only this phrase, your correction, and the optional credit name will be sent to DuneDocker for review.</p>
          <button className="primary" type="submit" disabled={busy||!translation.trim()||translation.trim()===phrases[source]}>{busy?'Submitting…':'Submit Correction'}</button>
        </>}
      </form>:<>
        <p className="language-help">Choose the language for this browser. Translations are included with project updates.</p>
        <label className="language-search"><Search size={17}/><input type="search" placeholder="Search Languages" aria-label="Search Languages" value={search} onChange={event=>setSearch(event.target.value)}/></label>
        {!catalog&&!error&&<p role="status">Loading Languages…</p>}
        <div className="language-options">{available.map(item=><button type="button" key={item.code} className={selected===item.code?'active':''} aria-pressed={selected===item.code} disabled={busy} onClick={()=>void choose(item.code)}><span><strong data-no-translate>{item.nativeName}</strong><small data-no-translate>{item.name}</small></span>{selected===item.code&&<Check size={18}/>}</button>)}</div>
        {catalog&&available.length===0&&<p>No Matching Languages</p>}
        <footer><button type="button" disabled={!catalog||busy} onClick={()=>{setSuggesting(true);setSearch('');setError('');}}>Suggest a Translation Fix</button></footer>
      </>}
    </div>
  </div>,document.body);
}
