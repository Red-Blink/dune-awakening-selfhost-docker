export const REDACTION = "<redacted>";

const SENSITIVE_KEY_PATTERN = /(?:token|secret|password|passwd|pwd|authorization|admin[-_]?token|discord[-_]?bot[-_]?token|funcom|database[-_]?url|db[-_]?password)/i;

const TOKEN_VALUE_PATTERNS: RegExp[] = [
  /Bot\s+[A-Za-z0-9._=-]{20,}/gi,
  /Bearer\s+[A-Za-z0-9._=-]{20,}/gi,
  /(?:mfa\.)[A-Za-z0-9._=-]{20,}/gi,
  /[A-Za-z0-9_-]{23,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g,
  /(postgres(?:ql)?:\/\/[^\s"']+)/gi
];

export type Redactable = string | number | boolean | null | undefined | Redactable[] | { [key: string]: Redactable };

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERN.test(key);
}

export function redactString(value: string): string {
  let redacted = value;
  for (const pattern of TOKEN_VALUE_PATTERNS) {
    redacted = redacted.replace(pattern, REDACTION);
  }
  return redacted;
}

export function redactValue<T extends Redactable>(value: T): T | string {
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (!value || typeof value !== "object") return value;

  const output: Record<string, Redactable | string> = {};
  for (const [key, child] of Object.entries(value)) {
    output[key] = isSensitiveKey(key) ? REDACTION : redactValue(child as Redactable);
  }
  return output as T;
}

export function safeErrorMessage(error: unknown): string {
  if (error instanceof Error) return redactString(error.message);
  return redactString(String(error));
}
