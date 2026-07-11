// Auto-tags DOM elements with data-tagged-faction or data-tagged-spice
// based on text content. Separate from data-faction (used for CSS theme).
(function init() {
  const FACTION_RE = { atreides: /atreides/i, harkonnen: /harkonnen/i };
  const SPICE_RE = /spice|melange/i;

  function tag(el) {
    if (!el?.textContent || el.hasAttribute("data-tagged-faction") || el.hasAttribute("data-tagged-spice")) return;
    const t = el.textContent.slice(0, 100).toLowerCase();
    for (const [f, re] of Object.entries(FACTION_RE)) {
      if (re.test(t)) { el.setAttribute("data-tagged-faction", f); return; }
    }
    if (SPICE_RE.test(t)) el.setAttribute("data-tagged-spice", "");
  }

  function scan() {
    // Only tag leaf elements by their OWN text content — never tag containers
    document.querySelectorAll(".guilds-table td, .guilds-table th, .players-table td, .players-table th, .panel-title h2, .section-heading h2, .section-heading h3").forEach(tag);
    // Tag metric-card strong elements only if the card contains faction text
    document.querySelectorAll(".metric-card").forEach(function(card) {
      if (card.hasAttribute("data-tagged-faction") || card.hasAttribute("data-tagged-spice")) return;
      var t = (card.textContent || "").slice(0, 100).toLowerCase();
      if (/atreides/i.test(t)) card.setAttribute("data-tagged-faction", "atreides");
      else if (/harkonnen/i.test(t)) card.setAttribute("data-tagged-faction", "harkonnen");
    });
  }

  scan();
  new MutationObserver(() => setTimeout(scan, 200)).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-tab"] });
})();
