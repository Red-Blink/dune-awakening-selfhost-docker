const FRIENDLY_LIMIT = /^(GitHub|Docker Hub|Funcom registry|Container registry|Download service) request limit reached\. /;

// Return only our own prose, never URLs, credentials, or raw provider bodies.
export function downloadFailureMessage(text, now = Date.now()) {
  const lines = String(text || "").split(/\r?\n/).map(line => line.trim());
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (FRIENDLY_LIMIT.test(line)) {
      const advice = line.slice(line.indexOf(". ") + 2);
      if (/^Try again after \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} UTC\.$/.test(advice)
        || advice === "Try again later; no retry time was provided."
        || advice === "The reported retry time has passed. You can try again now.") return line;
    }
    // A plain 401/403 is NOT proof of throttling. Nor is an informational
    // reference to a rate-limit setting or a successful retry's header.
    if (!/toomanyrequests|too many requests|you have reached[^\n]{0,120}pull rate limit|api rate limit exceeded|secondary rate limit|(?:HTTP|status|response|error)[^\n]{0,40}\b429\b/i.test(line)) continue;
    const context = lines.slice(Math.max(0, i - 6), i + 1).join("\n");
    let service = "Download service";
    if (/registry\.funcom\.com/i.test(context)) service = "Funcom registry";
    else if (/docker\.com|docker\.io|docker hub|unauthenticated pull rate limit/i.test(context)) service = "Docker Hub";
    else if (/github\.com|\bGitHub\b/i.test(context)) service = "GitHub";
    else if (/docker:|daemon|registry|toomanyrequests/i.test(context)) service = "Container registry";
    let retryAt;
    for (const header of lines.slice(i, i + 5)) {
      if (!header.toLowerCase().startsWith("retry-after:")) continue;
      const value = header.slice(12).trim();
      if (/^\d{1,8}$/.test(value)) retryAt = now + Number(value) * 1000;
      else if (/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), /i.test(value)) retryAt = Date.parse(value);
      break;
    }
    const advice = Number.isFinite(retryAt)
      ? retryAt > now ? `Try again after ${new Date(retryAt).toISOString().slice(0, 19).replace("T", " ")} UTC.` : "The reported retry time has passed. You can try again now."
      : "Try again later; no retry time was provided.";
    return `${service} request limit reached. ${advice}`;
  }
  return "";
}
