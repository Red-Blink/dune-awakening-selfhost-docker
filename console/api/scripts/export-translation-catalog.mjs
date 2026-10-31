import fs from 'node:fs';
import { getReviewedSourcePhrases, SUPPORTED_LANGUAGES } from '../src/services/i18nService.js';
const catalog = { sourceStrings:getReviewedSourcePhrases(), languages:SUPPORTED_LANGUAGES.map(({code,name,nativeName,dir})=>({code,name,nativeName,dir})) };
const file = new URL('../data/i18n-source-catalog.json',import.meta.url);
const text=JSON.stringify(catalog,null,2)+'\n';
if(process.argv.includes('--check')){
  if(!fs.existsSync(file)||fs.readFileSync(file,'utf8')!==text)throw new Error('Run node console/api/scripts/export-translation-catalog.mjs to update the public source catalog.');
}else fs.writeFileSync(file,text);
