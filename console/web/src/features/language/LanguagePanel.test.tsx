import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import { LanguagePanel } from './LanguagePanel';
import { loadSelectedLanguage,saveSelectedLanguage } from './i18nClient';

const languages=[{code:'EN',name:'English',nativeName:'English'},{code:'DE',name:'German',nativeName:'Deutsch'},{code:'HE',name:'Hebrew',nativeName:'עברית'}];
let posted:unknown,failSubmit=false;
beforeEach(()=>{
  localStorage.clear();posted=undefined;failSubmit=false;
  vi.spyOn(globalThis,'fetch').mockImplementation(async(input,options)=>{
    const url=String(input);let body:unknown={};let status=200;
    if(url==='/api/i18n/languages')body={languages,totalSourceStrings:2};
    else if(url.startsWith('/api/i18n/translations?'))body={translations:url.endsWith('lang=EN')?{Home:'Home',Ready:'Ready'}:{Home:'Startseite',Ready:'Bereit'}};
    else if(url==='/api/i18n/suggestions'){posted=JSON.parse(String(options?.body));body=failSubmit?{error:'Review service unavailable'}:{id:'125e4567-e89b-42d3-a456-426614174000',status:'pending'};status=failSubmit?503:201;}
    else if(url==='/api/auth/state')body={authenticated:true,csrfToken:'fixture'};
    else throw new Error('Unexpected request '+url);
    return new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
  });
});
afterEach(()=>{vi.restoreAllMocks();localStorage.clear();});
it('shows a compact language picker with no provider, sync or peer controls',async()=>{
  render(<LanguagePanel/>);
  expect(await screen.findByRole('button',{name:/Deutsch/})).toBeVisible();
  expect(screen.getByRole('dialog')).toHaveAccessibleName('Console Language');
  expect(screen.queryByRole('switch')).not.toBeInTheDocument();
  expect(screen.queryByText(/DeepL|Token Saver|Fill Missing Translations/)).not.toBeInTheDocument();
  fireEvent.change(screen.getByRole('searchbox'),{target:{value:'Hebrew'}});
  expect(screen.queryByRole('button',{name:/Deutsch/})).not.toBeInTheDocument();
  expect(screen.getByRole('button',{name:/עברית/})).toBeVisible();
});
it('changes only this browser preference, closes the picker and makes no submission',async()=>{
  const close=vi.fn();render(<LanguagePanel onClose={close}/>);
  fireEvent.click(await screen.findByRole('button',{name:/Deutsch/}));
  await waitFor(()=>expect(close).toHaveBeenCalledOnce());
  expect(loadSelectedLanguage()).toBe('DE');expect(posted).toBeUndefined();
});
async function enterCorrection(){
  saveSelectedLanguage('DE');render(<LanguagePanel/>);
  await screen.findByRole('button',{name:/Deutsch/});
  fireEvent.click(screen.getByRole('button',{name:'Suggest a Translation Fix'}));
  fireEvent.change(screen.getByLabelText('Find the Incorrect Text'),{target:{value:'Home'}});
  fireEvent.click(await screen.findByRole('button',{name:/Startseite.*Home/}));
  fireEvent.change(screen.getByLabelText('Your Correction'),{target:{value:'Start'}});
}
it('prefills language and source, submits only the selected correction and shows a review receipt',async()=>{
  await enterCorrection();
  expect(screen.getByLabelText('Language')).toHaveValue('DE');
  fireEvent.change(screen.getByLabelText('Name for Credits (Optional)'),{target:{value:'Desert Translator'}});
  fireEvent.click(screen.getByRole('button',{name:'Submit Correction'}));
  expect(await screen.findByText('Thank You for Your Suggestion')).toBeVisible();
  expect(posted).toEqual({lang:'DE',source:'Home',translation:'Start',credit:'Desert Translator'});
  expect(screen.getByRole('status')).toHaveTextContent('waiting for review');
});
it('preserves the correction after a submission failure so it can be retried',async()=>{
  failSubmit=true;await enterCorrection();fireEvent.click(screen.getByRole('button',{name:'Submit Correction'}));
  expect(await screen.findByRole('alert')).toHaveTextContent('Review service unavailable');
  expect(screen.getByLabelText('Your Correction')).toHaveValue('Start');
  failSubmit=false;fireEvent.click(screen.getByRole('button',{name:'Submit Correction'}));
  expect(await screen.findByText('Thank You for Your Suggestion')).toBeVisible();
});
it('supports Escape and restores scrolling when the picker closes',async()=>{
  const close=vi.fn();const {unmount}=render(<LanguagePanel onClose={close}/>);
  await screen.findByRole('button',{name:/Deutsch/});
  expect(document.body.style.overflow).toBe('hidden');fireEvent.keyDown(screen.getByRole('dialog'),{key:'Escape'});
  expect(close).toHaveBeenCalledOnce();unmount();expect(document.body.style.overflow).not.toBe('hidden');
});
