import { useEffect, useRef } from "react";
import type { CSSProperties } from "react";
import { Crown, MapPin } from "lucide-react";
import { animate } from "animejs";
import {
  formatPoint,
  getActiveSet,
  getCompletedSetCount,
  getPointContext,
} from "@kpl/shared";
import type { MatchState, Side, Team } from "@kpl/shared";

interface ScoreboardProps {
  state: MatchState;
  teams: Team[];
  mode: "control" | "overlay";
}

export function Scoreboard({ state, teams, mode }: ScoreboardProps) {
  const boardRef = useRef<HTMLElement>(null);
  const previousScoreValuesRef = useRef<Record<string, string> | null>(null);
  const home = teams.find((team) => team.id === state.homeTeamId);
  const away = teams.find((team) => team.id === state.awayTeamId);
  const activeSet =
    state.status === "finished" ? state.sets.at(-1) : getActiveSet(state);
  const pointContext = getPointContext(state);
  const visibleSets = state.sets.slice(0, 3);
  const scoreValues: Record<string, string> =
    mode === "overlay"
      ? {
          ...getOverlaySetScoreValues(visibleSets),
          "home-points":
            state.status === "finished" ? "-" : formatPoint(state, "home"),
          "away-points":
            state.status === "finished" ? "-" : formatPoint(state, "away"),
        }
      : {
          "home-sets": String(getCompletedSetCount(state, "home")),
          "home-games": String(activeSet?.homeGames ?? 0),
          "home-points":
            state.status === "finished" ? "-" : formatPoint(state, "home"),
          "away-sets": String(getCompletedSetCount(state, "away")),
          "away-games": String(activeSet?.awayGames ?? 0),
          "away-points":
            state.status === "finished" ? "-" : formatPoint(state, "away"),
        };

  useEffect(() => {
    if (!boardRef.current || prefersReducedMotion()) {
      previousScoreValuesRef.current = scoreValues;
      return;
    }

    const previousScoreValues = previousScoreValuesRef.current;
    previousScoreValuesRef.current = scoreValues;

    if (!previousScoreValues) {
      return;
    }

    const changedKeys = Object.entries(scoreValues)
      .filter(([key, value]) => previousScoreValues[key] !== value)
      .map(([key]) => key);

    if (changedKeys.length === 0) {
      return;
    }

    const changedCells = changedKeys
      .map((key) =>
        boardRef.current?.querySelector(`[data-score-key="${key}"]`),
      )
      .filter((cell): cell is Element => Boolean(cell));

    const animation = animate(changedCells, {
      opacity: [{ from: 0.58, to: 1 }],
      scale: [{ from: 1.1, to: 1 }],
      duration: mode === "overlay" ? 320 : 220,
      ease: "outCubic",
    });

    return () => {
      animation.revert();
    };
  });

  return (
    <section
      className={`scoreboard ${mode}`}
      data-status={state.status}
      ref={boardRef}
    >
      <header className="scoreboard-header">
        <div className="scoreboard-title">
          <span className="scoreboard-league-mark">
            <img src="/logos/kpl-wordmark.png" alt="" />
          </span>
          <strong>{state.title}</strong>
          <span className="court-label">
            <MapPin size={14} />
            {state.courtName || "Pista"}
          </span>
        </div>
        <StatusBadge state={state} pointContext={pointContext} />
      </header>

      <div
        className={`score-grid ${mode === "overlay" ? "premier-grid" : ""}`}
        role="table"
        aria-label="Marcador"
        data-set-count={
          mode === "overlay" ? Math.max(1, visibleSets.length) : undefined
        }
      >
        <TeamRow
          side="home"
          mode={mode}
          state={state}
          team={home}
          visibleSets={visibleSets}
          activeGames={activeSet?.homeGames ?? 0}
          pointContextSide={pointContext?.side ?? null}
        />
        <TeamRow
          side="away"
          mode={mode}
          state={state}
          team={away}
          visibleSets={visibleSets}
          activeGames={activeSet?.awayGames ?? 0}
          pointContextSide={pointContext?.side ?? null}
        />
      </div>

      {mode === "control" ? (
        <footer className="set-strip" aria-label="Sets">
          {state.sets.slice(0, 3).map((set, index) => (
            <span key={`${index}-${set.status}`} className={set.status}>
              S{index + 1} {set.homeGames}-{set.awayGames}
              {set.tieBreak
                ? ` (${set.tieBreak.homePoints}-${set.tieBreak.awayPoints})`
                : ""}
            </span>
          ))}
        </footer>
      ) : null}
    </section>
  );
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

function TeamRow({
  side,
  mode,
  state,
  team,
  visibleSets,
  activeGames,
  pointContextSide,
}: {
  side: Side;
  mode: "control" | "overlay";
  state: MatchState;
  team: Team | undefined;
  visibleSets: MatchState["sets"];
  activeGames: number;
  pointContextSide: Side | null;
}) {
  const isWinner = state.winner === side;
  const isPressure = pointContextSide === side;
  const lineup = state.lineups[side];
  const playerNames = [lineup.player1, lineup.player2]
    .filter(Boolean)
    .join(" / ");
  const primaryName = mode === "overlay" ? team?.name : team?.shortName;
  const secondaryName = playerNames || (mode === "control" ? team?.name : "");
  const teamStyle = {
    "--team-color": team?.primaryColor ?? "var(--accent)",
    "--team-secondary": team?.secondaryColor ?? "#0d1016",
  } as CSSProperties;

  return (
    <>
      <div
        className={`team-cell ${isWinner ? "winner" : ""}`}
        data-side={side}
        style={teamStyle}
      >
        <span className="team-logo">
          {team?.logoUrl ? (
            <img src={team.logoUrl} alt="" />
          ) : (
            teamInitials(team?.shortName ?? side)
          )}
        </span>
        <span className="team-identity">
          <strong>{primaryName ?? side}</strong>
          {secondaryName ? <small>{secondaryName}</small> : null}
        </span>
        {state.servingSide === side ? (
          mode === "overlay" ? (
            <span className="serve-icon" aria-label="Saque" title="Saque" />
          ) : (
            <span className="serve-badge">Saque</span>
          )
        ) : null}
        {isWinner ? <Crown size={18} /> : null}
      </div>
      {mode === "overlay" ? (
        visibleSets.map((set, index) => (
          <strong
            key={`${side}-set-${index}`}
            className={`score-number set-score-number ${set.status}`}
            data-score-key={`${side}-set-${index}`}
            style={teamStyle}
          >
            {getSetGames(set, side)}
          </strong>
        ))
      ) : (
        <>
          <strong
            className="score-number sets-number"
            data-score-key={`${side}-sets`}
            style={teamStyle}
          >
            {getCompletedSetCount(state, side)}
          </strong>
          <strong
            className="score-number games-number"
            data-score-key={`${side}-games`}
            style={teamStyle}
          >
            {activeGames}
          </strong>
        </>
      )}
      <strong
        className={`point-number ${isPressure ? "pressure" : ""}`}
        data-score-key={`${side}-points`}
        style={teamStyle}
      >
        {state.status === "finished" ? "-" : formatPoint(state, side)}
      </strong>
    </>
  );
}

function teamInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");
}

function getOverlaySetScoreValues(
  sets: MatchState["sets"],
): Record<string, string> {
  return Object.fromEntries(
    (["home", "away"] as Side[]).flatMap((side) =>
      sets.map((set, index) => [
        `${side}-set-${index}`,
        String(getSetGames(set, side)),
      ]),
    ),
  );
}

function getSetGames(set: MatchState["sets"][number], side: Side): number {
  return side === "home" ? set.homeGames : set.awayGames;
}

function StatusBadge({
  state,
  pointContext,
}: {
  state: MatchState;
  pointContext: { side: Side; type: "set_point" | "match_point" } | null;
}) {
  if (state.status === "finished") {
    return <span className="status-badge finished">Final</span>;
  }

  if (pointContext) {
    return (
      <span className="status-badge hot">
        {pointContext.type === "match_point" ? "Match point" : "Set point"}
      </span>
    );
  }

  if (state.currentGame.isTieBreak) {
    return <span className="status-badge hot">Tie-break</span>;
  }

  const className =
    state.status === "live" ? "status-badge live" : "status-badge prematch";

  return (
    <span className={className}>
      {state.status === "live" ? "En directo" : "Prepartido"}
    </span>
  );
}
