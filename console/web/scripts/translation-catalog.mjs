import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const visibleProperties = new Set(["label", "title", "message", "description", "detail", "placeholder", "emptyText", "emptyMessage", "confirmLabel", "caption", "helpText", "tooltip", "buttonText", "tab"]);
const visibleAttributes = new Set(["title", "aria-label", "placeholder", "alt", "label"]);
const skippedTags = new Set(["code", "pre", "script", "style", "textarea"]);
const entities = { amp: "&", apos: "'", quot: '"', lt: "<", gt: ">", nbsp: "\u00a0", mdash: "—" };

function decodeText(value) {
  return value.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(entity[1].toLowerCase() === "x" ? 2 : 1), entity[1].toLowerCase() === "x" ? 16 : 10));
    return entities[entity] ?? whole;
  }).replace(/\s+/g, " ").trim();
}

export function extractUiPhrases(source, fileName = "Component.tsx", onPhrase = () => {}) {
  const file = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, fileName.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const phrases = new Set();
  const add = (value, node) => {
    const text = decodeText(value);
    if (text.length < 2 || text.length > 600 || !/[A-Za-z]/.test(text)) return;
    if (/^(https?:|\/|\?|#[a-f0-9]|data:)/i.test(text) || /^[a-z\d]+(?:[-_][a-z\d]+)+$/.test(text) || /^[\w.-]+\.[a-z]{2,}$/i.test(text)) return;
    if (/^(?:CRIT|INFO|WARN|OK|CPU|RAM|JSON|API|FLS|ID|UTC|UID|GID|TCP|UDP)$/.test(text) || /^[\d\s.,/%:dhms]+$/i.test(text)) return;
    phrases.add(text);
    onPhrase(text, node, file);
  };
  const numeric = node => ts.isNumericLiteral(node)
    || (ts.isIdentifier(node) && /^(?:count|total|ready|online|queued|seconds|minutes|hours|days|percent|remaining|used|available|capacity|size|length|index|i)\d*$/i.test(node.text))
    || (ts.isPropertyAccessExpression(node) && node.name.text === "length");
  const visible = node => {
    if (!node) return;
    if (ts.isStringLiteralLike(node)) add(node.text, node);
    else if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node)) visible(node.expression);
    else if (ts.isConditionalExpression(node)) { visible(node.whenTrue); visible(node.whenFalse); }
    else if (ts.isBinaryExpression(node) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.PlusToken].includes(node.operatorToken.kind)) { visible(node.left); visible(node.right); }
    else if (ts.isTemplateExpression(node) && node.templateSpans.every(span => numeric(span.expression))) {
      add(node.head.text + node.templateSpans.map((span, i) => `{count${i}}${span.literal.text}`).join(""), node);
    }
  };
  const visit = node => {
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node)) {
      const opening = ts.isJsxElement(node) ? node.openingElement : node;
      if (skippedTags.has(opening.tagName.getText(file)) || opening.attributes.properties.some(attr => ts.isJsxAttribute(attr) && attr.name.getText(file) === "data-no-translate")) return;
    }
    if (ts.isJsxText(node)) add(node.text, node);
    if (ts.isJsxAttribute(node) && visibleAttributes.has(node.name.getText(file))) {
      if (node.initializer && ts.isJsxExpression(node.initializer)) visible(node.initializer.expression);
      else visible(node.initializer);
    }
    if (ts.isJsxExpression(node) && node.parent && (ts.isJsxElement(node.parent) || ts.isJsxFragment(node.parent))) visible(node.expression);
    if (ts.isPropertyAssignment(node) && visibleProperties.has(node.name.getText(file))) visible(node.initializer);
    if (ts.isVariableDeclaration(node) && /(?:label|title|subtitle|message|caption|heading|description|detail)s?$/i.test(node.name.getText(file))) {
      if (node.initializer && ts.isArrayLiteralExpression(node.initializer)) node.initializer.elements.forEach(visible);
      else visible(node.initializer);
    }
    if (ts.isReturnStatement(node) && !(node.expression && ts.isStringLiteralLike(node.expression) && /^[a-z\d_.-]+$/.test(node.expression.text))) visible(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(file);
  return [...phrases].sort();
}

export function collectUiPhrases(sourceDir) {
  const phrases = new Map();
  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (/\.tsx?$/.test(file) && !/\.(?:test|d)\.tsx?$/.test(file) && !file.includes(`${path.sep}test${path.sep}`)) {
        for (const phrase of extractUiPhrases(fs.readFileSync(file, "utf8"), file)) {
          if (!phrases.has(phrase)) phrases.set(phrase, []);
          phrases.get(phrase).push(path.relative(sourceDir, file));
        }
      }
    }
  };
  walk(sourceDir);
  return phrases;
}

export function missingUiPhrases(phrases, reviewed) {
  const known = new Set(reviewed.map(text => text.toLowerCase()));
  return [...phrases].filter(([text]) => !known.has(text.toLowerCase())).map(([text, files]) => ({ text, files }));
}

// Only static interface literals enter this catalog, never rendered runtime data.
export function collectUiContexts(sourceDir) {
  const contexts = {};
  const visited = new Set();
  for (const files of collectUiPhrases(sourceDir).values()) for (const relative of files) {
    if (visited.has(relative)) continue;
    visited.add(relative);
    const fileName = path.join(sourceDir, relative), occurrences = [];
    extractUiPhrases(fs.readFileSync(fileName, 'utf8'), fileName, (text, node, file) => {
      occurrences.push({text, line:file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1});
    });
    for (let i = 0; i < occurrences.length; i++) {
      const item = occurrences[i];
      contexts[item.text] ||= [];
      if (contexts[item.text].length >= 12) continue;
      const file = `console/web/src/${relative.split(path.sep).join('/')}`;
      if (contexts[item.text].some(row => row.file === file && row.line === item.line)) continue;
      contexts[item.text].push({file, line:item.line, nearby:[...new Set(occurrences.slice(Math.max(0,i-2),i+3).map(row=>row.text).filter(text=>text!==item.text))]});
    }
  }
  return Object.fromEntries(Object.entries(contexts).sort(([a],[b])=>a.localeCompare(b)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const seed = JSON.parse(fs.readFileSync(path.resolve(web, "../api/data/i18n-translations-db.json"), "utf8"));
  const missing = missingUiPhrases(collectUiPhrases(path.join(web, "src")), seed.sourceStrings);
  if (process.argv[2] === "list") console.log(JSON.stringify(missing, null, 2));
  else if (missing.length) {
    console.error(`${missing.length} static UI phrases are missing from the reviewed catalog. Run npm run list:i18n to review them.`);
    for (const item of missing) console.error(`${item.files[0]}: ${item.text}`);
    process.exitCode = 1;
  } else console.log("All extracted static UI phrases are present in the reviewed translation catalog.");
}
