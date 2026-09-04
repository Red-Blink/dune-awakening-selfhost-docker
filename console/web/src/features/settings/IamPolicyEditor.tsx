import { useEffect, useState, useMemo } from "react";
import { actionGrantedByStatements, iamActionAllowed } from "./iamPolicy";
import { api } from "../../api/client";

interface PolicyStatement {
  Effect: "Allow" | "Deny";
  Action: string[];
}

interface PolicyCatalog {
  policies: Record<string, { version: number; tier: string; statements: PolicyStatement[] }>;
  actions: string[];
  actionMap: Record<string, string>;
  allActions?: string[];
  namespaces: Record<string, string>;
}

// The complete distinct IAM-action list the grid renders. Prefer the catalog's
// allActions (which includes parameterized-route actions that have no literal
// actionMap key); fall back to actionMap values for an older backend.
function distinctActions(catalog?: PolicyCatalog | null): string[] {
  if (catalog?.allActions?.length) return catalog.allActions;
  return [...new Set(Object.values(catalog?.actionMap || {}))].filter((a): a is string => typeof a === "string");
}

const TIERS = ["owner", "admin", "moderator", "player"] as const;

function parseStatements(text: string): PolicyStatement[] | null {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return null;
    for (const stmt of parsed) {
      if (!stmt.Effect || !["Allow", "Deny"].includes(stmt.Effect)) return null;
      if (!stmt.Action || (!Array.isArray(stmt.Action) && typeof stmt.Action !== "string")) return null;
    }
    // Normalize Action to an array so downstream code (toggle/save/eval) never
    // has to special-case the string form the owner tier uses ("*").
    return parsed.map((stmt: any) => ({ ...stmt, Action: Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action] }));
  } catch { return null; }
}

// Human label for an IAM ACTION (e.g. "bases:read" -> "Read",
// "server:restart-service" -> "Restart Service", "admin:motd:write" ->
// "Motd Write"). The grid is action-centric: one row per grantable action,
// not per HTTP route (many routes share one action).
function actionLabel(action: string): string {
  const rest = action.includes(":") ? action.slice(action.indexOf(":") + 1) : action;
  return rest.split(/[:-]/).map(w => (w ? w.charAt(0).toUpperCase() + w.slice(1) : w)).join(" ");
}

// Plain-language explanation for actions whose label alone ("Mutate",
// "Write Config") doesn't say what the action actually does. Kept in sync
// with the inline comments in policy.js's admin Deny block -- these are the
// same "crown jewel" actions an operator is most likely to click and wonder
// why they can't grant. Not exhaustive: only actions where the bare label is
// genuinely ambiguous get an entry.
const ACTION_DESCRIPTIONS: Record<string, string> = {
  "players:mutate": "Give items, add currency, or reset a player's progression (economy).",
  "settings:*": "IAM policies, the admin password, the console port, and 2FA recovery codes.",
  "server:write-credentials": "The Funcom game-server token and the server's public IP.",
  "database:write-config": "The database password.",
  "database:mutate": "Direct edits to database tables.",
  "database:export": "A full database dump (whole-database exfiltration risk).",
  "admin:transfer-settings:write": "Character/server-transfer policy (identity + economy impact).",
  "updates:apply": "Deploys new code to the running server.",
  "updates:fix": "Alters the running code to repair a failed update.",
  "updates:repair": "Alters the running code to repair a failed update.",
  "backups:restore": "Overwrites the live database from a backup (irreversible).",
  "backups:import": "Loads an untrusted backup file into the live database.",
  "addons:install": "Installs third-party code into the console process.",
  "addons:update": "Updates third-party code running in the console process.",
  "setup:write": "First-run provisioning of the console itself.",
  "carepackage:grant": "Mints an in-game care package (creates value from nothing).",
  "carepackage:write-config": "Changes care package economy configuration.",
  "exchange:market": "Seeds or alters the player-market economy.",
  "exchange:market-write": "Seeds or alters the player-market economy.",
  "admin:items:read": "Reference item-type catalog used by Character Admin's give-item tool -- not a live inventory.",
  "admin:vehicles:read": "Reference vehicle-type catalog used by Character Admin -- not the same as the separate \"Vehicles: Read\" permission, which covers the live in-game Vehicles panel.",
  "admin:skills:read": "Reference skill-module catalog used by Character Admin's skill editor.",
};

