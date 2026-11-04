// Shared submission format. The website ships an identical copy of this module.
export function placeholders(text) {
  return (String(text).match(/\{\{[\w.-]+\}\}|\{[\w.-]+\}|%[sd]/g) || []).sort();
}
export function validateCorrection(input, catalog) {
  const lang = String(input?.lang || '').toUpperCase();
  const source = String(input?.source || '').trim();
  const translation = String(input?.translation || '').trim();
  const credit = String(input?.credit || '').trim();
  const current = String(input?.current || '').trim();
  if (!catalog.languages.some(item => item.code === lang && lang !== 'EN')) throw new Error('Choose a supported translation language.');
  if (!catalog.sourceStrings.includes(source)) throw new Error('Choose a phrase from the installed interface catalog.');
  if (!translation || translation.length > 1800 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(translation)) throw new Error('Enter a plain-text translation of up to 1800 characters.');
  if (JSON.stringify(placeholders(source)) !== JSON.stringify(placeholders(translation))) throw new Error('Keep all placeholders exactly as shown in the original phrase.');
  if (credit.length > 60 || /[<>\x00-\x1f\x7f]/.test(credit)) throw new Error('Use a credit name of up to 60 plain-text characters.');
  if (current.length > 1800 || /[<>\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(current)) throw new Error('Invalid installed translation.');
  return { lang, source, translation, credit, current };
}
export function submissionMessage(payload) {
  return JSON.stringify(['dune-translation-v1', payload.id, payload.publicKey, payload.lang, payload.source, payload.translation, payload.credit, payload.current]);
}
