// httpWithRetry.js -- a real timeout + single-retry-on-5xx-or-connection-
// failure policy for outbound server-to-server calls. Verified during
// planning: no existing helper in this codebase does this (addons.js's
// community-catalog fetch has a timeout but falls back to a stale cache on
// failure, rather than retrying the request itself) -- this is new,
// standalone code, reused wherever this exact policy is needed (currently:
// Core's call to mentat-backend.darkdante.org for hosted-bot registration).
const DEFAULT_TIMEOUT_MS = 15000;

// #1339 (Layer 3 review): this used to clear the timer as soon as fetchImpl()
// resolved headers, so a caller reading the body LATER (every real caller
// does: this function returns the raw response, and all 3 call sites check
// .ok/.status before conditionally calling .json()) had no timeout bound at
// all on that read -- the exact gap oauth.js's near-identical helper had.
// attemptOnce now keeps the timer live and hands back a `release()` the
// caller must call once it is truly done with the response (reading the
// body or discarding it unread), not when fetchImpl merely resolves.
async function attemptOnce(url, init, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, { ...init, signal: controller.signal });
  } catch (error) {
    clearTimeout(timer);
    throw error;
  }
  return { response, release: () => clearTimeout(timer) };
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
// Returns the raw response, with its OWN abort timer still live. Every
// caller MUST read the body (or decide not to) and then call
// `response[RELEASE_TIMEOUT]()` -- see fetchJsonWithTimeoutAndRetry below for
// a wrapper that does this automatically and is the right choice unless a
// caller genuinely needs the raw Response (none currently do).
const RELEASE_TIMEOUT = Symbol("releaseTimeout");
export async function fetchWithTimeoutAndRetry(url, init = {}, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
  let firstError;
  try {
    const first = await attemptOnce(url, init, fetchImpl, timeoutMs);
    if (first.response.ok || (first.response.status >= 400 && first.response.status < 500)) {
      first.response[RELEASE_TIMEOUT] = first.release;
      return first.response;
    }
    // A retryable 5xx response, not a thrown error -- fall through to the
    // single retry below. firstError stays undefined; there is no distinct
    // "first attempt" error to chain as a cause if the retry also fails.
    // Nobody will read this response's body, so release its timer now.
    first.release();
  } catch (error) {
    firstError = error;
  }
  try {
    const retry = await attemptOnce(url, init, fetchImpl, timeoutMs);
    retry.response[RELEASE_TIMEOUT] = retry.release;
    return retry.response;
  } catch (secondError) {
    // Minor fix (final integration review): attach the first attempt's
    // failure as `cause` (when there was one) so a caller/log sees both
    // failures instead of only the second, identical-looking one.
    throw firstError ? new Error(secondError.message, { cause: firstError }) : secondError;
  }
}

// The right choice for every real caller: reads (or safely discards) the
// body under the SAME abort bound the request itself used, then always
// releases the timer, success or failure. Returns { response, json } where
// json is null if the body was empty/not valid JSON (callers already
// uniformly treat that as a soft failure, not a thrown error).
export async function fetchJsonWithTimeoutAndRetry(url, init, options) {
  const response = await fetchWithTimeoutAndRetry(url, init, options);
  try {
    let json = null;
    if (response.ok) {
      try {
        json = await response.json();
      } catch (error) {
        // A body read cut off by this SAME request's own timeout must look
        // like "unreachable" to the caller, not "the server sent us
        // garbage" -- the two outer try/catches in every server.js caller
        // treat those very differently (mentat_unreachable vs. a soft
        // mentat_bad_response/not_found). Only a genuine parse failure (the
        // peer really did send a non-JSON or empty body) is swallowed here.
        if (error?.name === "AbortError") throw error;
        json = null;
      }
    }
    return { response, json };
  } finally {
    response[RELEASE_TIMEOUT]?.();
  }
}