// A few actions' mechanical label (the bare last path segment, title-cased --
// "Mutate", "Items Read", "Vehicles Read") is meaningless or misleading on
// its own, and a hover tooltip alone doesn't fix that: an operator scanning
// the grid shouldn't have to hover every row to find the ones that matter.
// Override the VISIBLE label for exactly these -- the admin:*:read catalog
// lookups (which also collide in name with unrelated live-data namespaces,
// vehicles especially) and players:mutate (the economy-mutation bucket,
// which "Mutate" alone gives no hint of).
const ACTION_LABEL_OVERRIDES: Record<string, string> = {
  "admin:items:read": "Item Catalog",
  "admin:vehicles:read": "Vehicle Catalog",
  "admin:skills:read": "Skill Catalog",
  "players:mutate": "Give Items / Currency",
};

function actionDescription(action: string): string {
  return ACTION_DESCRIPTIONS[action] || "";
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function namespaceLabel(ns: string): string {
  const readable: Record<string, string> = {
    server: "Server", players: "Players", guilds: "Guilds", bases: "Bases",
    storage: "Storage", maps: "Maps", sietches: "Sietches", deepdesert: "Deep Desert",
    admin: "Admin Tools", landsraad: "Landsraad", addons: "Addons",
    carepackage: "Care Package", blueprints: "Blueprints", database: "Database",
    backups: "Backups", logs: "Logs", settings: "Settings", updates: "Updates",
    setup: "Setup", "public-directory": "Public Directory",
  };
  return readable[ns] || capitalize(ns);
}

export function IamPolicyEditor() {
  const [catalog, setCatalog] = useState<PolicyCatalog | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [selectedTier, setSelectedTier] = useState<string>("admin");
  const [jsonText, setJsonText] = useState("");
  const [jsonError, setJsonError] = useState("");
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [editorTab, setEditorTab] = useState<"builder" | "json" | "test">("builder");
  const [testResults, setTestResults] = useState<Record<string, boolean> | null>(null);
  const [testError, setTestError] = useState("");
  const [toggleHint, setToggleHint] = useState("");
  const [search, setSearch] = useState("");

  useEffect(() => {
    api<PolicyCatalog>("/api/settings/iam/policies").then((data) => {
      setCatalog(data);
      const doc = data.policies[selectedTier];
      if (doc) setJsonText(JSON.stringify(doc.statements, null, 2));
    }).catch(() => { setLoadError(true); });
  }, []);

  if (!catalog && loadError) return <section className="iam-editor-error"><h3>Failed to load IAM policies</h3><button onClick={() => { setLoadError(false); window.location.reload(); }}>Retry</button></section>;

  const selectTier = (tier: string) => {
    setSelectedTier(tier);
    setSaved(false);
    setTestResults(null);
    setSearch("");
    setToggleHint("");
    if (catalog) {
      const doc = catalog.policies[tier];
      setJsonText(doc ? JSON.stringify(doc.statements, null, 2) : "[]");
    }
  };

  // null while the JSON tab holds unparseable text. The grid must then be
  // read-only: treating an unparseable draft as "no statements" made every box
  // show unchecked, and one click replaced the operator's whole draft with a
  // single Allow -- which Save would then persist.
  const parsedDraft = useMemo(() => parseStatements(jsonText), [jsonText]);
  const draftInvalid = parsedDraft === null;
  const statements = useMemo(() => parsedDraft || [], [parsedDraft]);
  // Which IAM ACTIONS the draft grants (Allow minus Deny), computed over the
  // distinct actions in the catalog -- not routes, so one action = one checkbox.
  const allowedActions = useMemo(() => {
    const granted = new Set<string>();
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      if (actionGrantedByStatements(statements, action)) granted.add(action);
    }
    return granted;
  }, [statements, catalog]);

  // A checkbox can only cleanly toggle an EXACT Allow literal. When a permission
  // is granted by a wildcard (e.g. "server:*") or blocked by a Deny, the grid
  // can't express the change -- mark it locked (still clickable, so the hint
  // fires) and point the operator at the JSON tab.
  const { allowLiterals, denyPatterns } = useMemo(() => {
    const al = new Set<string>();
    const dp: string[] = [];
    for (const st of statements) {
      if (st.Effect === "Allow") for (const a of st.Action) al.add(a);
      else for (const a of st.Action) dp.push(a);
    }
    return { allowLiterals: al, denyPatterns: dp };
  }, [statements]);

  const lockReason = (iamAction: string): string => {
    const desc = actionDescription(iamAction);
    const prefix = desc ? `${desc} ` : "";
    if (iamActionAllowed(iamAction, denyPatterns)) return `${prefix}Blocked by a Deny rule — edit in the JSON tab.`;
    if (allowedActions.has(iamAction) && !allowLiterals.has(iamAction)) return `${prefix}Granted by a wildcard rule — edit in the JSON tab.`;
    return "";
  };

  const namespaceOrder = [
    "server", "players", "guilds", "bases", "storage", "maps",
    "sietches", "deepdesert", "admin", "landsraad", "addons",
    "carepackage", "blueprints", "vehicles", "exchange", "database",
    "backups", "logs", "settings", "updates", "setup", "public-directory",
  ];

  const groupedActions = useMemo(() => {
    if (!catalog) return {};
    const groups: Record<string, string[]> = {};
    for (const ns of namespaceOrder) groups[ns] = [];
    const other: string[] = [];
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      const ns = action.includes(":") ? action.split(":")[0].toLowerCase() : "other";
      if (groups[ns]) {
        groups[ns].push(action as string);
      } else {
        other.push(action as string);
      }
    }
    for (const ns of Object.keys(groups)) groups[ns].sort();
    if (other.length) groups["other"] = other.sort();
    for (const ns of Object.keys(groups)) {
      if (groups[ns].length === 0) delete groups[ns];
    }
    return groups;
  }, [catalog]);

  const filteredGroups = useMemo(() => {
    if (!search.trim()) return groupedActions;
    const q = search.toLowerCase();
    const result: Record<string, string[]> = {};
    for (const [ns, actions] of Object.entries(groupedActions)) {
      const matching = actions.filter(a =>
        a.toLowerCase().includes(q) || actionLabel(a).toLowerCase().includes(q)
      );
      if (matching.length) result[ns] = matching;
    }
    return result;
  }, [groupedActions, search]);

  // Reads the live jsonText via a functional setJsonText update rather than
  // the value captured in this closure (review finding): two toggles fired
  // before React re-renders between them (e.g. a future bulk/"select all"
  // action calling this in a loop) would otherwise both compute `updated`
  // from the same stale text, and the second setJsonText call would silently
  // overwrite the first toggle's change. The branch decision below must read
  // the same freshly-parsed `stmts`, not the outer `allowedActions` memo
  // (second review finding, still live after the first fix): that memo is
  // only current for the last completed render, so a second toggle in the
  // same tick would branch on stale state and could re-grant an action it
  // just revoked (or vice versa) instead of no-op'ing or reverting.
  const toggleAction = (iamAction: string) => {
    setJsonText((currentJsonText) => {
      const stmts = parseStatements(currentJsonText);
      if (!stmts) {
        setToggleHint("The JSON tab contains invalid JSON, so permissions cannot be changed here until it is fixed.");
        return currentJsonText;
      }
      setToggleHint("");
      let updated: PolicyStatement[];

      if (actionGrantedByStatements(stmts, iamAction)) {
        // Revoke. A checkbox can only remove an exact Allow literal; a grant that
        // comes from a wildcard ("server:*" or "*") cannot be narrowed here
        // without rewriting the wildcard. Filtering by !== would leave the
        // wildcard in place and the box would snap back -- tell the operator to
        // use the JSON tab instead of silently doing nothing.
        const hasExactLiteral = stmts.some(st => st.Effect === "Allow" && st.Action.includes(iamAction));
        if (!hasExactLiteral) {
          setToggleHint(`${iamAction} is granted by a wildcard rule, not a single permission. Edit the JSON tab to change wildcard grants.`);
          return currentJsonText;
        }
        updated = stmts.map(st => {
          if (st.Effect !== "Allow") return st;
          return { ...st, Action: st.Action.filter(a => a !== iamAction) };
        }).filter(st => st.Action.length > 0);
      } else {
        // Grant. A standing Deny (e.g. admin's "Deny settings:*") overrides any
        // Allow, so adding the literal would change nothing -- say so rather than
        // let the box appear to do nothing.
        const denyBlocked = stmts.some(st => st.Effect === "Deny" && iamActionAllowed(iamAction, st.Action));
        if (denyBlocked) {
          setToggleHint(`${iamAction} is blocked by a Deny rule. Remove that Deny in the JSON tab first.`);
          return currentJsonText;
        }
        updated = [...stmts];
        let allowStmt = updated.filter(st => st.Effect === "Allow").pop();
        if (!allowStmt) {
          allowStmt = { Effect: "Allow" as const, Action: [] };
          updated.push(allowStmt);
        }
        if (!allowStmt.Action.includes(iamAction)) {
          allowStmt.Action = [...allowStmt.Action, iamAction];
        }
      }
      setSaved(false);
      return JSON.stringify(updated, null, 2);
    });
  };

  const validateJson = (text: string): PolicyStatement[] | null => {
    try {
      const parsed = JSON.parse(text);
      if (!Array.isArray(parsed)) throw new Error("Must be an array of statements");
      for (const stmt of parsed) {
        if (!stmt.Effect || !["Allow", "Deny"].includes(stmt.Effect)) throw new Error(`Invalid Effect: ${stmt.Effect}`);
        if (!stmt.Action || (!Array.isArray(stmt.Action) && typeof stmt.Action !== "string")) throw new Error("Action must be a string or array");
      }
      setJsonError("");
      return parsed.map((stmt: any) => ({ ...stmt, Action: Array.isArray(stmt.Action) ? stmt.Action : [stmt.Action] }));
    } catch (e: any) {
      setJsonError(e.message);
      return null;
    }
  };

  const savePolicy = async () => {
    const valid = validateJson(jsonText);
    if (!valid || !catalog) return;
    if (selectedTier === "owner" && Array.isArray(valid) && valid.length === 0) {
      setJsonError("Cannot save an empty policy for the owner tier. At least one owner-level permission is required to prevent permanent lock-out.");
      return;
    }
    setSaving(true);
    try {
      // The route is PUT and replaces the WHOLE tier-keyed store, not a single
      // {tier, statements} document -- send every tier with this one swapped in.
      const nextPolicies = { ...catalog.policies, [selectedTier]: { version: 1, tier: selectedTier, statements: valid } };
      const result = await api<{ ok: boolean; policies: PolicyCatalog["policies"] }>(
        "/api/settings/iam/policy",
        { method: "PUT", body: JSON.stringify(nextPolicies) }
      );
      setCatalog({ ...catalog, policies: result.policies || nextPolicies });
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch (err) {
      setJsonError(err instanceof Error ? err.message : "Failed to save policy");
    }
    setSaving(false);
  };

  const runTest = () => {
    const valid = validateJson(jsonText);
    if (!valid || !catalog) return;
    setTestError("");
    // Evaluate the DRAFT statements locally -- resolvedAllowedActions mirrors
    // console/api/src/policy.js. The server's /policy/test route evaluates the
    // SAVED, live policy, not this unsaved edit, so a local pass is what a
    // pre-save "what would this allow" preview actually needs (and avoids a
    // round-trip). One row per IAM action, deduped by the actionMap.
    const allow: string[] = [];
    const deny: string[] = [];
    for (const st of valid) for (const a of st.Action) (st.Effect === "Deny" ? deny : allow).push(a);
    const results: Record<string, boolean> = {};
    for (const action of distinctActions(catalog)) {
      if (typeof action !== "string") continue;
      results[action] = !iamActionAllowed(action, deny) && iamActionAllowed(action, allow);
    }
    setTestResults(results);
  };

  if (!catalog) return <section className="iam-editor-loading"><p className="loading-dots">Loading policies</p></section>;

  return (
    <section className="iam-policy-editor">
      <div className="iam-tier-selector" role="group" aria-label="Policy tier">
        {TIERS.map((tier) => (
          <button key={tier} className={`iam-tier-btn ${selectedTier === tier ? "active" : ""}`} aria-pressed={selectedTier === tier} onClick={() => selectTier(tier)}>
            {capitalize(tier)}
          </button>
        ))}
      </div>

      <div className="iam-editor-tabs" role="tablist" aria-label="Policy editor view">
        <button role="tab" id="iam-tab-builder" aria-selected={editorTab === "builder"} aria-controls="iam-panel-builder" className={editorTab === "builder" ? "active" : ""} onClick={() => setEditorTab("builder")}>Permissions</button>
        <button role="tab" id="iam-tab-json" aria-selected={editorTab === "json"} aria-controls="iam-panel-json" className={editorTab === "json" ? "active" : ""} onClick={() => setEditorTab("json")}>JSON</button>
        <button role="tab" id="iam-tab-test" aria-selected={editorTab === "test"} aria-controls="iam-panel-test" className={editorTab === "test" ? "active" : ""} onClick={() => { runTest(); setEditorTab("test"); }}>Test</button>
      </div>

      <div className="iam-editor-body">
        {editorTab === "builder" && (
          <div id="iam-panel-builder" role="tabpanel" aria-labelledby="iam-tab-builder">
            <div className="iam-search-bar">
              <input
                type="text"
                aria-label="Search permissions"
                placeholder="Search permissions..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
              {search && (
                <button className="iam-search-clear" aria-label="Clear search" onClick={() => setSearch("")}>×</button>
              )}
            </div>
            {draftInvalid && <p className="iam-toggle-hint iam-draft-invalid" role="alert">The JSON tab contains invalid JSON. Fix it there before changing permissions here -- the grid is read-only until it parses.</p>}
            {toggleHint && <p className="iam-toggle-hint" role="status">{toggleHint}</p>}
            <div className="iam-permission-grid">
              {Object.keys(filteredGroups).length === 0 && (
                <p className="iam-empty-hint">No permissions match your search.</p>
              )}
              {Object.entries(filteredGroups).map(([ns, actions]) => (
                <div key={ns} className="iam-ns-card">
                  <div className="iam-ns-header">
                    <span className="iam-ns-name">{namespaceLabel(ns)}</span>
                    <span className="iam-ns-count">
                      {actions.filter(a => allowedActions.has(a)).length}/{actions.length} allowed
                    </span>
                  </div>
                  <div className="iam-ns-actions">
                    {actions.map((action) => {
                      const lock = lockReason(action);
                      return (
                        <label key={action} className={`iam-perm-row ${allowedActions.has(action) ? "perm-on" : "perm-off"}${lock ? " perm-locked" : ""}`} title={lock || undefined}>
                          <input
                            type="checkbox"
                            checked={allowedActions.has(action)}
                            disabled={draftInvalid}
                            onChange={() => toggleAction(action)}
                          />
                          <span className="iam-perm-label" title={actionDescription(action) || undefined}>
                            {ACTION_LABEL_OVERRIDES[action] || actionLabel(action)}
                          </span>
                          {lock && <span className="iam-perm-lock" aria-hidden="true">🔒</span>}
                          <span className="iam-perm-action" title={action}>{action}</span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {editorTab === "json" && (
          <div className="iam-json-editor" id="iam-panel-json" role="tabpanel" aria-labelledby="iam-tab-json">
            <textarea
              className={`iam-json-textarea ${jsonError ? "has-error" : ""}`}
              value={jsonText}
              onChange={(e) => { setJsonText(e.target.value); setSaved(false); setJsonError(""); }}
              rows={16}
              spellCheck={false}
            />
            {jsonError && <p className="iam-json-error">{jsonError}</p>}
          </div>
        )}

        {editorTab === "test" && (
          <div className="iam-test-panel" id="iam-panel-test" role="tabpanel" aria-labelledby="iam-tab-test">
            {testError && <p className="error">{testError}</p>}
            {!testResults && (
              <button className="stable-action-button" onClick={runTest}>Run test</button>
            )}
            {testResults && (
              <>
                <div className="iam-test-summary">
                  <span className="test-count-allowed">{Object.values(testResults).filter(Boolean).length} allowed</span>
                  <span className="test-count-denied">{Object.values(testResults).filter(v => !v).length} denied</span>
                </div>
                <div className="iam-test-table">
                  {Object.entries(testResults).sort(([, a], [, b]) => (a === b ? 0 : a ? -1 : 1)).map(([action, allowed]) => (
                    <div key={action} className={`iam-test-row ${allowed ? "test-allowed" : "test-denied"}`}>
                      <span className={`test-indicator ${allowed ? "" : "test-blocked"}`}>{allowed ? "✓" : "✗"}</span>
                      <span className="test-action-name">{action}</span>
                    </div>
                  ))}
                </div>
                <button className="stable-action-button" onClick={runTest} style={{marginTop: "0.75rem"}}>Re-run test</button>
              </>
            )}
          </div>
        )}
      </div>

      <div className="iam-editor-footer">
        {jsonError && <p className="iam-json-error" style={{ marginBottom: "8px" }}>{jsonError}</p>}
        <button className="stable-action-button" onClick={savePolicy} disabled={saving || (editorTab === "json" && !!jsonError)}>
          {saving ? "Saving..." : saved ? "Saved" : `Save ${selectedTier} policy`}
        </button>
      </div>
    </section>
  );
}
