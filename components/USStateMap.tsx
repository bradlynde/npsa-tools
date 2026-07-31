// @ts-nocheck
"use client";
import { useState, useCallback, useRef } from "react";
import { US_STATE_PATHS } from "../lib/us-state-paths";
import { COLORS } from "../lib/constants";

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

interface TooltipInfo {
  x: number;
  y: number;
  stateId: string;
}

const STATE_NAMES: Record<string, string> = {
  alabama: "Alabama", alaska: "Alaska", arizona: "Arizona", arkansas: "Arkansas",
  california: "California", colorado: "Colorado", connecticut: "Connecticut",
  delaware: "Delaware", florida: "Florida", georgia: "Georgia", hawaii: "Hawaii",
  idaho: "Idaho", illinois: "Illinois", indiana: "Indiana", iowa: "Iowa",
  kansas: "Kansas", kentucky: "Kentucky", louisiana: "Louisiana", maine: "Maine",
  maryland: "Maryland", massachusetts: "Massachusetts", michigan: "Michigan",
  minnesota: "Minnesota", mississippi: "Mississippi", missouri: "Missouri",
  montana: "Montana", nebraska: "Nebraska", nevada: "Nevada",
  new_hampshire: "New Hampshire", new_jersey: "New Jersey", new_mexico: "New Mexico",
  new_york: "New York", north_carolina: "North Carolina", north_dakota: "North Dakota",
  ohio: "Ohio", oklahoma: "Oklahoma", oregon: "Oregon", pennsylvania: "Pennsylvania",
  rhode_island: "Rhode Island", south_carolina: "South Carolina",
  south_dakota: "South Dakota", tennessee: "Tennessee", texas: "Texas",
  utah: "Utah", vermont: "Vermont", virginia: "Virginia", washington: "Washington",
  west_virginia: "West Virginia", wisconsin: "Wisconsin", wyoming: "Wyoming",
};

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
  const [tooltip, setTooltip] = useState<TooltipInfo | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const handleMouseMove = useCallback((e: React.MouseEvent, stateId: string) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTooltip({
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      stateId,
    });
  }, []);

  const handleMouseLeave = useCallback(() => {
    setTooltip(null);
  }, []);

  const tooltipData = tooltip ? stateData[tooltip.stateId] : null;
  const tooltipName = tooltip ? (STATE_NAMES[tooltip.stateId] || tooltip.stateId) : "";

  return (
    <div ref={containerRef} style={{ position: "relative", width: "100%" }}>
      <svg
        viewBox="59 16 824 557"
        style={{ width: "100%", height: "auto" }}
        xmlns="http://www.w3.org/2000/svg"
      >
        <defs>
          <style>{`
            @keyframes statePulse {
              0%, 100% { opacity: 1; }
              50% { opacity: 0.45; }
            }
          `}</style>
        </defs>
        {Object.entries(US_STATE_PATHS).map(([stateId, pathD]) => {
          const color = getStateColor(stateId, stateData, filter);
          const isHovered = tooltip?.stateId === stateId;
          const hasData = !!stateData[stateId];
          const pulsing = isInProgress(stateId, stateData);

          // Alaska: rotate -30deg, scale 1.2x, move down near Hawaii
          // Hawaii: rotate -30deg, shift right
          const transform = stateId === "alaska"
            ? "translate(170,545) scale(1.2) rotate(-30) translate(-170,-475)"
            : stateId === "hawaii"
            ? "translate(330,515) rotate(-30) translate(-300,-515)"
            : undefined;

          return (
            <path
              key={stateId}
              d={pathD}
              fill={color}
              stroke="var(--card)"
              strokeWidth={1}
              transform={transform}
              style={{
                cursor: hasData ? "pointer" : "default",
                opacity: isHovered ? 0.85 : 1,
                transition: "opacity 0.15s ease",
                animation: pulsing ? "statePulse 2s ease-in-out infinite" : "none",
              }}
              onMouseMove={(e) => handleMouseMove(e, stateId)}
              onMouseLeave={handleMouseLeave}
            />
          );
        })}
      </svg>

      {/* Tooltip */}
      {tooltip && (
        <div
          style={{
            position: "absolute",
            left: Math.min(tooltip.x + 12, (containerRef.current?.clientWidth || 600) - 220),
            top: tooltip.y - 10,
            background: "var(--tip-bg)",
            color: "var(--tip-fg)",
            borderRadius: 8,
            padding: "10px 14px",
            fontSize: 12,
            zIndex: 1000,
            pointerEvents: "none",
            minWidth: 160,
            boxShadow: "0 4px 16px rgba(0,0,0,0.25)",
          }}
        >
          <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 6 }}>
            {tooltipName}
          </div>

          {!tooltipData && (
            <div style={{ opacity: .65, fontSize: 11 }}>Not yet scraped</div>
          )}

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
              <div style={{ opacity: .6, fontSize: 10, paddingLeft: 10 }}>
                {formatDate(tooltipData.churchRun.completed_at)}
              </div>
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
              <div style={{ opacity: .6, fontSize: 10, paddingLeft: 10 }}>
                {formatDate(tooltipData.schoolRun.completed_at)}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
