import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConsoleLanguageObserver } from "./ConsoleLanguageObserver";
import { LanguagePanel } from "./LanguagePanel";
import { LANGUAGE_STORAGE_KEY, loadSelectedLanguage, saveSelectedLanguage } from "./i18nClient";

describe("LanguagePanel, ConsoleLanguageObserver & Privacy Boundaries", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.clear();
  });

  it("defaults to EN and persists selected language in localStorage", () => {
    expect(loadSelectedLanguage()).toBe("EN");
    saveSelectedLanguage("de");
    expect(loadSelectedLanguage()).toBe("DE");
    expect(window.localStorage.getItem(LANGUAGE_STORAGE_KEY)).toBe("DE");
  });

  it("renders language catalog with Peer Sync opt-in disabled by default, opens Settings gear icon, and switches language", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/api/i18n/languages")) {
        return new Response(
          JSON.stringify({
            version: 1,
            updatedAt: "2026-10-30T16:00:00Z",
            totalSourceStrings: 2293,
            autoSyncLanguages: ["DE", "FR"],
            encryptedKeyConfigured: true,
            encryptionAlgorithm: "AES-256-GCM (scrypt)",
            syncInProgress: false,
            lastDeltaSyncAt: null,
            lastDeltaSyncError: null,
            mesh: {
              nodeId: "dune-node-test",
              peerSyncEnabled: false,
              enrollmentConfigured: false,
              peers: [],
              exchangedPacksCount: 0,
              verifiedPeersCount: 0,
              lastMeshSyncAt: null
            },
            languages: [
              {
                code: "EN",
                deeplCode: "EN-US",
                name: "English",
                nativeName: "English",
                region: "GB / US",
                dir: "ltr",
                core: true,
                translatedCount: 2293,
                coveragePercent: 100,
                cachedInDb: true
              },
              {
                code: "DE",
                deeplCode: "DE",
                name: "German",
                nativeName: "Deutsch",
                region: "DE / AT / CH",
                dir: "ltr",
                core: true,
                translatedCount: 2293,
                coveragePercent: 100,
                cachedInDb: true
              }
            ]
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/api/i18n/translations?lang=DE")) {
        return new Response(
          JSON.stringify({
            lang: "DE",
            name: "German",
            nativeName: "Deutsch",
            dir: "ltr",
            totalSourceStrings: 2293,
            translatedCount: 2293,
            translations: { Home: "Startseite" }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      if (url.includes("/api/i18n/settings")) {
        return new Response(
          JSON.stringify({
            ok: true,
            mesh: {
              nodeId: "dune-node-test",
              peerSyncEnabled: true,
              enrollmentConfigured: true,
              peers: [],
              exchangedPacksCount: 0,
              verifiedPeersCount: 0,
              lastMeshSyncAt: null
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    render(<LanguagePanel />);

    await waitFor(() => {
      expect(screen.getByText("Deutsch")).toBeInTheDocument();
    });

    expect(screen.getByText("2293")).toBeInTheDocument();
    expect(screen.getByText("Phrases")).toBeInTheDocument();
    expect(screen.getByText("Dune-Docker Peer Mesh")).toBeInTheDocument();
    expect(screen.getByText("Disabled")).toBeInTheDocument();

    const settingsBtn = screen.getByLabelText("Language Settings");
    fireEvent.click(settingsBtn);

    expect(screen.getByText("Important Notice (DeepL API Key)")).toBeInTheDocument();
    expect(screen.getByText("Dune-Docker Peer Language Pack Sync (Token Saver)")).toBeInTheDocument();

    const toggleSwitch = screen.getByRole("switch", { name: "Toggle Dune-Docker Peer Language Pack Sync" });
    expect(toggleSwitch).toHaveAttribute("aria-checked", "false");
    fireEvent.click(toggleSwitch);

    const searchInput = screen.getByPlaceholderText("Search language by name or code...");
    fireEvent.change(searchInput, { target: { value: "Deutsch" } });
    expect(screen.getByText("Deutsch")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Deutsch"));

    await waitFor(() => {
      expect(loadSelectedLanguage()).toBe("DE");
    });

    expect(fetchSpy).toHaveBeenCalled();
  });

  it("never uploads dynamic or private DOM screen text from ConsoleLanguageObserver", async () => {
    const requestedUrls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("/api/i18n/translations?lang=DE")) {
        return new Response(
          JSON.stringify({
            lang: "DE",
            name: "German",
            nativeName: "Deutsch",
            dir: "ltr",
            totalSourceStrings: 2,
            translatedCount: 2,
            translations: {
              Home: "Startseite",
              "Server Control": "Serversteuerung"
            }
          }),
          { status: 200, headers: { "content-type": "application/json" } }
        );
      }
      throw new Error(`Unexpected network call from DOM observer: ${url}`);
    });

    saveSelectedLanguage("DE");

    render(
      <div>
        <ConsoleLanguageObserver />
        <span data-testid="reviewed-ui">Home</span>
        <span data-testid="private-player">Player_Atreides_Private_Character_9912</span>
        <span data-testid="private-server">Secret Guild Note: Do Not Share</span>
      </div>
    );

    await waitFor(() => {
      expect(screen.getByTestId("reviewed-ui").textContent).toBe("Startseite");
    });

    // Private dynamic content remains untouched in DOM and is NEVER sent over the network
    expect(screen.getByTestId("private-player").textContent).toBe("Player_Atreides_Private_Character_9912");
    expect(screen.getByTestId("private-server").textContent).toBe("Secret Guild Note: Do Not Share");
    expect(requestedUrls.some((u) => u.includes("/api/i18n/translate"))).toBe(false);
  });
});
