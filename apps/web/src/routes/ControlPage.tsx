import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  BarChart3,
  CalendarDays,
  CreditCard,
  Eye,
  EyeOff,
  Flag,
  ListRestart,
  Maximize2,
  Megaphone,
  Menu,
  MonitorPlay,
  Move,
  PanelBottom,
  Pencil,
  Repeat2,
  Play,
  Plus,
  RotateCcw,
  Save,
  ShieldAlert,
  Square,
  Trophy,
  UsersRound,
  Wifi,
  WifiOff,
  X,
} from 'lucide-react';
import { animate, stagger } from 'animejs';
import { DEFAULT_OVERLAY_SETTINGS, DEFAULT_SPONSOR_ADS, formatPoint, getCompletedSetCount } from '@kpl/shared';
import type {
  ManualScorePatch,
  MatchGameScore,
  MatchLineups,
  MatchState,
  MatchSetScore,
  OverlayDataSceneKind,
  OverlayDataSceneTarget,
  OverlayPosition,
  OverlaySettingsPatch,
  Side,
  SponsorAdsState,
  SponsorTickerPatch,
  Team,
} from '@kpl/shared';
import { Scoreboard } from '../components/Scoreboard.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';
import { MATCH_CARDS, type MatchCardDefinition } from '../lib/match-cards.js';
import { SPONSORS } from '../lib/sponsors.js';

