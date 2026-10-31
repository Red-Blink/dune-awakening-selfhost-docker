import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { validateCorrection, submissionMessage } from './translationContract.js';

const ENDPOINT = 'https://dunedocker.app/api/v1/translations/suggestions';
export async function submitTranslationCorrection(input, config, catalog, { fetchImpl = globalThis.fetch } = {}) {
  const correction = validateCorrection(input, catalog);
  const file = join(config.secretsDir, 'translation-contributor-key.pem');
  mkdirSync(config.secretsDir, { recursive: true, mode: 0o700 });
  let privateKey;
  try { privateKey = createPrivateKey(readFileSync(file)); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The translation submission identity could not be read.');
    const generated = generateKeyPairSync('ed25519');
    try { writeFileSync(file, generated.privateKey.export({ type: 'pkcs8', format: 'pem' }), { flag: 'wx', mode: 0o600 }); }
    catch (writeError) { if (writeError.code !== 'EEXIST') throw writeError; }
    privateKey = createPrivateKey(readFileSync(file));
  }
  const payload = { id: randomUUID(), publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64'), ...correction };
  payload.signature = sign(null, Buffer.from(submissionMessage(payload)), privateKey).toString('base64');
  let response;
  try {
    response = await fetchImpl(ENDPOINT, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(12000), redirect: 'error' });
  } catch { throw new Error('Submission could not be confirmed. Please try again.'); }
  if (!response.ok) {
    if (response.status === 404 || response.status === 410) {
      throw new Error('The translation review service is not available yet. Please try again shortly.');
    }
    const body = await response.json().catch(() => ({}));
    throw new Error(response.status === 429 ? 'Too many suggestions. Please try again later.' : String(body.error || 'The review service could not accept this correction.').slice(0,250));
  }
  const receipt = await response.json();
  if (!/^[0-9a-f-]{36}$/i.test(receipt.id || '')) throw new Error('The review service returned an invalid receipt.');
  return { id: receipt.id, ...(/^TR-[0-9]{6,16}$/.test(receipt.reference||'')?{reference:receipt.reference}:{}), status: 'pending' };
}
