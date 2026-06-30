import { EMBEDDABLE_CONTENT_SECURITY_POLICY } from "./auth.js";

export function addonHtmlWithScriptNonce(html, nonce) {
  const nonceAttribute = ` nonce="${nonce}"`;
  return String(html || "").replace(/<script\b(?![^>]*\bnonce=)/gi, `<script${nonceAttribute}`);
}

export function addonContentSecurityPolicy(nonce) {
  return EMBEDDABLE_CONTENT_SECURITY_POLICY.replace("script-src 'self'", `script-src 'self' 'nonce-${nonce}'`);
}
