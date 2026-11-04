import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { ConsoleLanguageObserver } from "./ConsoleLanguageObserver";
import { saveSelectedLanguage } from "./i18nClient";

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const lang = new URL(url, "http://console.test").searchParams.get("lang");
    if (!url.startsWith("/api/i18n/translations?")) throw new Error("Unexpected translation request");
    return new Response(JSON.stringify({
      lang,
      dir: "ltr",
      translations: lang === "FR" ? { Home: "Accueil" } : { Home: "Startseite", Ready: "Bereit", Stop: "Stoppen", "{count0} of {count1}": "{count0} von {count1}", "{count0} ready out of {count1}": "{count1} insgesamt, {count0} bereit" }
    }), { status: 200, headers: { "content-type": "application/json" } });
  });
  saveSelectedLanguage("DE");
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  document.documentElement.lang = "en";
  document.documentElement.dir = "ltr";
});

type Attribute = "title" | "aria-label" | "placeholder";
function Fixture({ count = "3 / 40", message = "Ready", attribute = "title", value = "Ready" }: {
  count?: string;
  message?: string;
  attribute?: Attribute;
  value?: string | null;
}) {
  return <div>
    <ConsoleLanguageObserver />
    <span>Home</span>
    <span data-testid="count">{count}</span>
    <span data-testid="message">{message}</span>
    <input data-testid="control" {...{ [attribute]: value ?? undefined }} />
  </div>;
}

test("returning to English preserves the latest untranslated live player count", async () => {
  const view = render(<Fixture />);
  await screen.findByText("Startseite");
  await act(async () => { view.rerender(<Fixture count="7 / 40" />); });
  expect(screen.getByTestId("count")).toHaveTextContent("7 / 40");
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("count")).toHaveTextContent("7 / 40");
  expect(vi.mocked(fetch).mock.calls.every(([url]) => String(url).startsWith("/api/i18n/translations?"))).toBe(true);
});

test("React text updates translate the new source and restore that source in English", async () => {
  const view = render(<Fixture />);
  await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("Bereit"));
  view.rerender(<Fixture message="Stop" />);
  await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("Stoppen"));
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("message")).toHaveTextContent("Stop");
});

test.each<Attribute>(["title", "aria-label", "placeholder"])("attribute-only %s updates translate and restore the current control value", async (attribute) => {
  const view = render(<Fixture attribute={attribute} />);
  await waitFor(() => expect(screen.getByTestId("control")).toHaveAttribute(attribute, "Bereit"));
  // No text/child changes: the attribute mutation itself must trigger translation.
  view.rerender(<Fixture attribute={attribute} value="Stop" />);
  await waitFor(() => expect(screen.getByTestId("control")).toHaveAttribute(attribute, "Stoppen"));
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("control")).toHaveAttribute(attribute, "Stop");
});

test("switching to English before the observer runs does not overwrite a newer external update", async () => {
  render(<Fixture />);
  await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("Bereit"));
  await act(async () => {
    screen.getByTestId("message").firstChild!.nodeValue = "Stop";
    screen.getByTestId("control").setAttribute("title", "Stop");
    saveSelectedLanguage("EN");
  });
  expect(screen.getByTestId("message")).toHaveTextContent("Stop");
  expect(screen.getByTestId("control")).toHaveAttribute("title", "Stop");
});

test("an attribute removed by React is never recreated during English restoration", async () => {
  const view = render(<Fixture />);
  await waitFor(() => expect(screen.getByTestId("control")).toHaveAttribute("title", "Bereit"));
  await act(async () => {
    view.rerender(<Fixture value={null} />);
  });
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("control")).not.toHaveAttribute("title");
});

test("new private text and attributes remain local and survive switching back to English", async () => {
  const view = render(<Fixture />);
  await screen.findByText("Startseite");
  const privateText = "Synthetic private server note";
  await act(async () => { view.rerender(<Fixture message={privateText} value={privateText} />); });
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("message")).toHaveTextContent(privateText);
  expect(screen.getByTestId("control")).toHaveAttribute("title", privateText);
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});

test("a phrase missing in the next language falls back to its source instead of the previous translation", async () => {
  render(<Fixture message="Stop" />);
  await waitFor(() => expect(screen.getByTestId("message")).toHaveTextContent("Stoppen"));
  await act(async () => { saveSelectedLanguage("FR"); });
  await screen.findByText("Accueil");
  expect(screen.getByTestId("message")).toHaveTextContent("Stop");
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("message")).toHaveTextContent("Stop");
});

test("control changes made in English are used when translation is enabled again", async () => {
  const view = render(<Fixture />);
  await screen.findByText("Startseite");
  await act(async () => { saveSelectedLanguage("EN"); });
  view.rerender(<Fixture value="Stop" />);
  await act(async () => { saveSelectedLanguage("DE"); });
  await waitFor(() => expect(screen.getByTestId("control")).toHaveAttribute("title", "Stoppen"));
});

test("numeric UI templates translate locally and restore the latest live counts", async () => {
  const view = render(<Fixture count="3 of 40" />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("3 von 40"));
  view.rerender(<Fixture count="7 of 40" />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("7 von 40"));
  await act(async () => { saveSelectedLanguage("EN"); });
  expect(screen.getByTestId("count")).toHaveTextContent("7 of 40");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});

test("numeric placeholders can change order without translating arbitrary text", async () => {
  render(<Fixture count="3 ready out of 40" message="Private Guild of Arrakis" />);
  await waitFor(() => expect(screen.getByTestId("count")).toHaveTextContent("40 insgesamt, 3 bereit"));
  expect(screen.getByTestId("message")).toHaveTextContent("Private Guild of Arrakis");
  expect(vi.mocked(fetch).mock.calls).toHaveLength(1);
});
