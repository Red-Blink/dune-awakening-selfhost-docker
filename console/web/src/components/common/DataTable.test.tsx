import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { DataTable } from "./DataTable";

// Every th/td in the app carries max-width + white-space: nowrap + ellipsis
// (styles.css), so any cell can be silently truncated with no way to see the
// full value short of resizing a column. A title attribute recovers that on
// hover, for every table that uses the default text renderer.
describe("DataTable cell titles", () => {
  it("gives a plain-text cell a title carrying its full, un-truncated value", () => {
    const longName = "dune-system-20260830-120000-4711-9931.tar.gz.enc";
    render(<DataTable rows={[{ name: longName }]} columns={["name"]} />);
    const cell = screen.getByText(longName);
    expect(cell.getAttribute("title")).toBe(longName);
  });

  it("does not carry a title on an empty cell", () => {
    render(<DataTable rows={[{ name: "" }]} columns={["name"]} />);
    const cell = document.querySelector("td[data-column='name']");
    expect(cell?.getAttribute("title")).toBeNull();
  });

  it("does not add a text title over a custom-rendered cell", () => {
    // renderCell can return arbitrary JSX (badges, links, buttons); a text
    // title guessed from that would be meaningless or wrong, so it is
    // deliberately left to whatever the custom renderer supplies itself.
    render(<DataTable
      rows={[{ name: "row-1" }]}
      columns={["name"]}
      renderCell={() => <button>Action</button>}
    />);
    const cell = document.querySelector("td[data-column='name']");
    expect(cell?.getAttribute("title")).toBeNull();
    expect(screen.getByText("Action")).toBeTruthy();
  });
});
