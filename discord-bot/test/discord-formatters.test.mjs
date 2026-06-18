import test from "node:test";
import assert from "node:assert/strict";

import { formatCommandResponse } from "../scripts/discord-formatters.mjs";

test("health formatter emits a Discord card", () => {
  const response = formatCommandResponse("health", {
    ok: true,
    service: "dune-console-discord-adapter",
    enabled: true,
    experimental: true,
    readOnly: true,
    writesEnabled: false,
    liveRoutes: ["/health"],
    plannedRoutes: ["/population"],
    rolePolicy: {
      observerConfigured: true,
      moderatorConfigured: false,
      adminConfigured: true,
      ownerConfigured: true
    }
  });

  assert.equal(response.content, "");
  assert.equal(response.embeds.length, 1);
  assert.equal(response.embeds[0].title, "Arrakis Control Plane — Adapter Health");
  assert.match(response.embeds[0].fields.find((field) => field.name === "Safety").value, /Read-only/);
});

test("public status formatter summarizes maps and issues as card fields", () => {
  const response = formatCommandResponse("status", {
    ok: true,
    result: {
      title: "My Dune Server",
      overall: "ISSUE",
      region: "North America",
      population: "0/60",
      maps: [
        { name: "Survival_1", state: "READY", uptime: "Up 39 minutes" },
        { name: "Overmap", state: "READY", uptime: "Up 39 minutes" }
      ],
      issues: ["Overmap status is ISSUE"]
    }
  });

  const embed = response.embeds[0];
  assert.equal(embed.title, "My Dune Server");
  assert.equal(embed.fields.find((field) => field.name === "Population").value, "0/60");
  assert.match(embed.fields.find((field) => field.name === "Services").value, /Survival/);
  assert.match(embed.fields.find((field) => field.name === "Issues").value, /Overmap status/);
});

test("formatter derives missing client and S2S issues from structured status", () => {
  const response = formatCommandResponse("services", {
    ok: true,
    result: {
      overall: "ISSUE",
      services: [
        { name: "Overmap", status: "ISSUE", clients: "MISSING", s2s: "MISSING" },
        { name: "Survival_1", status: "READY", clients: "MISSING", s2s: "MISSING" }
      ]
    }
  });

  const issues = response.embeds[0].fields.find((field) => field.name === "Issues").value;
  const services = response.embeds[0].fields.find((field) => field.name === "Services").value;
  assert.doesNotMatch(issues, /Overall status is ISSUE/);
  assert.match(issues, /Overmap Clients is MISSING/);
  assert.match(issues, /Survival 1 S2S is MISSING/);
  assert.match(services, /Overmap/);
  assert.match(services, /Survival/);
});

test("formatter redacts secret-shaped values inside card output", () => {
  const secret = ["x".repeat(24), "y".repeat(6), "z".repeat(20)].join(".");
  const response = formatCommandResponse("statusDetail", {
    ok: true,
    result: {
      overall: "READY",
      token: secret,
      issues: [`safe issue ${secret}`]
    }
  });

  const combined = `${response.content}\n${JSON.stringify(response.embeds)}`;
  assert.equal(response.content, "");
  assert.doesNotMatch(combined, /```json/);
  assert.match(combined, /\[REDACTED\]/);
  assert.doesNotMatch(combined, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});
