import { useState, type ReactNode } from 'react';
import { BarChart3, Trophy, UsersRound, CalendarDays, PanelBottom, Eye, EyeOff, Maximize2, X } from 'lucide-react';
import { DEFAULT_SPONSOR_ADS } from '@kpl/shared';
import type { MatchState, OverlayDataSceneKind, OverlayDataSceneTarget, Side, SponsorAdsState, SponsorTickerPatch, Team } from '@kpl/shared';
import { MATCH_CARDS, SPONSORS, type MatchCardDefinition } from '@kpl/match-data';

export function DataScenesPanel({
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

export function MatchCardsPanel({
  state,
  teams,
  pending,
  onUse,
  resolveAssetUrl = url => url,
}: {
  state: MatchState;
  teams: Team[];
  pending: boolean;
  onUse: (side: Side, card: MatchCardDefinition) => void;
  resolveAssetUrl?: (url:string) => string;
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
            <img src={resolveAssetUrl(card.imageUrl)} alt="" />
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

export function SponsorAdsPanel({
  sponsorAds,
  pending,
  onUpdateTicker,
  onTriggerFullscreen,
  resolveAssetUrl = url => url,
}: {
  sponsorAds: SponsorAdsState;
  pending: boolean;
  onUpdateTicker: (patch: SponsorTickerPatch) => void;
  onTriggerFullscreen: (sponsorIds: string[] | null) => void;
  resolveAssetUrl?: (url:string) => string;
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
                {sponsor.logoUrl ? <img src={resolveAssetUrl(sponsor.logoUrl)} alt="" /> : sponsorInitials(sponsor.name)}
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

export function SegmentedControl<TValue extends string>({
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


function sideLabel(side:Side):string{return side==='home'?'Local':'Visitante';}
function sponsorInitials(value:string):string{return value.split(/\s+/).filter(Boolean).slice(0,2).map(part=>part[0]?.toUpperCase()??'').join('');}
