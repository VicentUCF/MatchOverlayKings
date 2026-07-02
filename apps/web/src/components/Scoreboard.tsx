import { Crown, MapPin } from 'lucide-react';
import {
  formatPoint,
  getActiveSet,
  getCompletedSetCount,
  getPointContext,
} from '@kpl/shared';
import type { MatchState, Side, Team } from '@kpl/shared';

interface ScoreboardProps {
  state: MatchState;
  teams: Team[];
  mode: 'control' | 'overlay';
}

export function Scoreboard({ state, teams, mode }: ScoreboardProps) {
  const home = teams.find((team) => team.id === state.homeTeamId);
  const away = teams.find((team) => team.id === state.awayTeamId);
  const activeSet = state.status === 'finished' ? state.sets.at(-1) : getActiveSet(state);
  const pointContext = getPointContext(state);

  return (
    <section className={`scoreboard ${mode}`} data-status={state.status}>
      <header className="scoreboard-header">
        <div>
          <strong>{state.title}</strong>
          <span>
            <MapPin size={14} />
            {state.courtName || 'Pista'}
          </span>
        </div>
        <StatusBadge state={state} pointContext={pointContext} />
      </header>

      <div className="score-grid" role="table" aria-label="Marcador">
        <div className="score-grid-head team-col">Equipo</div>
        <div className="score-grid-head">Sets</div>
        <div className="score-grid-head">Juegos</div>
        <div className="score-grid-head">Puntos</div>
        <TeamRow
          side="home"
          state={state}
          team={home}
          activeGames={activeSet?.homeGames ?? 0}
          pointContextSide={pointContext?.side ?? null}
        />
        <TeamRow
          side="away"
          state={state}
          team={away}
          activeGames={activeSet?.awayGames ?? 0}
          pointContextSide={pointContext?.side ?? null}
        />
      </div>

      <footer className="set-strip" aria-label="Sets">
        {state.sets.slice(0, 3).map((set, index) => (
          <span key={`${index}-${set.status}`} className={set.status}>
            S{index + 1} {set.homeGames}-{set.awayGames}
            {set.tieBreak ? ` (${set.tieBreak.homePoints}-${set.tieBreak.awayPoints})` : ''}
          </span>
        ))}
      </footer>
    </section>
  );
}

function TeamRow({
  side,
  state,
  team,
  activeGames,
  pointContextSide,
}: {
  side: Side;
  state: MatchState;
  team: Team | undefined;
  activeGames: number;
  pointContextSide: Side | null;
}) {
  const isWinner = state.winner === side;
  const isPressure = pointContextSide === side;
  const lineup = state.lineups[side];
  const playerNames = [lineup.player1, lineup.player2].filter(Boolean).join(' / ');

  return (
    <>
      <div className={`team-cell ${isWinner ? 'winner' : ''}`}>
        <span className="team-logo" style={{ '--team-color': team?.primaryColor } as React.CSSProperties}>
          {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : team?.shortName.slice(0, 2)}
        </span>
        <span>
          <strong>{team?.shortName ?? side}</strong>
          <small>{playerNames || team?.name || side}</small>
        </span>
        {state.servingSide === side ? <span className="serve-badge">Saque</span> : null}
        {isWinner ? <Crown size={18} /> : null}
      </div>
      <strong className="score-number">{getCompletedSetCount(state, side)}</strong>
      <strong className="score-number">{activeGames}</strong>
      <strong className={`point-number ${isPressure ? 'pressure' : ''}`}>
        {state.status === 'finished' ? '-' : formatPoint(state, side)}
      </strong>
    </>
  );
}

function StatusBadge({
  state,
  pointContext,
}: {
  state: MatchState;
  pointContext: { side: Side; type: 'set_point' | 'match_point' } | null;
}) {
  if (state.status === 'finished') {
    return <span className="status-badge finished">Final</span>;
  }

  if (pointContext) {
    return (
      <span className="status-badge hot">
        {pointContext.type === 'match_point' ? 'Match point' : 'Set point'}
      </span>
    );
  }

  if (state.currentGame.isTieBreak) {
    return <span className="status-badge hot">Tie-break</span>;
  }

  return <span className="status-badge">{state.status === 'live' ? 'En directo' : 'Prepartido'}</span>;
}
