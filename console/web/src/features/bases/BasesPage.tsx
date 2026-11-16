import { type ComponentProps, useEffect, useState } from "react";
import { SegmentedControl } from "../../components/common/SegmentedControl";
import { BasesPanel } from "./BasesPanel";
import { BaseBackupsView } from "./BaseBackupsView";
import { useConsoleAccess } from "../../lib/consoleAccess";

// The Bases tab: live bases, or the bases players have picked up with the
// in-game base backup tool. Backups are not live bases (they are hidden from
// the Bases list), so they get their own view rather than a per-base tab.

type BasesView = "bases" | "backups";

const VIEWS = [
  { value: "bases", label: "Bases" },
  { value: "backups", label: "Base Backups" }
] as const;

const VIEW_STORAGE_KEY = "bases_view";

function storedView(): BasesView {
  try {
    return sessionStorage.getItem(VIEW_STORAGE_KEY) === "backups" ? "backups" : "bases";
  } catch {
    return "bases";
  }
}

export function BasesPage(props: ComponentProps<typeof BasesPanel>) {
  const access = useConsoleAccess();
  const [requestedView, setView] = useState<BasesView>(storedView);
  const views = VIEWS.filter(option => access.can(option.value === "bases" ? "bases:read" : "blueprints:read"));
  const view = views.some(option => option.value === requestedView) ? requestedView : views[0]?.value;

  // Opening a base from elsewhere (Players, Live Map) must land on the list.
  useEffect(() => {
    if (props.focusRequest?.nonce) setView("bases");
  }, [props.focusRequest?.nonce]);

  function changeView(next: BasesView) {
    setView(next);
    try {
      sessionStorage.setItem(VIEW_STORAGE_KEY, next);
    } catch {}
  }

  const viewSwitch = <SegmentedControl
    name="bases-view"
    ariaLabel="Bases view"
    value={view || "bases"}
    options={views}
    onChange={changeView}
    groupClassName="segmented-control players-view-segments"
  />;

  if (!view) return null;
  return view === "backups"
    ? <BaseBackupsView onError={props.onError} confirmAction={props.confirmAction} viewSwitch={viewSwitch} />
    : <BasesPanel {...props} viewSwitch={viewSwitch} />;
}
