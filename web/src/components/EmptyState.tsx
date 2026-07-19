import { ArrowRight, Code, Compass, Map, Sparkles } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useRef, useState } from "react";
import { type MessageKey, useT } from "../lib/i18n";
import { TempChatIcon } from "./TempChatIcon";

// A capability "lane" on the new-chat screen: a labelled pill tab plus a short, curated
// set of example prompts. Only one lane's prompts show at a time — picking a pill swaps
// the list below — which keeps the empty thread calm while still hinting at range.
// Clicking a prompt drops its full text into the composer (the user can edit before
// sending). The whole thing is data-driven so new lanes/prompts — or, later, plugin-
// contributed ones — can be appended here without touching the render code.
interface Lane {
  key: string;
  label: MessageKey;
  icon: ReactNode;
  prompts: MessageKey[];
}

const LANES: Lane[] = [
  {
    key: "create",
    label: "empty.cat.create",
    // Sparkles — the "make something new" lane.
    icon: <Sparkles size={16} strokeWidth={1.75} aria-hidden="true" />,
    prompts: ["empty.create.1", "empty.create.2", "empty.create.3", "empty.create.4"],
  },
  {
    key: "code",
    label: "empty.cat.code",
    // Angle brackets — the programming lane.
    icon: <Code size={16} strokeWidth={1.75} aria-hidden="true" />,
    prompts: ["empty.code.1", "empty.code.2", "empty.code.3", "empty.code.4"],
  },
  {
    key: "explore",
    label: "empty.cat.explore",
    // Compass — the curiosity / explain-it lane.
    icon: <Compass size={16} strokeWidth={1.75} aria-hidden="true" />,
    prompts: ["empty.explore.1", "empty.explore.2", "empty.explore.3", "empty.explore.4"],
  },
  {
    key: "plan",
    label: "empty.cat.plan",
    // Folded map — the practical / organize-my-life lane.
    icon: <Map size={16} strokeWidth={1.75} aria-hidden="true" />,
    prompts: ["empty.plan.1", "empty.plan.2", "empty.plan.3", "empty.plan.4"],
  },
];

// New-chat welcome screen: a greeting, a row of capability-lane pills, and the active
// lane's curated prompt list. Replaces the bare "Ask anything" line on an empty thread.
// In a temporary (ghost) chat the greeting swaps to a ghost-flavored notice so the user
// knows, before typing, that nothing here is kept — but the lanes stay, since the prompts
// are just as useful in a throwaway thread.
export function EmptyState({ onPick, temporary = false }: { onPick: (text: string) => void; temporary?: boolean }) {
  const t = useT();
  const [active, setActive] = useState(LANES[0].key);
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const activeLane = LANES.find((l) => l.key === active) ?? LANES[0];

  // Left/Right arrows move between lanes with roving focus (wrapping around) — the
  // expected tablist keyboard behaviour, so the pills are usable without a pointer.
  function onTabKey(e: KeyboardEvent<HTMLButtonElement>, i: number) {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    e.preventDefault();
    const dir = e.key === "ArrowRight" ? 1 : -1;
    const next = (i + dir + LANES.length) % LANES.length;
    setActive(LANES[next].key);
    tabRefs.current[next]?.focus();
  }

  return (
    <div className="welcome">
      {temporary && (
        <span className="welcome-ico" aria-hidden="true">
          <TempChatIcon size={40} />
        </span>
      )}
      <h1 className="welcome-title">{temporary ? t("temp.emptyTitle") : t("empty.greeting")}</h1>
      <p className="welcome-sub muted">{temporary ? t("temp.emptySub") : t("empty.subtitle")}</p>

      <div className="starter-cats" role="tablist" aria-label={t("empty.lanesLabel")}>
        {LANES.map((l, i) => {
          const selected = l.key === active;
          return (
            <button
              key={l.key}
              ref={(el) => {
                tabRefs.current[i] = el;
              }}
              type="button"
              role="tab"
              id={`lane-tab-${l.key}`}
              aria-selected={selected}
              aria-controls="lane-panel"
              tabIndex={selected ? 0 : -1}
              className={`starter-cat${selected ? " is-active" : ""}`}
              onClick={() => setActive(l.key)}
              onKeyDown={(e) => onTabKey(e, i)}
            >
              <span className="starter-cat-ico" aria-hidden="true">
                {l.icon}
              </span>
              {t(l.label)}
            </button>
          );
        })}
      </div>

      {/* Remounted on lane change (React key) so the staggered fade-in replays each swap. */}
      <div className="starter-list" id="lane-panel" role="tabpanel" aria-labelledby={`lane-tab-${activeLane.key}`} key={activeLane.key}>
        {activeLane.prompts.map((p, i) => (
          <button key={p} type="button" className="starter-row" style={{ animationDelay: `${i * 45}ms` }} onClick={() => onPick(t(p))}>
            <span className="starter-row-text">{t(p)}</span>
            <span className="starter-row-arrow" aria-hidden="true">
              <ArrowRight size={16} strokeWidth={1.75} aria-hidden="true" />
            </span>
          </button>
        ))}
      </div>

      <p className="welcome-hint muted small">
        {t("chat.emptyPre")} <code>/model</code> {t("chat.emptyPost")}
      </p>
    </div>
  );
}
