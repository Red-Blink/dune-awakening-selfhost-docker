// httpWithRetry.js -- a real timeout + single-retry-on-5xx-or-connection-
// failure policy for outbound server-to-server calls. Verified during
// planning: no existing helper in this codebase does this (addons.js's
// community-catalog fetch has a timeout but falls back to a stale cache on
// failure, rather than retrying the request itself) -- this is new,
// standalone code, reused wherever this exact policy is needed (currently:
// Core's call to mentat-backend.darkdante.org for hosted-bot registration).
const DEFAULT_TIMEOUT_MS = 15000;

async function attemptOnce(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// fetchWithTimeoutAndRetry: exactly one retry, only on a 5xx response or a
// connection-level failure (thrown error, including our own abort) -- never
// on a 4xx, since retrying an already-rejected request wastes whatever
// rate-limit budget the caller is trying to protect.
//
// Layer 3 audit finding (HIGH): the previous version called the retry
// attempt for a 5xx response INSIDE the same try block whose catch performs
// its own separate retry attempt -- so a 5xx response followed by the retry
// itself throwing (a connection-level failure, not just another 5xx) fell
// into that catch and made a THIRD real network call, not the single retry
// this function's own name and comment promise. For a non-idempotent POST
// (this module's only current caller: hosted-bot guild registration), that
// risks a duplicate server-side side effect. Restructured so there is
// exactly one call site for the retry, reached at most once, regardless of
// whether the first attempt threw or merely returned a retryable 5xx.
export async function fetchWithTimeoutAndRetry(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let firstError;
  try {
    const first = await attemptOnce(url, init, fetchImpl, timeoutMs);
    if (first.ok || (first.status >= 400 && first.status < 500)) return first;
    // A retryable 5xx response, not a thrown error -- fall through to the
    // single retry below. firstError stays undefined; there is no distinct
    // "first attempt" error to chain as a cause if the retry also fails.
  } catch (error) {
    firstError = error;
  }
  try {
    return await attemptOnce(url, init, fetchImpl, timeoutMs);
  } catch (secondError) {
    // Minor fix (final integration review): attach the first attempt's
    // failure as `cause` (when there was one) so a caller/log sees both
    // failures instead of only the second, identical-looking one.
    throw firstError ? new Error(secondError.message, { cause: firstError }) : secondError;
  }
}