type ControlPhase = 'setup' | 'score';
type MobilePanel = 'cards' | 'data' | 'ads' | 'edit' | 'menu';

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
  const [mobilePanel, setMobilePanel] = useState<MobilePanel | null>(null);
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
    setMobilePanel(null);
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

  async function triggerDataScene(kind: OverlayDataSceneKind, target: OverlayDataSceneTarget) {
    await match.triggerDataScene(kind, target);
  }

  async function updateSponsorTicker(patch: SponsorTickerPatch) {
    await match.updateSponsorTicker(patch);
  }

  async function triggerSponsorFullscreen(sponsorIds: string[] | null) {
    await match.triggerSponsorFullscreen(sponsorIds, 8);
  }

  const overlaySettings = state?.overlaySettings ?? DEFAULT_OVERLAY_SETTINGS;
  const isSetupPhase = phase === 'setup';
  const homeTeam = state ? match.teams.find((team) => team.id === state.homeTeamId) : undefined;
  const awayTeam = state ? match.teams.find((team) => team.id === state.awayTeamId) : undefined;

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

      <SegmentedControl<OverlayPosition>
        label="Preset"
        value={overlaySettings.position}
        disabled={!state || match.pending}
        options={[
          { value: 'top-left', label: 'Lateral', icon: <MonitorPlay size={16} /> },
          { value: 'center', label: 'Centro', icon: <Move size={16} /> },
          { value: 'bottom-center', label: 'Inferior', icon: <MonitorPlay size={16} /> },
        ]}
        onChange={(position) => void updateOverlaySettings({ position })}
      />

      <button
        type="button"
        className={`switch-button ${overlaySettings.dataScenesAuto ? 'on' : ''}`}
        onClick={() => void updateOverlaySettings({ dataScenesAuto: !overlaySettings.dataScenesAuto })}
        disabled={!state || match.pending}
      >
        {overlaySettings.dataScenesAuto ? <Eye size={18} /> : <EyeOff size={18} />}
        <span>{overlaySettings.dataScenesAuto ? 'Auto previa activo' : 'Auto previa apagado'}</span>
      </button>
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

  const dataScenesPanel = state ? (
    <DataScenesPanel
      state={state}
      teams={match.teams}
      pending={match.pending}
      onTrigger={(kind, target) => void triggerDataScene(kind, target)}
    />
  ) : null;

  const sponsorAdsPanel = state ? (
    <SponsorAdsPanel
      sponsorAds={state.sponsorAds ?? DEFAULT_SPONSOR_ADS}
      pending={match.pending}
      onUpdateTicker={(patch) => void updateSponsorTicker(patch)}
      onTriggerFullscreen={(sponsorIds) => void triggerSponsorFullscreen(sponsorIds)}
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

  const matchMenuPanel = (
    <section className="operator-panel mobile-menu-panel">
      <h2>Menu partido</h2>
      <div className="quick-actions mobile-menu-actions">
        <button type="button" onClick={() => void match.setStatus('live')} disabled={!state || match.pending}>
          <Play size={18} />
          Live
        </button>
        <button type="button" onClick={() => void match.setStatus('pre_match')} disabled={!state || match.pending}>
          <Square size={18} />
          Pre
        </button>
        <button type="button" onClick={() => void match.setStatus('finished')} disabled={!state || match.pending}>
          <Flag size={18} />
          Final
        </button>
        <button
          type="button"
          onClick={() => {
            setMobilePanel(null);
            setPhase('setup');
          }}
          disabled={!state}
        >
          <Repeat2 size={18} />
          Siguiente
        </button>
      </div>
    </section>
  );

  return (
    <main className={`control-page ${isSetupPhase ? 'setup-mode' : 'score-mode'}`}>
      <header className="control-topbar">
        <div className="brand">
          <img src="/logos/kpl-wordmark.png" alt="" />
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
        <section className="control-layout control-stage score-layout" ref={stageRef}>
          <section className="score-panel live-score-panel">
            {state ? (
              <MobileScoreControl
                state={state}
                teams={match.teams}
                activeSet={activeSet}
                pending={match.pending}
                onAddPoint={(side) => void match.addPoint(side)}
                onUndo={() => void match.undo()}
                onOpenPanel={setMobilePanel}
              />
            ) : null}

            {state ? (
              <Scoreboard state={state} teams={match.teams} mode="control" />
            ) : (
              <div className="loading-panel">Cargando marcador</div>
            )}

            <div className="point-controls">
              <PointButton
                side="home"
                state={state}
                label={homeTeam?.shortName ?? 'Local'}
                onClick={() => void match.addPoint('home')}
                pending={match.pending}
              />
              <PointButton
                side="away"
                state={state}
                label={awayTeam?.shortName ?? 'Visitante'}
                onClick={() => void match.addPoint('away')}
                pending={match.pending}
              />
            </div>

            <nav className="control-action-bar" aria-label="Acciones del marcador">
              <button type="button" className="danger" onClick={() => void match.undo()} disabled={!state || match.pending}>
                <RotateCcw size={18} />
                <span>Deshacer</span>
              </button>
              <button type="button" onClick={() => setMobilePanel('cards')} disabled={!state}>
                <CreditCard size={18} />
                <span>Carta especial</span>
              </button>
              <button type="button" onClick={() => setMobilePanel('data')} disabled={!state}>
                <BarChart3 size={18} />
                <span>OBS datos</span>
              </button>
              <button type="button" onClick={() => setMobilePanel('ads')} disabled={!state}>
                <Megaphone size={18} />
                <span>Anuncios</span>
              </button>
              <button type="button" onClick={() => setMobilePanel('edit')} disabled={!state}>
                <Pencil size={18} />
                <span>Editar marcador</span>
              </button>
              <button type="button" onClick={() => setMobilePanel('menu')} disabled={!state}>
                <Menu size={18} />
                <span>Menu</span>
              </button>
            </nav>
          </section>
        </section>
      )}

      <MobileControlModal title="Carta especial" open={mobilePanel === 'cards'} onClose={() => setMobilePanel(null)}>
        {cardsPanel}
      </MobileControlModal>
      <MobileControlModal title="OBS datos" open={mobilePanel === 'data'} onClose={() => setMobilePanel(null)}>
        {dataScenesPanel}
      </MobileControlModal>
      <MobileControlModal title="Anuncios" open={mobilePanel === 'ads'} onClose={() => setMobilePanel(null)}>
        {sponsorAdsPanel}
      </MobileControlModal>
      <MobileControlModal title="Editar marcador" open={mobilePanel === 'edit'} onClose={() => setMobilePanel(null)}>
        {correctionPanel}
      </MobileControlModal>
      <MobileControlModal title="Menu" open={mobilePanel === 'menu'} onClose={() => setMobilePanel(null)}>
        {matchMenuPanel}
        {overlayPanel}
        {eventPanel}
      </MobileControlModal>

      {match.error ? <div className="toast-error">{match.error}</div> : null}
    </main>
  );
}

