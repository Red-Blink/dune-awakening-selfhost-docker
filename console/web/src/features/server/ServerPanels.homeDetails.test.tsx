import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InfoTooltip } from "../../components/common/DisplayPrimitives";
import { HomePanel, homeRowDetails } from "./ServerPanels";
import { MAPS, READY_READINESS, statusText } from "./homeStatusFixtures";

function rows(status: string, id: string, title: string) {
  return homeRowDetails(status, READY_READINESS)[id].find((group) => group.title === title)?.rows ?? [];
}

function renderHome(status: string) {
  const onNavigate = vi.fn();
  render(<HomePanel
    status={status}
    readiness={READY_READINESS}
    taskResult={null}
    setTaskResult={vi.fn()}
    funcomTokenResult={null}
    setFuncomTokenResult={vi.fn()}
    runningAction=""
    restartStartObserved={false}
    setRunningAction={vi.fn()}
    onLoad={vi.fn().mockResolvedValue({ statusLoaded: true, readinessLoaded: true, statusError: "", readinessError: "", statusText: status, readinessText: READY_READINESS, sampledAtMs: Date.now() })}
    confirmAction={vi.fn().mockResolvedValue(true)}
    restartGate={vi.fn()}
    onNavigate={onNavigate}
  />);
  return onNavigate;
}

describe("homeRowDetails", () => {
  it("lists each row's containers, ports and checks under the row that owns them", () => {
    const status = statusText();
    expect(rows(status, "database", "Containers")).toEqual([{ name: "dune-postgres", value: "Up 15 hours" }]);
    expect(rows(status, "database", "Ports")).toEqual([{ name: "Postgres localhost 15432/tcp", value: "OK" }]);
    expect(rows(status, "database", "Health")).toContainEqual({ name: "World partitions", value: "32" });
    expect(rows(status, "messaging", "Containers").map((row) => row.name)).toEqual(["dune-rmq-admin", "dune-rmq-game", "dune-text-router"]);
    expect(rows(status, "battlegroup", "Containers").map((row) => row.name)).toEqual(["dune-director", "dune-server-gateway"]);
    expect(rows(status, "battlegroup", "Ports")).toEqual([{ name: "Director 11717/tcp", value: "OK" }]);
    expect(rows(status, "games", "Maps").map((row) => row.name)).toEqual(MAPS.map(([name]) => name));
    expect(rows(status, "fls", "Health").map((row) => row.name)).toEqual(["Director heartbeat", "Population declaration", "Max capacity declaration", "Gateway DB monitoring"]);
  });

  it("replaces the status pointer with the readiness check it points at", () => {
    expect(rows(statusText(), "messaging", "Health")).toEqual([{ name: "game server sg.* RMQ connections", value: "OK" }]);
  });

  it("gives a port on a map to Game servers rather than to a service row", () => {
    const status = statusText().replace("=== Database ===", "Survival_1 clients       8778/udp OK\n=== Database ===");
    expect(rows(status, "games", "Ports")).toEqual([{ name: "Survival_1 clients 8778/udp", value: "OK" }]);
    expect(rows(status, "database", "Ports")).toHaveLength(1);
  });

  it("keeps a missing map's reason and marks a container with no printed row", () => {
    const status = statusText({ maps: [["Overmap", "READY"]] })
      .replace(/^Overmap .*$/m, `${"Overmap".padEnd(24)} ${"NOT RUNNING".padEnd(13)} missing - waiting for host memory`)
      .replace(/^dune-director .*\n/m, "");
    expect(rows(status, "games", "Maps")).toEqual([{ name: "Overmap", value: "NOT RUNNING", note: "missing - waiting for host memory" }]);
    expect(rows(status, "battlegroup", "Containers")[0]).toEqual({ name: "dune-director", value: "Not listed" });
  });

  it("lists nothing before a status has loaded", () => {
    expect(Object.values(homeRowDetails("", "")).flat()).toEqual([]);
  });

  it("reads status.sh's sentence for a stopped game broker", () => {
    const status = statusText().replace("RabbitMQ connection details: Checked by readiness", "RabbitMQ game is not running");
    expect(rows(status, "messaging", "Health")).toContainEqual({ name: "RabbitMQ game", value: "not running" });
  });

  it.each([
    ["the uptime column is a reason", "NOT RUNNING", "Exited (137) 2 minutes ago", "Exited (137) 2 minutes ago"],
    ["a WAIT row is missing because Postgres is down", "WAIT", "missing", "missing"],
    ["a map is only created", "NOT RUNNING", "Created", "Created"],
    ["an ERROR map is merely up", "ERROR", "Up 2 minutes", undefined],
    ["a map is routinely pending", "WAIT", "pending", undefined],
    ["a map is routinely queued", "QUEUED", "queued", undefined],
    ["a map is ready", "READY", "Up 5 hours", undefined]
  ])("handles the note when %s", (_name, state, uptime, note) => {
    const status = statusText({ maps: [["Overmap", "READY"]] })
      .replace(/^Overmap .*$/m, `${"Overmap".padEnd(24)} ${state.padEnd(13)} ${uptime}`);
    expect(rows(status, "games", "Maps")).toEqual([{ name: "Overmap", value: state, note }]);
  });

  it("includes the WAIT rows ready.sh prints, which are what explain an amber row", () => {
    const readiness = [
      "OK   world_partition rows: 38",
      "WAIT game server sg.* RMQ connections",
      "WAIT Director FLS heartbeat pending",
      "WAIT Gateway DB monitoring pending"
    ].join("\n");
    const details = homeRowDetails(statusText(), readiness);
    const health = (id: string) => details[id].find((group) => group.title === "Health")?.rows ?? [];
    expect(health("database")).toContainEqual({ name: "world_partition rows: 38", value: "OK" });
    expect(health("messaging")).toEqual([{ name: "game server sg.* RMQ connections", value: "WAIT" }]);
    expect(health("fls")).toEqual(expect.arrayContaining([
      { name: "Director FLS heartbeat pending", value: "WAIT" },
      { name: "Gateway DB monitoring pending", value: "WAIT" }
    ]));
  });
});

