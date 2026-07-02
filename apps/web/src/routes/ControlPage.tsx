import { useEffect, useMemo, useState } from 'react';
import {
  Flag,
  ListRestart,
  Repeat2,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  Square,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { ManualScorePatch, MatchGameScore, MatchLineups, MatchSetScore, Side } from '@kpl/shared';
import { Scoreboard } from '../components/Scoreboard.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';

type ControlPhase = 'setup' | 'score';

export function ControlPage({ eventId }: { eventId: string }) {
  const match = useMatchSocket(eventId, 'control', '');
  const state = match.state;
  const activeSet = useMemo(
    () => state?.sets.find((set) => set.status === 'active') ?? state?.sets.at(-1) ?? null,
    [state],
  );
  const [metaTitle, setMetaTitle] = useState('');
  const [metaCourt, setMetaCourt] = useState('');
  const [homeTeamId, setHomeTeamId] = useState('');
  const [awayTeamId, setAwayTeamId] = useState('');
  const [lineups, setLineups] = useState<MatchLineups>(createEmptyLineups());
  const [servingSide, setServingSide] = useState<Side>('home');
  const [manualHomeGames, setManualHomeGames] = useState(0);
  const [manualAwayGames, setManualAwayGames] = useState(0);
  const [manualHomePoints, setManualHomePoints] = useState(0);
  const [manualAwayPoints, setManualAwayPoints] = useState(0);
  const [phase, setPhase] = useState<ControlPhase>('setup');

  useEffect(() => {
    if (!state) {
      return;
    }

    setMetaTitle(state.title);
    setMetaCourt(state.courtName);
    setHomeTeamId(state.homeTeamId);
    setAwayTeamId(state.awayTeamId);
    setLineups(state.lineups);
    setServingSide(state.servingSide);
    setManualHomeGames(activeSet?.homeGames ?? 0);
    setManualAwayGames(activeSet?.awayGames ?? 0);
    setManualHomePoints(state.currentGame.homePoints);
    setManualAwayPoints(state.currentGame.awayPoints);
  }, [activeSet, state]);

  useEffect(() => {
    if (!state) {
      return;
    }

    setPhase(state.status === 'pre_match' ? 'setup' : 'score');
  }, [eventId, state?.status]);

  function setupPayload() {
    return {
      title: metaTitle,
      courtName: metaCourt,
      homeTeamId,
      awayTeamId,
      lineups,
      servingSide,
    };
  }

  async function updateMeta() {
    await match.updateMeta(setupPayload());
  }

  async function startNewMatch() {
    const ok = await match.newMatch(setupPayload());

    if (ok) {
      setPhase('setup');
    }
  }

  async function beginMatch() {
    if (!state) {
      return;
    }

    const saved = state.status === 'pre_match'
      ? await match.updateMeta(setupPayload())
      : await match.newMatch(setupPayload());

    if (!saved) {
      return;
    }

    const started = await match.setStatus('live');

    if (started) {
      setPhase('score');
    }
  }

  async function applyManualPatch() {
    if (!state) {
      return;
    }

    const nextSet: MatchSetScore = {
      homeGames: manualHomeGames,
      awayGames: manualAwayGames,
      status: state.status === 'finished' ? 'complete' : 'active',
      winner: state.status === 'finished' ? state.winner : null,
      tieBreak: activeSet?.tieBreak ?? null,
    };
    const nextGame: MatchGameScore = {
      homePoints: manualHomePoints,
      awayPoints: manualAwayPoints,
      isTieBreak: state.currentGame.isTieBreak,
    };
    const patch: ManualScorePatch = {
      sets: [...state.sets.filter((set) => set.status === 'complete'), nextSet],
      currentGame: nextGame,
      status: state.status,
      winner: state.winner,
    };

    await match.manualPatch(patch);
  }

  const eventPanel = (
    <section className="operator-panel">
      <h2>Evento</h2>
      <label>
        <span>Pista</span>
        <select value={eventId} onChange={(event) => window.location.assign(`/control/${event.target.value}`)}>
          {match.events.map((event) => (
            <option key={event.id} value={event.id}>
              {event.courtName}
            </option>
          ))}
        </select>
      </label>
      <div className="version-row">
        <span>Version</span>
        <strong>{state?.version ?? '-'}</strong>
      </div>
    </section>
  );

  const setupPanel = (
    <section className="operator-panel setup-panel">
      <h2>Configuracion del partido</h2>
      <label>
        <span>Titulo</span>
        <input value={metaTitle} onChange={(event) => setMetaTitle(event.target.value)} />
      </label>
      <label>
        <span>Pista</span>
        <input value={metaCourt} onChange={(event) => setMetaCourt(event.target.value)} disabled />
      </label>
      <div className="team-select-grid">
        <label>
          <span>Local</span>
          <select value={homeTeamId} onChange={(event) => setHomeTeamId(event.target.value)}>
            {match.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.shortName}
              </option>
            ))}
          </select>
        </label>
        <label>
          <span>Visitante</span>
          <select value={awayTeamId} onChange={(event) => setAwayTeamId(event.target.value)}>
            {match.teams.map((team) => (
              <option key={team.id} value={team.id}>
                {team.shortName}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="lineup-grid">
        <LineupFields
          label="Jugadores local"
          lineup={lineups.home}
          onChange={(home) => setLineups((current) => ({ ...current, home }))}
        />
        <LineupFields
          label="Jugadores visitante"
          lineup={lineups.away}
          onChange={(away) => setLineups((current) => ({ ...current, away }))}
        />
      </div>
      <label>
        <span>Saque inicial</span>
        <select value={servingSide} onChange={(event) => setServingSide(event.target.value as Side)}>
          <option value="home">Local</option>
          <option value="away">Visitante</option>
        </select>
      </label>
      <div className="setup-actions">
        <button type="button" onClick={updateMeta} disabled={!state || match.pending}>
          <Save size={18} />
          Guardar
        </button>
        <button type="button" onClick={startNewMatch} disabled={!state || match.pending}>
          <Repeat2 size={18} />
          Nueva partida
        </button>
        <button type="button" className="primary-action" onClick={beginMatch} disabled={!state || match.pending || state.status === 'live'}>
          <Play size={18} />
          Iniciar partido
        </button>
      </div>
    </section>
  );

  const correctionPanel = (
    <section className="operator-panel danger-zone">
      <h2>Correccion</h2>
      <div className="manual-grid">
        <NumberField label="Juegos L" value={manualHomeGames} onChange={setManualHomeGames} />
        <NumberField label="Juegos V" value={manualAwayGames} onChange={setManualAwayGames} />
        <NumberField label="Puntos L" value={manualHomePoints} onChange={setManualHomePoints} />
        <NumberField label="Puntos V" value={manualAwayPoints} onChange={setManualAwayPoints} />
      </div>
      <button type="button" onClick={applyManualPatch} disabled={!state || match.pending}>
        <ShieldAlert size={18} />
        Aplicar
      </button>
      <button type="button" onClick={() => match.resetMatch()} disabled={!state || match.pending}>
        <ListRestart size={18} />
        Reset
      </button>
    </section>
  );

  return (
    <main className="control-page">
      <header className="control-topbar">
        <div className="brand">
          <img src="/logos/kpl.png" alt="" />
          <span>
            <strong>KPL Live Control</strong>
            <small>{eventId}</small>
          </span>
        </div>

        <div className={`connection-pill ${match.connectionState}`}>
          {match.connectionState === 'connected' ? <Wifi size={16} /> : <WifiOff size={16} />}
          <span>{connectionLabel(match.connectionState)}</span>
        </div>
      </header>

      <nav className="phase-tabs" aria-label="Fase de control">
        <button type="button" className={phase === 'setup' ? 'active' : ''} onClick={() => setPhase('setup')}>
          Configuracion
        </button>
        <button type="button" className={phase === 'score' ? 'active' : ''} onClick={() => setPhase('score')}>
          Marcador
        </button>
      </nav>

      {phase === 'setup' ? (
        <section className="control-layout setup-layout">
          <section className="score-panel">
            {state ? <Scoreboard state={state} teams={match.teams} mode="control" /> : <div className="loading-panel">Cargando marcador</div>}
          </section>
          <aside className="side-panel">
            {eventPanel}
            {setupPanel}
          </aside>
        </section>
      ) : (
        <section className="control-layout">
          <section className="score-panel">
            {state ? <Scoreboard state={state} teams={match.teams} mode="control" /> : <div className="loading-panel">Cargando marcador</div>}

            <div className="point-controls">
              <PointButton side="home" state={state} onClick={() => match.addPoint('home')} pending={match.pending} />
              <PointButton side="away" state={state} onClick={() => match.addPoint('away')} pending={match.pending} />
            </div>

            <div className="quick-actions">
              <button type="button" onClick={() => match.undo()} disabled={!state || match.pending}>
                <RotateCcw size={18} />
                Undo
              </button>
              <button type="button" onClick={() => match.setStatus('live')} disabled={!state || match.pending}>
                <Play size={18} />
                Live
              </button>
              <button type="button" onClick={() => match.setStatus('pre_match')} disabled={!state || match.pending}>
                <Square size={18} />
                Pre
              </button>
              <button type="button" onClick={() => match.setStatus('finished')} disabled={!state || match.pending}>
                <Flag size={18} />
                Final
              </button>
            </div>
          </section>

          <aside className="side-panel">
            {eventPanel}
            <section className="operator-panel">
              <h2>Partido</h2>
              <button type="button" onClick={() => setPhase('setup')}>
                <Repeat2 size={18} />
                Configurar siguiente
              </button>
            </section>
            {correctionPanel}
          </aside>
        </section>
      )}

      {match.error ? <div className="toast-error">{match.error}</div> : null}
    </main>
  );
}

function LineupFields({
  label,
  lineup,
  onChange,
}: {
  label: string;
  lineup: MatchLineups['home'];
  onChange: (lineup: MatchLineups['home']) => void;
}) {
  return (
    <fieldset className="lineup-fieldset">
      <legend>{label}</legend>
      <input
        value={lineup.player1}
        onChange={(event) => onChange({ ...lineup, player1: event.target.value })}
        placeholder="Jugador 1"
      />
      <input
        value={lineup.player2}
        onChange={(event) => onChange({ ...lineup, player2: event.target.value })}
        placeholder="Jugador 2"
      />
    </fieldset>
  );
}

function createEmptyLineups(): MatchLineups {
  return {
    home: { player1: '', player2: '' },
    away: { player1: '', player2: '' },
  };
}

function PointButton({
  side,
  state,
  onClick,
  pending,
}: {
  side: Side;
  state: ReturnType<typeof useMatchSocket>['state'];
  onClick: () => void;
  pending: boolean;
}) {
  const teamId = side === 'home' ? state?.homeTeamId : state?.awayTeamId;
  const label = side === 'home' ? 'Local' : 'Visitante';

  return (
    <button type="button" className={`point-button ${side}`} onClick={onClick} disabled={!state || pending || state.status === 'finished'}>
      <Plus size={28} />
      <span>+ punto</span>
      <strong>{teamId ? label : side}</strong>
    </button>
  );
}

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label>
      <span>{label}</span>
      <input
        type="number"
        min="0"
        step="1"
        value={value}
        onChange={(event) => onChange(Math.max(0, Number(event.target.value) || 0))}
      />
    </label>
  );
}

function connectionLabel(state: string): string {
  return {
    connected: 'Conectado',
    connecting: 'Conectando',
    disconnected: 'Sin conexion',
    error: 'Error',
  }[state] ?? state;
}