function MobileScoreControl({
  state,
  teams,
  activeSet,
  pending,
  onAddPoint,
  onUndo,
  onOpenPanel,
}: {
  state: MatchState;
  teams: Team[];
  activeSet: MatchSetScore | null;
  pending: boolean;
  onAddPoint: (side: Side) => void;
  onUndo: () => void;
  onOpenPanel: (panel: MobilePanel) => void;
}) {
  const home = teams.find((team) => team.id === state.homeTeamId);
  const away = teams.find((team) => team.id === state.awayTeamId);
  const servingTeam = state.servingSide === 'home' ? home : away;
  const homeName = home?.shortName ?? 'Equipo A';
  const awayName = away?.shortName ?? 'Equipo B';

  return (
    <section className="mobile-score-control" aria-label="Control movil del marcador">
      <header className="mobile-score-header">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span className={`mobile-live-pill ${state.status}`}>{statusLabel(state.status)}</span>
      </header>

      <div className="mobile-score-title">
        <span />
        <strong>{state.title || 'Marcador del partido'}</strong>
        <span />
      </div>

      <div className="mobile-team-score-grid">
        <MobileTeamBlock team={home} fallback={homeName} side="home" />
        <div className="mobile-versus" aria-hidden="true">
          VS
        </div>
        <MobileTeamBlock team={away} fallback={awayName} side="away" />
        <strong className="mobile-point-value home">{formatPoint(state, 'home')}</strong>
        <strong className="mobile-point-value away">{formatPoint(state, 'away')}</strong>
      </div>

      <dl className="mobile-score-stats">
        <div>
          <dt>Juegos</dt>
          <dd>
            <span className="home">{activeSet?.homeGames ?? 0}</span>
            <span>-</span>
            <span className="away">{activeSet?.awayGames ?? 0}</span>
          </dd>
        </div>
        <div>
          <dt>Sets</dt>
          <dd>
            <span className="home">{getCompletedSetCount(state, 'home')}</span>
            <span>-</span>
            <span className="away">{getCompletedSetCount(state, 'away')}</span>
          </dd>
        </div>
        <div>
          <dt>Saque</dt>
          <dd className="serve-stat">
            <span className="mobile-ball" />
            <span>{servingTeam?.shortName ?? sideLabel(state.servingSide)}</span>
          </dd>
        </div>
        <div>
          <dt>Estado</dt>
          <dd>{state.courtName || statusLabel(state.status)}</dd>
        </div>
      </dl>

      <div className="mobile-point-actions">
        <button type="button" className="home" onClick={() => onAddPoint('home')} disabled={pending || state.status === 'finished'}>
          <Plus size={42} />
          <span>Punto {homeName}</span>
        </button>
        <button type="button" className="away" onClick={() => onAddPoint('away')} disabled={pending || state.status === 'finished'}>
          <Plus size={42} />
          <span>Punto {awayName}</span>
        </button>
      </div>

      <nav className="mobile-action-dock" aria-label="Acciones del marcador">
        <button type="button" className="danger" onClick={onUndo} disabled={pending}>
          <RotateCcw size={34} />
          <span>Deshacer</span>
        </button>
        <button type="button" onClick={() => onOpenPanel('cards')}>
          <CreditCard size={32} />
          <span>Carta especial</span>
        </button>
        <button type="button" onClick={() => onOpenPanel('ads')}>
          <Megaphone size={32} />
          <span>Anuncios</span>
        </button>
        <button type="button" onClick={() => onOpenPanel('edit')}>
          <Pencil size={32} />
          <span>Editar marcador</span>
        </button>
        <button type="button" onClick={() => onOpenPanel('menu')}>
          <Menu size={34} />
          <span>Menu</span>
        </button>
      </nav>
    </section>
  );
}

function MobileTeamBlock({
  team,
  fallback,
  side,
}: {
  team: Team | undefined;
  fallback: string;
  side: Side;
}) {
  return (
    <div className={`mobile-team-block ${side}`}>
      <span className="mobile-team-logo">
        {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : teamInitials(fallback)}
      </span>
      <strong>{fallback}</strong>
    </div>
  );
}