describe("Readiness & Health details button", () => {
  it("opens the row's readings without navigating away", () => {
    const onNavigate = renderHome(statusText());
    fireEvent.click(screen.getByRole("button", { name: "Game Servers details" }));
    const box = within(document.getElementById("home-detail-games")!);
    expect(box.getByText("Survival_1#60")).toBeTruthy();
    expect(onNavigate).not.toHaveBeenCalled();
  });

  it("sits beside the row button, which still navigates", () => {
    const onNavigate = renderHome(statusText());
    const info = screen.getByRole("button", { name: "Database details" });
    const row = screen.getByRole("button", { name: /^Database:/ });
    expect(row.contains(info)).toBe(false);
    fireEvent.click(row);
    expect(onNavigate).toHaveBeenCalledWith("Server Control");
  });

  it("stays open when the pointer goes down inside the box, so it can be scrolled", () => {
    renderHome(statusText());
    const info = screen.getByRole("button", { name: "Game Servers details" });
    fireEvent.click(info);
    fireEvent.pointerDown(document.getElementById("home-detail-games")!);
    expect(info.getAttribute("aria-expanded")).toBe("true");
    fireEvent.pointerDown(document.body);
    expect(info.getAttribute("aria-expanded")).toBe("false");
  });

  it("colours a reading by what it says, and only known-healthy ones green", () => {
    const status = statusText()
      .replace(/^dune-postgres .*$/m, "dune-postgres              Up 15 hours (unhealthy)")
      .replace(/^dune-director .*$/m, "dune-director              Restarting (137) 12 seconds ago")
      .replace(/^dune-rmq-admin .*$/m, "dune-rmq-admin             Up 15 hours (health: starting)")
      .replace("World partitions: 32", "World partitions: 0");
    renderHome(status);
    const tone = (id: string, text: string) => within(document.getElementById(`home-detail-${id}`)!).getAllByText(text)[0].className;
    expect(tone("database", "Up 15 hours (unhealthy)")).toContain("bad");
    expect(tone("battlegroup", "Restarting (137) 12 seconds ago")).toContain("pending");
    expect(tone("messaging", "Up 15 hours (health: starting)")).toContain("pending");
    expect(tone("messaging", "Up 15 hours")).toContain("good");
    expect(tone("database", "0").trim()).toBe("home-detail-value");
  });

  it("shows a missing map's reason, and keeps live readings out of translation", () => {
    const status = statusText({ maps: [["Overmap", "READY"]] })
      .replace(/^Overmap .*$/m, `${"Overmap".padEnd(24)} ${"NOT RUNNING".padEnd(13)} missing - waiting for host memory`);
    renderHome(status);
    const box = document.getElementById("home-detail-games")!;
    const note = within(box).getByText("missing - waiting for host memory");
    expect(within(box).getByText("NOT RUNNING").className).toContain("bad");
    expect(note.closest("[data-no-translate]")).toBeTruthy();
    expect(within(box).getByText("Maps").closest("[data-no-translate]")).toBeNull();
  });

  it("has no details button until a status has loaded", () => {
    renderHome("");
    expect(screen.queryByRole("button", { name: /details$/ })).toBeNull();
  });
});

