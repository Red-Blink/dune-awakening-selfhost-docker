import { useEffect } from "react";
import {
  i18nApi,
  LANGUAGE_CHANGE_EVENT,
  loadSelectedLanguage
} from "./i18nClient";

const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "CODE", "PRE", "TEXTAREA", "NOSCRIPT", "SVG", "PATH"]);
const TRANSLATABLE_ATTRS = ["placeholder", "title", "aria-label"] as const;

const originalTextByNode = new WeakMap<Node, string>();
const lastAppliedTextByNode = new WeakMap<Node, string>();
const originalAttrsByElement = new WeakMap<Element, Record<string, string>>();

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
    let isDisposed = false;
    let isApplyingDom = false;

    function rebuildLowerDictionary() {
      lowerDictionary = new Map<string, string>();
      for (const [k, v] of Object.entries(dictionary)) {
        if (k && v) {
          lowerDictionary.set(k.toLowerCase(), v);
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
          const orig = originalTextByNode.get(node);
          if (orig !== undefined && node.nodeValue !== orig) {
            node.nodeValue = orig;
            lastAppliedTextByNode.set(node, orig);
          }
          node = walker.nextNode();
        }
        const elements = document.body.querySelectorAll("[placeholder],[title],[aria-label]");
        elements.forEach((el) => {
          const origAttrs = originalAttrsByElement.get(el);
          if (!origAttrs) return;
          for (const attr of TRANSLATABLE_ATTRS) {
            if (origAttrs[attr] !== undefined) {
              el.setAttribute(attr, origAttrs[attr]);
            }
          }
        });
      } finally {
        isApplyingDom = false;
      }
    }

    // Strictly local lookup against repository-reviewed static phrases loaded in `dictionary`.
    // Unknown or dynamic DOM text (player names, server titles, logs, IDs) never leaves the browser.
    function lookupReviewedSegment(segment: string): string | null {
      const trimmed = segment.trim();
      if (!trimmed || trimmed.length > 500) return null;

      const exact = dictionary[trimmed] || lowerDictionary.get(trimmed.toLowerCase());
      if (exact) return exact;

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
      if (!trimmed || trimmed.length > 500) return null;

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
            const lastApplied = lastAppliedTextByNode.get(node);
            if (!originalTextByNode.has(node) || (lastApplied !== undefined && currentVal !== lastApplied)) {
              originalTextByNode.set(node, currentVal);
            }
            const sourceVal = originalTextByNode.get(node) ?? currentVal;
            const replacement = translatePreservingWhitespace(sourceVal);
            if (replacement !== null && node.nodeValue !== replacement) {
              node.nodeValue = replacement;
              lastAppliedTextByNode.set(node, replacement);
            }
          }
          node = walker.nextNode();
        }

        const elements = document.body.querySelectorAll("[placeholder],[title],[aria-label]");
        elements.forEach((el) => {
          if (shouldSkipElement(el)) return;
          let origAttrs = originalAttrsByElement.get(el);
          if (!origAttrs) {
            origAttrs = {};
            originalAttrsByElement.set(el, origAttrs);
          }
          for (const attr of TRANSLATABLE_ATTRS) {
            const val = el.getAttribute(attr);
            if (!val) continue;
            if (origAttrs[attr] === undefined) {
              origAttrs[attr] = val;
            }
            const replacement = translatePreservingWhitespace(origAttrs[attr]);
            if (replacement !== null && val !== replacement) {
              el.setAttribute(attr, replacement);
            }
          }
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
        characterData: true
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