function MobileControlModal({
  title,
  open,
  onClose,
  children,
}: {
  title: string;
  open: boolean;
  onClose: () => void;
  children: ReactNode;
}) {
  if (!open) {
    return null;
  }

  return (
    <div className="mobile-modal-backdrop" role="presentation" onClick={onClose}>
      <section
        className="mobile-modal-sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onClick={(event) => event.stopPropagation()}
      >
        <header className="mobile-modal-header">
          <strong>{title}</strong>
          <button type="button" aria-label="Cerrar" onClick={onClose}>
            <X size={22} />
          </button>
        </header>
        <div className="mobile-modal-content">{children}</div>
      </section>
    </div>
  );
}

function DataScenesPanel({
  state,
  teams,
  pending,
  onTrigger,
}: {
  state: MatchState;
  teams: Team[];
  pending: boolean;
  onTrigger: (kind: OverlayDataSceneKind, target: OverlayDataSceneTarget) => void;
}) {
  const homeTeam = teams.find((team) => team.id === state.homeTeamId);
  const awayTeam = teams.find((team) => team.id === state.awayTeamId);
  const actions: Array<{
    kind: OverlayDataSceneKind;
    target: OverlayDataSceneTarget;
    label: string;
    detail: string;
    icon: ReactNode;
  }> = [
    {
      kind: 'standings',
      target: { type: 'league' },
      label: 'Clasificacion',
      detail: 'Tabla completa',
      icon: <Trophy size={18} />,
    },
    {
      kind: 'player-ranking',
      target: { type: 'league' },
      label: 'Ranking jugadores',
      detail: 'Top 10 por puntos',
      icon: <BarChart3 size={18} />,
    },
    {
      kind: 'team-roster',
      target: { type: 'side', side: 'home' },
      label: `Plantilla ${homeTeam?.shortName ?? 'local'}`,
      detail: 'Equipo local',
      icon: <UsersRound size={18} />,
    },
    {
      kind: 'team-roster',
      target: { type: 'side', side: 'away' },
      label: `Plantilla ${awayTeam?.shortName ?? 'visitante'}`,
      detail: 'Equipo visitante',
      icon: <UsersRound size={18} />,
    },
    {
      kind: 'calendar',
      target: { type: 'league' },
      label: 'Calendario',
      detail: 'Jornadas y horarios',
      icon: <CalendarDays size={18} />,
    },
    {
      kind: 'upcoming-matches',
      target: { type: 'league' },
      label: 'Proximos partidos',
      detail: 'Lo siguiente',
      icon: <CalendarDays size={18} />,
    },
    {
      kind: 'latest-results',
      target: { type: 'league' },
      label: 'Ultimos resultados',
      detail: 'Marcadores recientes',
      icon: <BarChart3 size={18} />,
    },
  ];

  return (
    <section className="operator-panel data-scenes-panel">
      <h2>OBS datos</h2>
      <div className="data-scene-grid">
        {actions.map((action) => (
          <button
            key={`${action.kind}-${targetKey(action.target)}`}
            type="button"
            onClick={() => onTrigger(action.kind, action.target)}
            disabled={pending}
          >
            {action.icon}
            <span>
              <strong>{action.label}</strong>
              <small>{action.detail}</small>
            </span>
          </button>
        ))}
      </div>
    </section>
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

type SponsorTickerSpeed = 'fast' | 'normal' | 'slow';

const SPONSOR_TICKER_SPEEDS: Record<SponsorTickerSpeed, number> = {
  fast: 18,
  normal: 28,
  slow: 42,
};

function SponsorAdsPanel({
  sponsorAds,
  pending,
  onUpdateTicker,
  onTriggerFullscreen,
}: {
  sponsorAds: SponsorAdsState;
  pending: boolean;
  onUpdateTicker: (patch: SponsorTickerPatch) => void;
  onTriggerFullscreen: (sponsorIds: string[] | null) => void;
}) {
  const ads = sponsorAds ?? DEFAULT_SPONSOR_ADS;
  const ticker = ads.ticker ?? DEFAULT_SPONSOR_ADS.ticker;
  const selectedSet = new Set(ticker.sponsorIds);
  const fullscreenSponsorIds = ticker.sponsorIds.length > 0 ? ticker.sponsorIds : SPONSORS.map((sponsor) => sponsor.id);
  const activeSponsorCount = ads.fullscreen?.sponsorIds.length ?? 0;

  function toggleSponsor(sponsorId: string) {
    const nextIds = selectedSet.has(sponsorId)
      ? ticker.sponsorIds.filter((id) => id !== sponsorId)
      : [...ticker.sponsorIds, sponsorId];

    onUpdateTicker({
      sponsorIds: nextIds,
      visible: nextIds.length > 0 ? ticker.visible : false,
    });
  }

  return (
    <section className="operator-panel sponsor-ads-panel">
      <h2>Anuncios</h2>

      <div className="sponsor-panel-heading">
        <PanelBottom size={18} />
        <strong>Barra inferior</strong>
        <span>{ticker.sponsorIds.length} logos</span>
      </div>

      <button
        type="button"
        className={`switch-button ${ticker.visible ? 'on' : ''}`}
        onClick={() => onUpdateTicker({ visible: !ticker.visible })}
        disabled={pending || ticker.sponsorIds.length === 0}
      >
        {ticker.visible ? <Eye size={18} /> : <EyeOff size={18} />}
        <span>{ticker.visible ? 'Barra activa' : 'Barra apagada'}</span>
      </button>

      <SegmentedControl<SponsorTickerSpeed>
        label="Ritmo"
        value={speedPreset(ticker.speedSeconds)}
        disabled={pending}
        options={[
          { value: 'fast', label: 'Rapido', icon: <PanelBottom size={16} /> },
          { value: 'normal', label: 'Medio', icon: <PanelBottom size={16} /> },
          { value: 'slow', label: 'Lento', icon: <PanelBottom size={16} /> },
        ]}
        onChange={(speed) => onUpdateTicker({ speedSeconds: SPONSOR_TICKER_SPEEDS[speed] })}
      />

      <div className="sponsor-picker-grid">
        {SPONSORS.map((sponsor) => {
          const selected = selectedSet.has(sponsor.id);

          return (
            <button
              key={sponsor.id}
              type="button"
              className={selected ? 'active' : ''}
              onClick={() => toggleSponsor(sponsor.id)}
              disabled={pending}
            >
              <span className="sponsor-panel-logo">
                {sponsor.logoUrl ? <img src={sponsor.logoUrl} alt="" /> : sponsorInitials(sponsor.name)}
              </span>
              <span>
                <strong>{sponsor.name}</strong>
                <small>{selected ? 'En barra' : 'Agregar'}</small>
              </span>
            </button>
          );
        })}
      </div>

      <div className="sponsor-panel-heading">
        <Maximize2 size={18} />
        <strong>Pantalla grande</strong>
        <span>{activeSponsorCount > 0 ? `${activeSponsorCount} logos` : 'Lista'}</span>
      </div>

      <button
        type="button"
        className="sponsor-fullscreen-all-button"
        onClick={() => onTriggerFullscreen(fullscreenSponsorIds)}
        disabled={pending || fullscreenSponsorIds.length === 0}
      >
        <Maximize2 size={18} />
        <span>
          <strong>Mostrar todos</strong>
          <small>{ticker.sponsorIds.length > 0 ? 'Sponsors de la barra' : 'Catalogo completo'}</small>
        </span>
      </button>

      {ads.fullscreen ? (
        <button type="button" className="sponsor-clear-button" onClick={() => onTriggerFullscreen(null)} disabled={pending}>
          <X size={18} />
          Limpiar pantalla
        </button>
      ) : null}
    </section>
  );
}

function speedPreset(speedSeconds: number): SponsorTickerSpeed {
  if (speedSeconds <= 20) {
    return 'fast';
  }

  if (speedSeconds >= 36) {
    return 'slow';
  }

  return 'normal';
}

function targetKey(target: OverlayDataSceneTarget): string {
  if (target.type === 'side') {
    return target.side;
  }

  if (target.type === 'team') {
    return target.teamId;
  }

  return 'league';
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
  label,
  onClick,
  pending,
}: {
  side: Side;
  state: ReturnType<typeof useMatchSocket>['state'];
  label: string;
  onClick: () => void;
  pending: boolean;
}) {
  return (
    <button type="button" className={`point-button ${side}`} onClick={onClick} disabled={!state || pending || state.status === 'finished'}>
      <Plus size={28} />
      <strong>{label}</strong>
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

function statusLabel(status: MatchState['status']): string {
  return {
    pre_match: 'Pre',
    live: 'En directo',
    finished: 'Final',
  }[status];
}

function teamInitials(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
}

function sponsorInitials(value: string): string {
  return teamInitials(value);
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
