const SQL_START = /^(SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|TRUNCATE|UNION|EXEC|EXECUTE|WITH|MERGE|GRANT|REVOKE|CALL|DECLARE|PRAGMA)\b/i;

export function invalidSeedPlanCsvMessage(fileName: string, text: string): string | null {
  if (fileName && !/\.csv$/i.test(fileName)) return "Seed plan uploads must be CSV files.";
  if (text.includes("\u0000")) return "CSV contains binary data and cannot be imported.";
  const body = text.replace(/^\uFEFF/, "").trimStart();
  if (!body) return "The uploaded CSV is empty.";
  const first = body[0];
  if (first === "{" || first === "[" || first === "<") {
    return "Upload a CSV file with a header row, not JSON or HTML.";
  }
  if (SQL_START.test(body) || body.startsWith("--") || body.startsWith("/*")) {
    return "Upload a CSV file with a header row, not a SQL script.";
  }
  const firstLine = body.split(/\r?\n/, 1)[0] || "";
  if (!/template[_\s-]?id/i.test(firstLine) && !/(^|,)id(,|$)/i.test(firstLine)) {
    return "CSV must include a template_id column.";
  }
  return null;
}
