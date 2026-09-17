"use client";
import StateMap from "./StateMap";
import { nameFromSlug } from "../lib/states";

interface StateData {
  state: string;
  churchRun?: {
    total_contacts: number;
    total_counties: number;
    completed_at: string;
    display_name: string;
  };
  schoolRun?: {
    total_contacts: number;
    total_counties: number;
    completed_at: string;
    display_name: string;
  };
}

interface USStateMapProps {
  stateData: Record<string, StateData>;
  /** Matches the Scraper page's filter chips; changes what "cleared" means. */
  filter?: "all" | "school" | "church";
}

/**
 * Two hues only, per the design system: olive means cleared, navy means
 * partially covered, the track colour means untouched.
 *
 * Under the "All" filter a state is only *cleared* once both churches and
 * schools have been run; one of the two leaves it navy. Filtering to a single
 * type makes "cleared" mean just that type.
 */
function getStateColor(
  stateId: string,
  stateData: Record<string, StateData>,
  filter: "all" | "school" | "church"
): string {
  const data = stateData[stateId];
  if (!data) return "var(--track)";

  const hasChurch = !!data.churchRun;
  const hasSchool = !!data.schoolRun;

  if (filter === "school") return hasSchool ? "var(--olive)" : "var(--track)";
  if (filter === "church") return hasChurch ? "var(--olive)" : "var(--track)";

  if (hasChurch && hasSchool) return "var(--olive)";
  if (hasChurch || hasSchool) return "var(--navy)";
  return "var(--track)";
}

function isInProgress(stateId: string, stateData: Record<string, StateData>): boolean {
  const data = stateData[stateId];
  if (!data) return false;
  return (data.churchRun?.completed_at === "In Progress") || (data.schoolRun?.completed_at === "In Progress");
}

function formatDate(dateStr: string): string {
  if (!dateStr || dateStr === "In Progress") return dateStr || "-";
  try {
    const d = new Date(dateStr);
    return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "America/Chicago" });
  } catch {
    return dateStr;
  }
}

export default function USStateMap({ stateData, filter = "all" }: USStateMapProps) {
  // The map itself is shared with the Grant Knowledge tab (components/StateMap.tsx);
  // what a colour means here, and what the tooltip says, stay with the scraper.
  return (
    <StateMap
      colorFor={(id) => getStateColor(id, stateData, filter)}
      pulsing={(id) => isInProgress(id, stateData)}
      hoverable={(id) => !!stateData[id]}
      renderTooltip={(id) => {
        const tooltipData = stateData[id];
        return (
          <>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>{nameFromSlug(id) || id}</div>

            {!tooltipData && <div style={{ opacity: .65, fontSize: 11 }}>Not yet scraped</div>}

            {tooltipData?.churchRun && (
              <div style={{ marginBottom: tooltipData.schoolRun ? 6 : 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 1, background: "var(--navy)", display: "inline-block" }} />
                  <span style={{ fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Churches</span>
                </div>
                <div style={{ opacity: .85, fontSize: 11, paddingLeft: 10 }}>
                  {tooltipData.churchRun.total_contacts.toLocaleString()} contacts
                  {tooltipData.churchRun.total_counties > 0 && ` · ${tooltipData.churchRun.total_counties} counties`}
                </div>
                <div style={{ opacity: .6, fontSize: 10, paddingLeft: 10 }}>{formatDate(tooltipData.churchRun.completed_at)}</div>
              </div>
            )}

            {tooltipData?.schoolRun && (
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 4, marginBottom: 2 }}>
                  <span style={{ width: 6, height: 6, borderRadius: 1, background: "var(--olive)", display: "inline-block" }} />
                  <span style={{ fontWeight: 600, fontSize: 11, textTransform: "uppercase", letterSpacing: "0.04em" }}>Schools</span>
                </div>
                <div style={{ opacity: .85, fontSize: 11, paddingLeft: 10 }}>
                  {tooltipData.schoolRun.total_contacts.toLocaleString()} contacts
                  {tooltipData.schoolRun.total_counties > 0 && ` · ${tooltipData.schoolRun.total_counties} counties`}
                </div>
                <div style={{ opacity: .6, fontSize: 10, paddingLeft: 10 }}>{formatDate(tooltipData.schoolRun.completed_at)}</div>
              </div>
            )}
          </>
        );
      }}
    />
  );
}
