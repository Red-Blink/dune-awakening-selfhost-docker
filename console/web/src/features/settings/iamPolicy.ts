// Pure policy-resolution helpers shared by the IAM editor and its tests.
//
// Extracted from IamPolicyEditor.tsx so the tests exercise the REAL functions.
// The first version of those tests re-implemented these two by hand, which
// would have passed happily while the component drifted -- the same
// tests-a-copy-not-the-code failure this file's own history is full of.
//
// These must mirror console/api/src/policy.js: explicit Deny beats Allow,
// default deny, with `*` and `namespace:*` wildcards.

export type PolicyStatement = { Effect: "Allow" | "Deny"; Action: string[] };

// Mirror of console/api/src/policy.js matchAction, character-for-character, so
// the builder/Test grid never shows a checkbox state the server would refuse.
// The earlier version handled only `*`, exact, and a partial `:*`, so a
// hand-authored Deny using the `-*` prefix form (e.g. `players:reset-*`, which
// actions.js documents as supported) or an embedded `*` rendered as GRANTED
// while the server denied it -- inviting an operator to delete the Deny "to fix
// the checkbox" and complete an escalation the UI invented.
function matchPattern(pattern: string, action: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(":*")) {
    const ns = pattern.slice(0, -2);
    return action === ns || action.startsWith(ns + ":");
  }
  if (pattern.endsWith("-*")) {
    return action.startsWith(pattern.slice(0, -1));
  }
  if (pattern === action) return true;
  if (pattern.includes("*")) {
    // Same transform as the server's matchAction(): only `*` is special, every
    // other character is escaped so a stray metacharacter can never throw.
    const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
    return new RegExp("^" + escaped + "$").test(action);
  }
  return false;
}

export function iamActionAllowed(iamAction: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (matchPattern(pattern, iamAction)) return true;
  }
  return false;
}

// Whether a single IAM action is granted (Allow minus Deny) under a given
// statement list. Shared by the grid's `allowedActions` memo and
// toggleAction's branch decision (review finding) -- toggleAction used to
// branch on the memo's value even when computing over a JUST-mutated,
// freshly-parsed statement list (e.g. two toggles of the same action fired
// before React re-renders between them), reading stale grant/deny state and
// taking the wrong branch.
export function actionGrantedByStatements(statements: PolicyStatement[], action: string): boolean {
  const allow: string[] = [];
  const deny: string[] = [];
  for (const st of statements) for (const a of st.Action) (st.Effect === "Deny" ? deny : allow).push(a);
  if (iamActionAllowed(action, deny)) return false;
  return iamActionAllowed(action, allow);
}

// Which catalog routes a tier may actually reach under `statements`.
//
// This used to read Allow only, so a tier carrying `Deny settings:*` --
// exactly how the default admin policy keeps the credential actions owner-only
// -- rendered its checkboxes as GRANTED while the server denied every call.
// That is the state that leads an operator to remove the Deny "to make the
// checkbox work", completing a privilege escalation the UI invented.
export function resolvedAllowedActions(
  statements: PolicyStatement[],
  actionMap: Record<string, string>
): Set<string> {
  const allowPatterns: string[] = [];
  const denyPatterns: string[] = [];
  for (const stmt of statements) {
    for (const a of stmt.Action) (stmt.Effect === "Deny" ? denyPatterns : allowPatterns).push(a);
  }
  const allowed = new Set<string>();
  for (const route of Object.keys(actionMap)) {
    const iamAction = actionMap[route];
    if (iamActionAllowed(iamAction, denyPatterns)) continue; // explicit Deny wins
    if (iamActionAllowed(iamAction, allowPatterns)) allowed.add(route);
  }
  return allowed;
}

// Group by the IAM ACTION's namespace -- what policy.js evaluates -- not by the
// URL's first path segment. The two diverge deliberately for several
// routes: `settings:regenerate-recovery-codes` lives at /api/auth/2fa/..., and
// Landsraad, Care Package and Map entries diverge too. Deriving it from the
// path put an owner-only credential permission in the catch-all bucket, under a
// card header reading "Care-package".
export function nsFromAction(routeKey: string, actionMap: Record<string, string> = {}): string {
  const iamAction = actionMap[routeKey];
  if (iamAction && iamAction.includes(":")) return iamAction.split(":")[0].toLowerCase();
  const afterApi = routeKey.split("/api/")[1];
  if (!afterApi) return "other";
  return afterApi.split("/")[0].toLowerCase();
}
