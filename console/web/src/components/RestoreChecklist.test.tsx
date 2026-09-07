import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RestoreChecklist, buildRestoreRows, imageLoadProgress, installedAssetsSize } from "./RestoreChecklist";

describe("buildRestoreRows", () => {
  it("splits the list into done, running and waiting around the current step", () => {
    const rows = buildRestoreRows({ current: "apply" });
    expect(rows.map((row) => row.state)).toEqual(["done", "done", "active", "pending", "pending"]);
  });

  it("shows every step waiting before the restore starts", () => {
    const rows = buildRestoreRows({ current: null });
    expect(rows.map((row) => row.state)).toEqual(["pending", "pending", "pending", "pending", "pending"]);
    expect(rows[4].label).toBe("Restart the console");
  });

  it("marks only the step that failed, leaving the earlier ones done", () => {
    const rows = buildRestoreRows({ current: "verify", failed: true });
    expect(rows.map((row) => row.state)).toEqual(["done", "failed", "pending", "pending", "pending"]);
    // A failed step says what it was attempting, not what it achieved.
    expect(rows[1].label).toBe("Verifying the passphrase — preview only");
  });

  it("reports every step done once the sequence finishes", () => {
    const rows = buildRestoreRows({ current: "reload", finished: true });
    expect(rows.map((row) => row.state)).toEqual(["done", "done", "done", "done", "done"]);
    expect(rows[0].label).toBe("Game files installed");
  });

  it("carries a detail only for the step it belongs to", () => {
    const rows = buildRestoreRows({ current: "apply", details: { assets: "4.9 GB" } });
    expect(rows[0].detail).toBe("4.9 GB");
    expect(rows.slice(1).every((row) => row.detail === "")).toBe(true);
  });
});

describe("installedAssetsSize", () => {
  it("reads the size the install printed", () => {
    expect(installedAssetsSize(["=== Load updated Funcom image tarballs ===", "DUNE_GAME_ASSETS_SIZE=4.9G"])).toBe("4.9 GB");
  });

  it("handles a smaller install and a whole number", () => {
    expect(installedAssetsSize(["DUNE_GAME_ASSETS_SIZE=812M"])).toBe("812 MB");
    expect(installedAssetsSize(["DUNE_GAME_ASSETS_SIZE=5G"])).toBe("5 GB");
  });

  it("takes the last marker, so a re-run does not report the earlier size", () => {
    expect(installedAssetsSize(["DUNE_GAME_ASSETS_SIZE=1.1G", "DUNE_GAME_ASSETS_SIZE=4.9G"])).toBe("4.9 GB");
  });

  it("renders no detail rather than a wrong one when the install said nothing", () => {
    // An older install-assets, or one that failed before the load step.
    expect(installedAssetsSize(["=== Detect loaded image tags ===", ""])).toBe("");
  });
});

describe("imageLoadProgress", () => {
  it("counts the newest image the install reported", () => {
    expect(imageLoadProgress([
      "DUNE_GAME_ASSETS_LOAD=1/11 seabass-server.tar",
      ">>> docker load -i /srv/dune/server/images/seabass-server.tar",
      "DUNE_GAME_ASSETS_LOAD=4/11 gateway.tar"
    ])).toBe("Loading images 4 of 11");
  });

  it("ignores the redraw noise docker load surrounds it with", () => {
    // Everything else on these lines strips down to nothing.
    expect(imageLoadProgress(["DUNE_GAME_ASSETS_LOAD=2/3 x.tar", "[1A[2K", ""])).toBe("Loading images 2 of 3");
  });

  it("shows nothing before the first image starts loading", () => {
    expect(imageLoadProgress(["=== Load updated Funcom image tarballs ==="])).toBe("");
  });
});

describe("RestoreChecklist", () => {
  it("labels each row's state for anyone not reading the colour", () => {
    render(<RestoreChecklist title="Restoring" rows={buildRestoreRows({ current: "apply", details: { assets: "4.9 GB" } })} note="Sign in again." />);

    expect(screen.getByLabelText("In progress")).toBeTruthy();
    expect(screen.getAllByLabelText("Done")).toHaveLength(2);
    expect(screen.getAllByLabelText("Waiting")).toHaveLength(2);
    expect(screen.getByText("4.9 GB")).toBeTruthy();
    expect(screen.getByText("Sign in again.")).toBeTruthy();
  });
});
