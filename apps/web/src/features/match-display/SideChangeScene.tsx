import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { animate, stagger } from 'animejs';
import type { MatchState, Side, Team } from '@kpl/shared';

export interface SideChangeSceneSignal {
  setNumber: number;
  homeGames: number;
  awayGames: number;
}

const SIDE_CHANGE_DURATION_MS = 3_800;
const SIDE_CHANGE_EXIT_MS = 420;
const SIDE_CHANGE_EXIT_START_MS = SIDE_CHANGE_DURATION_MS - SIDE_CHANGE_EXIT_MS;

export function SideChangeScene({
  signal,
  state,
  teams,
  onDone,
}: {
  signal: SideChangeSceneSignal;
  state: MatchState;
  teams: Team[];
  onDone: () => void;
}) {
  const ref = useRef<HTMLElement>(null);
  const homeTeam = teams.find((team) => team.id === state.homeTeamId);
  const awayTeam = teams.find((team) => team.id === state.awayTeamId);
  const sceneStyle = {
    '--home-color': homeTeam?.primaryColor ?? '#e0bb45',
    '--away-color': awayTeam?.primaryColor ?? '#34d8ff',
  } as CSSProperties;

  useEffect(() => {
    if (!ref.current) {
      return undefined;
    }

    if (prefersReducedMotion()) {
      const timeoutId = window.setTimeout(onDone, SIDE_CHANGE_DURATION_MS);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    const scene = ref.current;
    const homeCard = scene.querySelector('.side-change-card.home');
    const awayCard = scene.querySelector('.side-change-card.away');
    const score = scene.querySelector('.side-change-score');
    const metaItems = scene.querySelectorAll('.side-change-brand, .side-change-heading, .side-change-set');
    const tracks = scene.querySelectorAll('.side-change-track');
    const animations = [
      animate(scene, {
        opacity: [{ from: 0, to: 1 }],
        duration: 160,
        ease: 'outCubic',
      }),
      homeCard
        ? animate(homeCard, {
            opacity: [{ from: 0, to: 1 }],
            x: [{ from: '-62vw', to: 0 }],
            scale: [{ from: 0.92, to: 1 }],
            duration: 980,
            delay: 180,
            ease: 'outExpo',
          })
        : null,
      awayCard
        ? animate(awayCard, {
            opacity: [{ from: 0, to: 1 }],
            x: [{ from: '62vw', to: 0 }],
            scale: [{ from: 0.92, to: 1 }],
            duration: 980,
            delay: 180,
            ease: 'outExpo',
          })
        : null,
      score
        ? animate(score, {
            opacity: [{ from: 0, to: 1 }],
            scale: [{ from: 0.66, to: 1.08 }, { to: 1 }],
            rotate: [{ from: -4, to: 0 }],
            duration: 720,
            delay: 520,
            ease: 'outBack(1.45)',
          })
        : null,
      animate(metaItems, {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 18, to: 0 }],
        duration: 420,
        delay: stagger(80, { start: 260 }),
        ease: 'outCubic',
      }),
      animate(tracks, {
        opacity: [{ from: 0, to: 0.9 }, { to: 0.2 }],
        x: [{ from: '-18vw', to: '18vw' }],
        duration: 1_200,
        delay: stagger(140, { start: 180 }),
        ease: 'outCubic',
      }),
    ];
    const exitTimer = window.setTimeout(() => {
      if (!ref.current) {
        onDone();
        return;
      }

      animate(ref.current, {
        opacity: [{ from: 1, to: 0 }],
        y: [{ from: 0, to: -22 }],
        scale: [{ from: 1, to: 1.015 }],
        duration: SIDE_CHANGE_EXIT_MS,
        ease: 'inCubic',
        onComplete: onDone,
      });
    }, SIDE_CHANGE_EXIT_START_MS);

    return () => {
      window.clearTimeout(exitTimer);
      animations.forEach((animation) => animation?.revert());
    };
  }, [onDone]);

  return (
    <section
      className="side-change-scene"
      data-side-change-scene
      ref={ref}
      style={sceneStyle}
      aria-label="Cambio de lado"
    >
      <div className="side-change-scene-bg" />
      <span className="side-change-track home" aria-hidden="true" />
      <span className="side-change-track away" aria-hidden="true" />
      <span className="side-change-track center" aria-hidden="true" />

      <div className="side-change-brand">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span>Broadcast KPL</span>
      </div>

      <div className="side-change-heading">
        <span>Set {signal.setNumber}</span>
        <strong>Cambio de lado</strong>
      </div>

      <div className="side-change-stage">
        <SideChangeTeamCard side="away" team={awayTeam} fallback="Visitante" />
        <div className="side-change-score">
          <span className="home">{signal.homeGames}</span>
          <em>-</em>
          <span className="away">{signal.awayGames}</span>
        </div>
        <SideChangeTeamCard side="home" team={homeTeam} fallback="Local" />
      </div>

      <div className="side-change-set">
        <span>Los equipos cambian de lado</span>
      </div>
    </section>
  );
}

function SideChangeTeamCard({
  side,
  team,
  fallback,
}: {
  side: Side;
  team: Team | undefined;
  fallback: string;
}) {
  const teamName = team?.name || team?.shortName || fallback;

  return (
    <article className={`side-change-card ${side}`}>
      <span className="side-change-team-logo">
        {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : teamName.slice(0, 3)}
      </span>
      <div>
        <small>{side === 'home' ? 'Ahora a la derecha' : 'Ahora a la izquierda'}</small>
        <strong>{teamName}</strong>
      </div>
    </article>
  );
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
