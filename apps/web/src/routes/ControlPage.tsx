import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  Eye,
  EyeOff,
  Flag,
  ListRestart,
  Maximize2,
  Minimize2,
  MonitorPlay,
  Move,
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
import { animate, stagger } from 'animejs';
import { DEFAULT_OVERLAY_SETTINGS } from '@kpl/shared';
import type {
  ManualScorePatch,
  MatchGameScore,
  MatchLineups,
  MatchState,
  MatchSetScore,
  OverlayPosition,
  OverlaySettingsPatch,
  OverlaySize,
  Side,
  Team,
} from '@kpl/shared';
import { Scoreboard } from '../components/Scoreboard.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';
import { MATCH_CARDS, type MatchCardDefinition } from '../lib/match-cards.js';

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
  const stageRef = useRef<HTMLElement>(null);

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

  useEffect(() => {
    if (!stageRef.current || prefersReducedMotion()) {
      return undefined;
    }

    const animation = animate(stageRef.current.querySelectorAll('.score-panel, .operator-panel'), {
      opacity: [{ from: 0, to: 1 }],
      y: [{ from: 10, to: 0 }],
      delay: stagger(35),
      duration: 280,
      ease: 'outCubic',
    });

    return () => {
      animation.revert();
    };
  }, [eventId, phase, state?.status]);

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

  async function updateOverlaySettings(patch: OverlaySettingsPatch) {
    await match.updateOverlaySettings(patch);
  }

  const overlaySettings = state?.overlaySettings ?? DEFAULT_OVERLAY_SETTINGS;
  const isSetupPhase = phase === 'setup';

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
      <h2>{state?.status === 'pre_match' ? 'Preparar partido' : 'Preparar siguiente'}</h2>
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

  const overlayPanel = (
    <section className="operator-panel overlay-panel">
      <h2>OBS marcador</h2>
      <button
        type="button"
        className={`switch-button ${overlaySettings.visible ? 'on' : ''}`}
        onClick={() => void updateOverlaySettings({ visible: !overlaySettings.visible })}
        disabled={!state || match.pending}
      >
        {overlaySettings.visible ? <Eye size={18} /> : <EyeOff size={18} />}
        <span>{overlaySettings.visible ? 'Marcador visible' : 'Marcador oculto'}</span>
      </button>

      <SegmentedControl<OverlaySize>
        label="Tamano"
        value={overlaySettings.size}
        disabled={!state || match.pending}
        options={[
          { value: 'compact', label: 'S', icon: <Minimize2 size={16} /> },
          { value: 'standard', label: 'M', icon: <Move size={16} /> },
          { value: 'large', label: 'L', icon: <Maximize2 size={16} /> },
        ]}
        onChange={(size) => void updateOverlaySettings({ size })}
      />

      <SegmentedControl<OverlayPosition>
        label="Posicion"
        value={overlaySettings.position}
        disabled={!state || match.pending}
        options={[
          { value: 'top-left', label: 'Arriba', icon: <MonitorPlay size={16} /> },
          { value: 'center', label: 'Centro', icon: <Move size={16} /> },
          { value: 'bottom-center', label: 'Abajo', icon: <MonitorPlay size={16} /> },
        ]}
        onChange={(position) => void updateOverlaySettings({ position })}
      />
    </section>
  );

  const cardsPanel = state ? (
    <MatchCardsPanel
      state={state}
      teams={match.teams}
      pending={match.pending}
      onUse={(side, card) => void match.useMatchCard(side, card.id, card.name)}
    />
  ) : null;

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

      {state?.status === 'pre_match' ? (
        <div className="control-status-strip">
          <Play size={18} />
          <span>Configura equipos, jugadores y saque antes de iniciar.</span>
        </div>
      ) : (
        <nav className="phase-tabs control-mode-tabs" aria-label="Fase de control">
          <button type="button" className={phase === 'score' ? 'active' : ''} onClick={() => setPhase('score')}>
            Marcador
          </button>
          <button type="button" className={phase === 'setup' ? 'active' : ''} onClick={() => setPhase('setup')}>
            Siguiente
          </button>
        </nav>
      )}

      {isSetupPhase ? (
        <section className="control-layout setup-layout control-stage" ref={stageRef}>
          <aside className="side-panel setup-stack">
            {eventPanel}
            {setupPanel}
          </aside>
          <section className="score-panel setup-preview">
            {state ? (
              <Scoreboard state={state} teams={match.teams} mode="control" />
            ) : (
              <div className="loading-panel">Cargando marcador</div>
            )}
          </section>
        </section>
      ) : (
        <section className="control-layout control-stage" ref={stageRef}>
          <section className="score-panel live-score-panel">
            {state ? (
              <Scoreboard state={state} teams={match.teams} mode="control" />
            ) : (
              <div className="loading-panel">Cargando marcador</div>
            )}

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
            {overlayPanel}
            {cardsPanel}
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

function MatchCardsPanel({
  state,
  teams,
  pending,
  onUse,
}: {
  state: MatchState;
  teams: Team[];
  pending: boolean;
  onUse: (side: Side, card: MatchCardDefinition) => void;
}) {
  const [selectedSide, setSelectedSide] = useState<Side>('home');
  const selectedTeam = teams.find((item) => item.id === (selectedSide === 'home' ? state.homeTeamId : state.awayTeamId));
  const usedCard = state.cards?.[selectedSide] ?? null;

  return (
    <section className="operator-panel match-cards-panel">
      <h2>Cartas banquillo</h2>
      <div className="card-team-switch" role="group" aria-label="Equipo que usa la carta">
        {(['home', 'away'] as const).map((side) => {
          const team = teams.find((item) => item.id === (side === 'home' ? state.homeTeamId : state.awayTeamId));
          const sideUsedCard = state.cards?.[side] ?? null;

          return (
            <button
              key={side}
              type="button"
              className={selectedSide === side ? 'active' : ''}
              onClick={() => setSelectedSide(side)}
            >
              <strong>{team?.shortName ?? sideLabel(side)}</strong>
              <span>{sideUsedCard ? `Usada: ${sideUsedCard.cardName}` : 'Disponible'}</span>
            </button>
          );
        })}
      </div>

      <div className="card-side-heading">
        <strong>{selectedTeam?.shortName ?? sideLabel(selectedSide)}</strong>
        <span>{usedCard ? `Ya uso ${usedCard.cardName}` : 'Elige carta'}</span>
      </div>

      <div className="card-action-grid">
        {MATCH_CARDS.map((card) => (
          <button
            key={card.id}
            type="button"
            className={usedCard?.cardId === card.id ? 'used' : ''}
            onClick={() => onUse(selectedSide, card)}
            disabled={pending || state.status !== 'live' || Boolean(usedCard)}
            aria-label={`${selectedTeam?.shortName ?? sideLabel(selectedSide)} utiliza ${card.name}`}
          >
            <img src={card.imageUrl} alt="" />
            <span>{card.name}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function SegmentedControl<TValue extends string>({
  label,
  value,
  options,
  disabled,
  onChange,
}: {
  label: string;
  value: TValue;
  options: Array<{ value: TValue; label: string; icon: ReactNode }>;
  disabled: boolean;
  onChange: (value: TValue) => void;
}) {
  return (
    <div className="segmented-field">
      <span>{label}</span>
      <div className="segmented-control" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            key={option.value}
            type="button"
            className={option.value === value ? 'active' : ''}
            onClick={() => onChange(option.value)}
            disabled={disabled}
          >
            {option.icon}
            <span>{option.label}</span>
          </button>
        ))}
      </div>
    </div>
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

function sideLabel(side: Side): string {
  return side === 'home' ? 'Local' : 'Visitante';
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
