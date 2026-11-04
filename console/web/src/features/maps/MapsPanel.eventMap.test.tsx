import { render, screen } from "@testing-library/react";
import { expect, test } from "vitest";
import { MapDisplayName, parseMapRows } from "./MapsPanel";

test("keeps the registered Halloween event map in the Maps list with its controls' internal ID", () => {
  const rows = parseMapRows("CB_Halloween_Event_Shipwreck_01 Current: dynamic Partitions: 1 Assigned: 0");
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ map: "CB_Halloween_Event_Shipwreck_01", mode: "Dynamic", status: "Not Running" });
});

test("renders the event map's game name while preserving its technical ID", () => {
  render(<MapDisplayName mapId="CB_Halloween_Event_Shipwreck_01" />);
  expect(screen.getByText("Wreck of the Hieronymus")).toBeVisible();
  expect(screen.getByText("CB_Halloween_Event_Shipwreck_01")).toBeVisible();
});
