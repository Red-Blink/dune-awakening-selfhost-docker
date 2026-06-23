import { existsSync } from "node:fs";
import { resolve } from "node:path";

export async function readJsonBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`JSON body exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export async function readMultipartForm(req, maxBytes) {
  const contentType = String(req.headers["content-type"] || "");
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  const boundary = boundaryMatch?.[1] || boundaryMatch?.[2];
  if (!boundary) {
    const error = new Error("Expected multipart/form-data upload.");
    error.statusCode = 400;
    throw error;
  }
  const body = await readRawBody(req, maxBytes);
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const files = [];
  let cursor = body.indexOf(boundaryBuffer);
  while (cursor >= 0) {
    cursor += boundaryBuffer.length;
    if (body[cursor] === 45 && body[cursor + 1] === 45) break;
    if (body[cursor] === 13 && body[cursor + 1] === 10) cursor += 2;
    const next = body.indexOf(boundaryBuffer, cursor);
    if (next < 0) break;
    let part = body.slice(cursor, next);
    if (part.length >= 2 && part[part.length - 2] === 13 && part[part.length - 1] === 10) part = part.slice(0, -2);
    const headerEnd = part.indexOf(Buffer.from("\r\n\r\n"));
    if (headerEnd > 0) {
      const headers = part.slice(0, headerEnd).toString("utf8");
      const disposition = headers.split(/\r?\n/).find((line) => /^content-disposition:/i.test(line)) || "";
      const fieldName = disposition.match(/\bname="([^"]*)"/i)?.[1] || "";
      const fileName = disposition.match(/\bfilename="([^"]*)"/i)?.[1] || "";
      if (fieldName && fileName) files.push({ fieldName, fileName, content: part.slice(headerEnd + 4) });
    }
    cursor = next;
  }
  return { files };
}

export async function readRawBody(req, maxBytes) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buffer.length;
    if (total > maxBytes) {
      const error = new Error(`Upload exceeds ${maxBytes} bytes`);
      error.statusCode = 413;
      throw error;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks);
}

export function safeStaticTarget(staticDir, requestPath) {
  const dist = resolve(staticDir);
  const normalizedPath = requestPath === "/" ? "/index.html" : requestPath;
  const file = resolve(dist, `.${normalizedPath}`);
  const fallback = resolve(dist, "index.html");
  const safeFile = file.startsWith(`${dist}/`) ? file : fallback;
  return existsSync(safeFile) ? safeFile : fallback;
}
