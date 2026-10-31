import { useEffect } from "react";
import {
  i18nApi,
  LANGUAGE_CHANGE_EVENT,
  loadSelectedLanguage
} from "./i18nClient";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "NOSCRIPT", "SVG", "PATH"]);
const TRANSLATABLE_ATTRS = ["placeholder", "title", "aria-label"] as const;

type AppliedTranslation = { source: string; applied: string };
type TranslatableAttribute = typeof TRANSLATABLE_ATTRS[number];
const textTranslations = new WeakMap<Node, AppliedTranslation>();
const attributeTranslations = new WeakMap<Element, Map<TranslatableAttribute, AppliedTranslation>>();

function shouldSkipElement(el: Element | null): boolean {
  let cur: Element | null = el;
  while (cur) {
    if (SKIP_TAGS.has(cur.tagName)) return true;
    if (cur.hasAttribute("data-no-translate") || cur.classList.contains("log-box")) return true;
    cur = cur.parentElement;
  }
  return false;
}

export function ConsoleLanguageObserver() {
  useEffect(() => {
    let activeLang = loadSelectedLanguage();
    let dictionary: Record<string, string> = {};
    let lowerDictionary = new Map<string, string>();
    let numericTemplates: Array<{ pattern: RegExp; names: string[]; translation: string }> = [];
    let isDisposed = false;
    let isApplyingDom = false;

    function rebuildLowerDictionary() {
      lowerDictionary = new Map<string, string>();
      numericTemplates = [];
      for (const [k, v] of Object.entries(dictionary)) {
        if (k && v) {
          lowerDictionary.set(k.toLowerCase(), v);
          const names = k.match(/\{count\d+\}/g);
          if (names) {
            const parts = k.split(/(\{count\d+\})/g);
            const pattern = parts.map(part => /^\{count\d+\}$/.test(part)
              ? "([+-]?\\d[\\d.,\\u00a0\\u202f]*)"
              : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("");
            numericTemplates.push({ pattern: new RegExp(`^${pattern}$`, "i"), names, translation: v });
          }
        }
      }
    }

    function restoreEnglishDom() {
      if (!document.body) return;
      isApplyingDom = true;
      try {
        document.documentElement.lang = "en";
        document.documentElement.dir = "ltr";
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const previous = textTranslations.get(node);
          // React may have replaced a live value since our last observer pass.
          // Restore only a translation we still own, never an old screen snapshot.
          if (previous && node.nodeValue === previous.applied) node.nodeValue = previous.source;
          textTranslations.delete(node);
          node = walker.nextNode();
        }
        const elements = document.body.querySelectorAll("[placeholder],[title],[aria-label]");
        elements.forEach((el) => {
          const previousAttrs = attributeTranslations.get(el);
          if (!previousAttrs) return;
          for (const [attr, previous] of previousAttrs) {
            if (el.getAttribute(attr) === previous.applied) el.setAttribute(attr, previous.source);
          }
          attributeTranslations.delete(el);
        });
      } finally {
        isApplyingDom = false;
      }
    }

    // Strictly local lookup against repository-reviewed static phrases loaded in `dictionary`.
    // Unknown or dynamic DOM text (player names, server titles, logs, IDs) never leaves the browser.
    function lookupReviewedSegment(segment: string): string | null {
      const trimmed = segment.trim();
      if (!trimmed || trimmed.length > 600) return null;

      const exact = dictionary[trimmed] || lowerDictionary.get(trimmed.toLowerCase());
      if (exact) return exact;

      // Only numeric placeholders are matched. Values stay in the browser and
      // arbitrary names or messages cannot become provider requests.
      if (/\d/.test(trimmed)) for (const template of numericTemplates) {
        const match = template.pattern.exec(trimmed);
        if (match) {
          const values = new Map(template.names.map((name, i) => [name, match[i + 1]]));
          return template.translation.replace(/\{count\d+\}/g, name => values.get(name) ?? name);
        }
      }

      // Separate numeric/punctuation variable wrappers from reviewed static phrase keys locally in memory
      const wrapperMatch = trimmed.match(/^([\d\s•·:()[\]/%+-]*?)([A-Za-z][A-Za-z\s,'/-]*[A-Za-z.])([\d\s•·:()[\]/%+-]*)$/);
      if (wrapperMatch) {
        const [, prefix, corePhrase, suffix] = wrapperMatch;
        if ((prefix || suffix) && corePhrase) {
          const coreTrans = dictionary[corePhrase] || lowerDictionary.get(corePhrase.toLowerCase());
          if (coreTrans) {
            return `${prefix}${coreTrans}${suffix}`;
          }
        }
      }

      return null;
    }

    function translatePreservingWhitespace(raw: string): string | null {
      const trimmed = raw.trim();
      if (!trimmed || trimmed.length > 600) return null;

      const direct = lookupReviewedSegment(trimmed);
      if (direct) {
        const leading = raw.match(/^\s*/)?.[0] || "";
        const trailing = raw.match(/\s*$/)?.[0] || "";
        return `${leading}${direct}${trailing}`;
      }

      if (trimmed.includes("•")) {
        const parts = trimmed.split("•");
        let anyTranslated = false;
        const translatedParts = parts.map((p) => {
          const sub = lookupReviewedSegment(p);
          if (sub) {
            anyTranslated = true;
            return sub;
          }
          return p.trim();
        });
        if (anyTranslated) {
          const leading = raw.match(/^\s*/)?.[0] || "";
          const trailing = raw.match(/\s*$/)?.[0] || "";
          return `${leading}${translatedParts.join(" • ")}${trailing}`;
        }
      }

      return null;
    }

    function applyTranslationsToDom() {
      if (!document.body || activeLang === "EN" || isApplyingDom) return;
      isApplyingDom = true;
      try {
        const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        let node = walker.nextNode();
        while (node) {
          const parent = node.parentElement;
          if (parent && !shouldSkipElement(parent)) {
            const currentVal = node.nodeValue || "";
            const previous = textTranslations.get(node);
            const sourceVal = previous && currentVal === previous.applied ? previous.source : currentVal;
            const replacement = translatePreservingWhitespace(sourceVal);
            const nextValue = replacement ?? sourceVal;
            // Untranslated live data is never captured for later restoration.
            if (nextValue !== sourceVal) textTranslations.set(node, { source: sourceVal, applied: nextValue });
            else textTranslations.delete(node);
            if (currentVal !== nextValue) node.nodeValue = nextValue;
          }
          node = walker.nextNode();
        }

        const elements = document.body.querySelectorAll("[placeholder],[title],[aria-label]");
        elements.forEach((el) => {
          if (shouldSkipElement(el)) return;
          const translations = attributeTranslations.get(el) ?? new Map<TranslatableAttribute, AppliedTranslation>();
          for (const attr of TRANSLATABLE_ATTRS) {
            const val = el.getAttribute(attr);
            if (val === null) {
              translations.delete(attr);
              continue;
            }
            const previous = translations.get(attr);
            const sourceVal = previous && val === previous.applied ? previous.source : val;
            const replacement = translatePreservingWhitespace(sourceVal);
            const nextValue = replacement ?? sourceVal;
            if (nextValue !== sourceVal) translations.set(attr, { source: sourceVal, applied: nextValue });
            else translations.delete(attr);
            if (val !== nextValue) el.setAttribute(attr, nextValue);
          }
          if (translations.size) attributeTranslations.set(el, translations);
          else attributeTranslations.delete(el);
        });
      } finally {
        isApplyingDom = false;
      }
    }

    async function activateLanguage(lang: string) {
      activeLang = (lang || "EN").trim().toUpperCase();
      if (activeLang === "EN") {
        dictionary = {};
        lowerDictionary.clear();
        numericTemplates = [];
        restoreEnglishDom();
        return;
      }
      try {
        const bundle = await i18nApi.translations(activeLang);
        if (isDisposed || activeLang !== bundle.lang) return;
        dictionary = bundle.translations || {};
        rebuildLowerDictionary();
        document.documentElement.lang = activeLang.toLowerCase();
        document.documentElement.dir = bundle.dir || "ltr";
        applyTranslationsToDom();
      } catch {
        // Ignore network errors during initial unauthenticated load if server is unreachable
      }
    }

    const observer = new MutationObserver(() => {
      if (activeLang !== "EN" && !isApplyingDom) {
        applyTranslationsToDom();
      }
    });

    if (document.body) {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: [...TRANSLATABLE_ATTRS]
      });
    }

    const handleLanguageChange = (event: Event) => {
      const custom = event as CustomEvent<{ lang?: string }>;
      const nextLang = custom.detail?.lang || loadSelectedLanguage();
      void activateLanguage(nextLang);
    };

    window.addEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
    if (activeLang !== "EN") {
      void activateLanguage(activeLang);
    }

    return () => {
      isDisposed = true;
      observer.disconnect();
      window.removeEventListener(LANGUAGE_CHANGE_EVENT, handleLanguageChange);
    };
  }, []);

  return null;
}
