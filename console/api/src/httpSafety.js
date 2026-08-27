import { existsSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

function existsAsFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

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
  const parsed = JSON.parse(text);
  // A body of literal `null` parses to null, and every one of the ~82
  // readJson call sites then does `body.someField` -- a TypeError that
  // surfaces as a 500 from an authenticated route rather than a 400.
  // Only null is normalized: numbers, strings and arrays all allow
  // property access (yielding undefined), so they still reach each
  // route's own validation unchanged.
  return parsed === null ? {} : parsed;
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
  const fields = {};
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
      else if (fieldName && !fileName) fields[fieldName] = part.slice(headerEnd + 4).toString("utf8").trim();
    }
    cursor = next;
  }
  return { fields, files };
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
  // path.relative, not a `${dist}/` string prefix: the prefix check always
  // failed on Windows, where resolve() joins with backslashes, so every
  // asset request silently fell back to index.html outside a Linux
  // container. relative() is also the more correct traversal check in
  // general -- a prefix match alone would wrongly accept a sibling
  // directory that merely starts with the same characters (e.g. "dist-evil"
  // under a dist without a prefix check's needed trailing separator).
  const rel = relative(dist, file);
  const contained = rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
  const safeFile = contained ? file : fallback;
  // existsSync alone accepts a directory too (e.g. requestPath "/." resolves
  // rel to "", which reads as "contained" -- dist itself, a directory, not a
  // file). serveStatic streams the result with createReadStream().pipe(),
  // which throws an unhandled EISDIR for a directory target, so this must
  // require a real file, not merely something on disk at that path.
  return existsAsFile(safeFile) ? safeFile : fallback;
}
