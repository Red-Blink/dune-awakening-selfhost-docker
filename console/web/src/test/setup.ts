import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach } from "vitest";
import { setConsoleAccess } from "../lib/consoleAccess";

// Standalone feature tests explicitly represent the local owner session.
// App tests replace this with their real /auth/me fixture during bootstrap.
beforeEach(() => setConsoleAccess("ready", { username: "owner", displayName: "Owner", tier: "owner" }, ["*"]));

afterEach(() => {
  cleanup();
  setConsoleAccess("loading");
});
