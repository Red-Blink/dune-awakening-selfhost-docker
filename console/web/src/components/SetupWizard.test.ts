import { describe, expect, it } from "vitest";
import { configFromSetupState, DATACENTER_ID_GUIDANCE, DIRECT_LISTING_PING_GUIDANCE, validDatacenterId } from "./SetupWizard";

describe("SetupWizard Datacenter ID", () => {
  it("loads the dedicated value when configured", () => {
    expect(configFromSetupState({
      HOST_DATACENTER_ID: "ping.example.com",
      SERVER_PROVIDER: "legacy-provider"
    }).HOST_DATACENTER_ID).toBe("ping.example.com");
  });

  it("migrates the legacy Provider value for an existing installation", () => {
    expect(configFromSetupState({ SERVER_PROVIDER: "legacy-provider" }).HOST_DATACENTER_ID).toBe("legacy-provider");
  });

  it("validates hostnames and short IDs", () => {
    expect(validDatacenterId("ping.example.com")).toBe(true);
    expect(validDatacenterId("dune-docker")).toBe(true);
    expect(validDatacenterId("https://example.com")).toBe(false);
  });

  it("explains the recommended resolvable hostname without promising Funcom ping", () => {
    expect(DATACENTER_ID_GUIDANCE).toContain("IPv4 A record points directly to the Server IP");
    expect(DATACENTER_ID_GUIDANCE).toContain("without https://, a port, or a path");
    expect(DATACENTER_ID_GUIDANCE).toContain("Funcom may still display ping intermittently");
  });

  it("explains the optional direct listing ping path and relay fallback", () => {
    expect(DIRECT_LISTING_PING_GUIDANCE).toContain("UDP 32000–32015");
    expect(DIRECT_LISTING_PING_GUIDANCE).toContain("host firewall");
    expect(DIRECT_LISTING_PING_GUIDANCE).toContain("internet-to-DMZ firewall or router");
    expect(DIRECT_LISTING_PING_GUIDANCE).toContain("optional");
    expect(DIRECT_LISTING_PING_GUIDANCE).toContain("ping relay instead");
  });
});
