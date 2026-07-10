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
    // Only scan data-display elements — skip forms, inputs, buttons, labels
    document.querySelectorAll("table td, table th, .metric-card, .card, .section-heading h2, .section-heading h3, .panel-title h2, .DataTable td, .guilds-table td, .players-table td").forEach(tag);
    document.querySelectorAll("tr").forEach(function(row) {
      if (row.hasAttribute("data-tagged-faction") || row.hasAttribute("data-tagged-spice")) return;
      // Only tag rows inside data tables, not form rows
      if (row.closest("table") && row.closest("table").classList.contains("guilds-table") || row.closest("table.players-table")) {
        tag(row);
      }
    });
  }

  scan();
  new MutationObserver(() => setTimeout(scan, 200)).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "data-tab"] });
})();
