import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { animate, stagger } from 'animejs';
import type { MatchState, Side, Team } from '@kpl/shared';

export function PrematchOverlayScene({
  state,
  teams,
  exiting,
  onExitComplete,
}: {
  state: MatchState;
  teams: Team[];
  exiting: boolean;
  onExitComplete: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const homeTeam = teams.find((team) => team.id === state.homeTeamId);
  const awayTeam = teams.find((team) => team.id === state.awayTeamId);
  const sceneStyle = {
    '--home-color': homeTeam?.primaryColor ?? '#e0bb45',
    '--away-color': awayTeam?.primaryColor ?? '#34d8ff',
  } as CSSProperties;

  useEffect(() => {
    if (!ref.current || prefersReducedMotion()) {
      return undefined;
    }

    const scene = ref.current;
    const homeCard = scene.querySelector('.prematch-team-card.home');
    const awayCard = scene.querySelector('.prematch-team-card.away');
    const metaItems = scene.querySelectorAll('.prematch-brand, .prematch-title, .prematch-vs, .prematch-footer');
    const beams = scene.querySelectorAll('.prematch-beam');
    const animations = [
      animate(scene, {
        opacity: [{ from: 0, to: 1 }],
        duration: 260,
        ease: 'outCubic',
      }),
      homeCard
        ? animate(homeCard, {
            opacity: [{ from: 0, to: 1 }],
            x: [{ from: -58, to: 0 }],
            scale: [{ from: 0.94, to: 1 }],
            duration: 720,
            delay: 140,
            ease: 'outExpo',
          })
        : null,
      awayCard
        ? animate(awayCard, {
            opacity: [{ from: 0, to: 1 }],
            x: [{ from: 58, to: 0 }],
            scale: [{ from: 0.94, to: 1 }],
            duration: 720,
            delay: 250,
            ease: 'outExpo',
          })
        : null,
      animate(metaItems, {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 18, to: 0 }],
        duration: 460,
        delay: stagger(80, { start: 220 }),
        ease: 'outCubic',
      }),
      animate(beams, {
        opacity: [{ from: 0, to: 0.88 }, { to: 0.2 }],
        x: [{ from: '-26vw', to: '20vw' }],
        duration: 1_250,
        delay: stagger(160, { start: 180 }),
        ease: 'outCubic',
      }),
    ];

    return () => {
      animations.forEach((animation) => animation?.revert());
    };
  }, [state.id]);

  useEffect(() => {
    if (!exiting) {
      return undefined;
    }

    if (!ref.current || prefersReducedMotion()) {
      const timeoutId = window.setTimeout(onExitComplete, 280);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    const animation = animate(ref.current, {
      opacity: [{ from: 1, to: 0 }],
      scale: [{ from: 1, to: 1.025 }],
      duration: 680,
      ease: 'inOutCubic',
      onComplete: onExitComplete,
    });

    return () => {
      animation.revert();
    };
  }, [exiting, onExitComplete]);

  return (
    <section
      className={`prematch-overlay-scene ${exiting ? 'exiting' : ''}`}
      data-prematch-overlay-scene
      ref={ref}
      style={sceneStyle}
      aria-label="Previa del partido"
    >
      <div className="prematch-bg" />
      <span className="prematch-beam home" aria-hidden="true" />
      <span className="prematch-beam away" aria-hidden="true" />
      <span className="prematch-beam center" aria-hidden="true" />

      <div className="prematch-brand">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span>Previa del partido</span>
      </div>

      <div className="prematch-title">
        <span>{state.courtName || 'Pista'}</span>
        <strong>{state.title || 'Partido KPL'}</strong>
      </div>

      <div className="prematch-matchup">
        <PrematchTeamCard side="home" team={homeTeam} lineup={state.lineups.home} fallback="Local" />
        <div className="prematch-vs" aria-hidden="true">
          VS
        </div>
        <PrematchTeamCard side="away" team={awayTeam} lineup={state.lineups.away} fallback="Visitante" />
      </div>

      <div className="prematch-footer">
        <span>Saque inicial</span>
        <strong>{state.servingSide === 'home' ? homeTeam?.name ?? 'Local' : awayTeam?.name ?? 'Visitante'}</strong>
      </div>
    </section>
  );
}

function PrematchTeamCard({
  side,
  team,
  lineup,
  fallback,
}: {
  side: Side;
  team: Team | undefined;
  lineup: MatchState['lineups']['home'];
  fallback: string;
}) {
  const teamName = team?.name || team?.shortName || fallback;
  const players = [lineup.player1, lineup.player2].map((player) => player.trim()).filter(Boolean);

  return (
    <article className={`prematch-team-card ${side}`}>
      <span className="prematch-team-logo">
        {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : teamName.slice(0, 3)}
      </span>
      <div className="prematch-team-copy">
        <small>{side === 'home' ? 'Equipo local' : 'Equipo visitante'}</small>
        <strong>{teamName}</strong>
      </div>
      <ul>
        {(players.length > 0 ? players : ['Jugador 1', 'Jugador 2']).map((player) => (
          <li key={player}>{player}</li>
        ))}
      </ul>
    </article>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