describe("InfoTooltip interactive mode", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function setup(interactive = true) {
    render(<><InfoTooltip id="tip" label="More" portal interactive={interactive}>Body</InfoTooltip><button>After</button></>);
    return { button: screen.getByRole("button", { name: "More" }), box: document.getElementById("tip")!, root: document.querySelector<HTMLElement>(".memory-info-tooltip")! };
  }
  const isOpen = (button: HTMLElement) => button.getAttribute("aria-expanded") === "true";

  it("stays fixed while closed, so a hidden box cannot add page scroll", () => {
    expect(setup().box.style.position).toBe("fixed");
    expect(document.querySelectorAll(".memory-info-box")).toHaveLength(1);
  });

  it("waits before closing on pointer leave, and re-entering cancels the close", () => {
    vi.useFakeTimers();
    const { button, root } = setup();
    fireEvent.pointerEnter(root);
    fireEvent.pointerLeave(root);
    expect(isOpen(button)).toBe(true);
    fireEvent.pointerEnter(root);
    act(() => { vi.advanceTimersByTime(500); });
    expect(isOpen(button)).toBe(true);
    fireEvent.pointerLeave(root);
    act(() => { vi.advanceTimersByTime(200); });
    expect(isOpen(button)).toBe(false);
  });

  it("closes at once on pointer leave when not interactive", () => {
    const { button, root } = setup(false);
    fireEvent.pointerEnter(root);
    fireEvent.pointerLeave(root);
    expect(isOpen(button)).toBe(false);
  });

  it("is a focusable dialog when interactive and a tooltip otherwise", () => {
    const { button, box } = setup();
    expect(box.getAttribute("role")).toBe("dialog");
    expect(box.getAttribute("aria-label")).toBe("More");
    expect(button.getAttribute("aria-controls")).toBe("tip");
    expect(button.hasAttribute("aria-describedby")).toBe(false);
  });

  it("keeps the plain tooltip role and description when not interactive", () => {
    const { button, box } = setup(false);
    expect(box.getAttribute("role")).toBe("tooltip");
    expect(box.hasAttribute("tabindex")).toBe(false);
    expect(button.getAttribute("aria-describedby")).toBe("tip");
  });

  it("takes keyboard focus on Tab so long content can be scrolled", () => {
    const { button, box } = setup();
    act(() => button.focus());
    expect(isOpen(button)).toBe(true);
    fireEvent.keyDown(button, { key: "Tab" });
    expect(document.activeElement).toBe(box);
  });

  it.each(["Tab", "Escape"])("%s from the box closes it and hands focus back to the button", (key) => {
    const { button, box } = setup();
    act(() => button.focus());
    fireEvent.keyDown(button, { key: "Tab" });
    fireEvent.keyDown(box, { key });
    expect(document.activeElement).toBe(button);
    expect(isOpen(button)).toBe(false);
  });

  it("closes when focus moves elsewhere, but not between the button and the box", () => {
    const { button, box } = setup();
    const after = screen.getByRole("button", { name: "After" });
    fireEvent.click(button);
    fireEvent.blur(button, { relatedTarget: box });
    expect(isOpen(button)).toBe(true);
    fireEvent.blur(button, { relatedTarget: after });
    expect(isOpen(button)).toBe(false);
  });

  it("does not close on pointer leave while the box holds focus", () => {
    vi.useFakeTimers();
    const { button, box, root } = setup();
    act(() => button.focus());
    fireEvent.keyDown(button, { key: "Tab" });
    fireEvent.pointerLeave(root);
    act(() => { vi.advanceTimersByTime(500); });
    expect(document.activeElement).toBe(box);
    expect(isOpen(button)).toBe(true);
  });

  it.each([
    ["to the right of the button when there is room", 400, 440, 448, 310],
    ["to the left when the right side is short", 900, 940, 582, 310],
    ["narrower on a phone, so it never covers the button", 240, 284, 14, 218]
  ])("opens %s", (_name, anchorLeft, anchorRight, left, width) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
      return this.classList.contains("memory-info-tooltip")
        ? { left: anchorLeft, right: anchorRight, top: 100, bottom: 126, width: 40, height: 26 } as DOMRect
        : { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 200 } as DOMRect;
    });
    vi.spyOn(window, "innerWidth", "get").mockReturnValue(anchorRight > 300 ? 1000 : 320);
    const { button, box } = setup();
    fireEvent.click(button);
    expect(box.style.left).toBe(`${left}px`);
    expect(box.style.width).toBe(`${width}px`);
  });
});
