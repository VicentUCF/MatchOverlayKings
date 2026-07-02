import { useEffect, useRef } from 'react';
import type { CSSProperties } from 'react';
import { animate, stagger } from 'animejs';
import type { MatchCardAnnouncement, Team } from '@kpl/shared';
import { findMatchCard } from '../lib/match-cards.js';

const CARD_SCENE_DURATION_MS = 5_000;
const CARD_SCENE_EXIT_MS = 520;
const CARD_SCENE_EXIT_START_MS = CARD_SCENE_DURATION_MS - CARD_SCENE_EXIT_MS;

export function CardAnnouncementScene({
  announcement,
  teams,
  onDone,
}: {
  announcement: MatchCardAnnouncement;
  teams: Team[];
  onDone: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const card = findMatchCard(announcement.cardId);
  const team = teams.find((item) => item.id === announcement.teamId);
  const teamLabel = streamTeamLabel(team, announcement.teamId);
  const sceneStyle = {
    '--team-color': team?.primaryColor ?? '#e0bb45',
    '--team-accent': team?.secondaryColor ?? '#34d8ff',
  } as CSSProperties;

  useEffect(() => {
    if (!card) {
      onDone();
      return undefined;
    }

    if (!ref.current) {
      return undefined;
    }

    if (prefersReducedMotion()) {
      const timeoutId = window.setTimeout(onDone, CARD_SCENE_DURATION_MS);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    const scene = ref.current;
    const background = scene.querySelector('.card-scene-background');
    const cardFrame = scene.querySelector('.card-scene-card-frame');
    const cardImage = scene.querySelector('.card-scene-card-image');
    const copyItems = scene.querySelectorAll('.card-scene-copy > *');
    const brandItems = scene.querySelectorAll('.card-scene-brand, .card-scene-team-badge');
    const sweeps = scene.querySelectorAll('.card-scene-sweep');
    const sparks = scene.querySelectorAll('.card-scene-spark');
    const animations = [
      animate(scene, {
        opacity: [{ from: 0, to: 1 }],
        duration: 180,
        ease: 'outCubic',
      }),
      background
        ? animate(background, {
            opacity: [{ from: 0, to: 1 }],
            scale: [{ from: 0.86, to: 1 }],
            duration: 420,
            ease: 'outExpo',
          })
        : null,
      cardFrame
        ? animate(cardFrame, {
            opacity: [{ from: 0, to: 1 }],
            scale: [{ from: 0.46, to: 1.04 }, { to: 1 }],
            rotate: [{ from: -10, to: 2 }, { to: 0 }],
            y: [{ from: 88, to: -10 }, { to: 0 }],
            duration: 920,
            ease: 'outBack(1.5)',
          })
        : null,
      cardImage
        ? animate(cardImage, {
            filter: [
              { from: 'drop-shadow(0 0 0 rgb(0 0 0 / 0%)) brightness(1.5)', to: 'drop-shadow(0 36px 62px rgb(0 0 0 / 68%)) brightness(1)' },
            ],
            duration: 760,
            ease: 'outCubic',
          })
        : null,
      animate(copyItems, {
        opacity: [{ from: 0, to: 1 }],
        y: [{ from: 24, to: 0 }],
        duration: 460,
        delay: stagger(80, { start: 280 }),
        ease: 'outCubic',
      }),
      animate(brandItems, {
        opacity: [{ from: 0, to: 1 }],
        x: [{ from: -18, to: 0 }],
        duration: 420,
        delay: stagger(90, { start: 260 }),
        ease: 'outCubic',
      }),
      animate(sweeps, {
        opacity: [{ from: 0, to: 0.95 }, { to: 0 }],
        x: [{ from: '-120vw', to: '120vw' }],
        duration: 1_160,
        delay: stagger(130, { start: 180 }),
        ease: 'outCubic',
      }),
      animate(sparks, {
        opacity: [{ from: 0, to: 1 }, { to: 0 }],
        scale: [{ from: 0.45, to: 1.25 }],
        duration: 1_450,
        delay: stagger(95, { start: 420, from: 'center' }),
        ease: 'outExpo',
      }),
    ];
    const exitTimer = window.setTimeout(() => {
      if (!ref.current) {
        onDone();
        return;
      }

      animate(ref.current, {
        opacity: [{ from: 1, to: 0 }],
        scale: [{ from: 1, to: 1.035 }],
        duration: CARD_SCENE_EXIT_MS,
        ease: 'inCubic',
        onComplete: onDone,
      });
    }, CARD_SCENE_EXIT_START_MS);

    return () => {
      window.clearTimeout(exitTimer);
      animations.forEach((animation) => animation?.revert());
    };
  }, [card, onDone]);

  if (!card) {
    return null;
  }

  return (
    <div
      className="card-announcement-scene"
      data-card-announcement-scene
      data-card-id={announcement.cardId}
      ref={ref}
      style={sceneStyle}
    >
      <div className="card-scene-background" />
      <span className="card-scene-sweep one" aria-hidden="true" />
      <span className="card-scene-sweep two" aria-hidden="true" />
      <span className="card-scene-sweep three" aria-hidden="true" />
      <span className="card-scene-spark a" aria-hidden="true" />
      <span className="card-scene-spark b" aria-hidden="true" />
      <span className="card-scene-spark c" aria-hidden="true" />
      <span className="card-scene-spark d" aria-hidden="true" />

      <div className="card-scene-brand">
        <img src="/logos/kpl-wordmark.png" alt="" />
        <span>Broadcast KPL</span>
      </div>

      <div className="card-scene-stage">
        <div className="card-scene-copy">
          <span>Carta especial</span>
          <strong>{announcement.cardName}</strong>
          <small>{teamLabel} activa su carta</small>
        </div>

        <div className="card-scene-card-frame">
          <img className="card-scene-card-image" src={card.imageUrl} alt="" />
        </div>

        <div className="card-scene-team-badge">
          <span>
            {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : teamLabel.slice(0, 3)}
          </span>
          <strong>{teamLabel}</strong>
          <small>utiliza {announcement.cardName}</small>
        </div>
      </div>
    </div>
  );
}

function streamTeamLabel(team: Team | undefined, teamId: string): string {
  if (!team) {
    return teamId;
  }

  return team.name || team.shortName;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
