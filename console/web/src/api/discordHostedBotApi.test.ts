// Final integration review (CRITICAL): the OAuth callback page's own
// `window.location.replace("/")` redirect is a full document navigation --
// the SPA loads into a brand-new `window`, so a value stashed on the OLD
// window (the previous, now-fixed `window.__hostedBotOwnedGuilds__`
// mechanism) is already gone before this SPA's reader ever runs. This test
// crosses that actual navigation boundary rather than assuming it: it (a)
// calls the REAL server-side hostedBotOAuthReturnPage() to get the exact
// HTML the callback route sends the browser, (b) extracts and executes the
// embedded <script> body against a fake `window` object (standing in for
// "the callback page's window", which a real navigation discards) --
// exactly what a browser would do just before that navigation -- and (c)
// then calls the REAL frontend readOwnedGuilds() and asserts it recovers
// the correct list. Because (b) and (c) never share a `window` object, this
// can only pass if the mechanism the script writes to in (b) is something
// that outlives a `window` -- i.e. sessionStorage, keyed by origin -- not a
// plain property on a `window` instance. Reverting the fix back to a plain
// `window.__hostedBotOwnedGuilds__` property would make this test fail:
// step (b)'s fake `window` object would receive the property, step (c)'s
// readOwnedGuilds() would look at the REAL global `window`/sessionStorage
// (a different object from the fake one in (b)), and never find it.
import { describe, it, expect, beforeEach } from "vitest";
// Deliberate cross-package import: this test's whole point is to exercise
// the REAL function the OAuth callback route serves to the browser, not a
// duplicate/reimplementation of its logic. hostedBotOAuth.js is plain ESM
// with no bundler-specific syntax (only "node:crypto" and a relative
// sibling import), so it loads fine under Vitest's Node-based test runner
// despite living in the sibling console/api package.
// @ts-expect-error -- plain JS module in the sibling console/api package;
// it has no type declarations (and shouldn't need any just for this one
// cross-boundary test to import its return-page HTML generator).
import { hostedBotOAuthReturnPage } from "../../../api/src/integrations/discord/hostedBotOAuth.js";
import { discordHostedBotApi } from "./discordHostedBotApi";

describe("hostedBotOAuthReturnPage -> discordHostedBotApi.readOwnedGuilds crosses a real same-origin navigation", () => {
  beforeEach(() => {
    window.sessionStorage.clear();
  });

  it("recovers the real owned-guilds list after the callback script runs and the SPA's own reader runs in a DIFFERENT window", () => {
    const guilds = [
      { id: "111111111111111111", name: "Boundary Test Guild", owner: true as const },
      { id: "222222222222222222", name: "Second Guild", owner: true as const }
    ];
    const returnPageHtml = hostedBotOAuthReturnPage(guilds);

    // False positive: scriptMatch only reads already-generated test HTML
    // (returnPageHtml, built above from a test-controlled `guilds` array via
    // hostedBotOAuthReturnPage()) to assert on its shape -- it is never
    // written into a real page or DOM anywhere.
    const scriptMatch = returnPageHtml.match(/<script>([\s\S]*?)<\/script>/);
    // nosemgrep: javascript.lang.security.audit.unknown-value-with-script-tag.unknown-value-with-script-tag
    expect(scriptMatch, "the return page must embed exactly one <script> block").toBeTruthy();
    const scriptBody = scriptMatch![1];

    // Run the callback page's script against a FAKE window -- standing in
    // for the real callback page's own window, which a real
    // `window.location.replace(...)` navigation discards entirely. Only
    // `sessionStorage` (a real global, shared across same-origin windows,
    // NOT re-created per `window`) is left un-shadowed, so anything the
    // script writes there is what the SPA's brand-new window would still
    // see after the navigation completes.
    const replaceCalls: string[] = [];
    const fakeWindow = { location: { replace: (url: string) => { replaceCalls.push(url); } } };
    const runCallbackPageScript = new Function("window", scriptBody);
    runCallbackPageScript(fakeWindow);

    expect(replaceCalls, "the callback page must navigate to \"/\" exactly once").toEqual(["/"]);

    // Now call the REAL frontend reader -- exactly what runs inside the
    // SPA's brand-new window once that navigation lands. It has no access
    // to `fakeWindow` above; it only ever reads the real global
    // `window.sessionStorage`.
    const recovered = discordHostedBotApi.readOwnedGuilds();
    expect(recovered).toEqual(guilds);

    // Single-read-then-clear contract: a second call must come back empty,
    // matching the previous window-property mechanism's own contract.
    expect(discordHostedBotApi.readOwnedGuilds()).toEqual([]);
  });

  it("returns [] when nothing was ever stashed (missing value), and [] on a malformed value rather than throwing", () => {
    expect(discordHostedBotApi.readOwnedGuilds()).toEqual([]);
    window.sessionStorage.setItem("hostedBotOwnedGuilds", "{not valid json");
    expect(discordHostedBotApi.readOwnedGuilds()).toEqual([]);
  });

  it("regression guard: a value left on a plain window property (the old, broken mechanism) is never read", () => {
    (window as unknown as { __hostedBotOwnedGuilds__?: unknown }).__hostedBotOwnedGuilds__ = [
      { id: "999999999999999999", name: "Should Not Be Read", owner: true }
    ];
    expect(discordHostedBotApi.readOwnedGuilds()).toEqual([]);
    delete (window as unknown as { __hostedBotOwnedGuilds__?: unknown }).__hostedBotOwnedGuilds__;
  });
});
