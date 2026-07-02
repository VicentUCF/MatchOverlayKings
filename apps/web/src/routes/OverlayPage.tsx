import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { animate, createTimeline, stagger } from 'animejs';
import type { MatchCardAnnouncement, MatchSetScore, MatchState, Team } from '@kpl/shared';
import { Scoreboard } from '../components/Scoreboard.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';
import { findMatchCard } from '../lib/match-cards.js';

interface SideChangeSignal {
  key: string;
  setNumber: number;
  homeGames: number;
  awayGames: number;
  totalGames: number;
}

export function OverlayPage({ eventId }: { eventId: string }) {
  const match = useMatchSocket(eventId, 'overlay', '');
  const overlayRef = useRef<HTMLDivElement>(null);
  const announcementReadyRef = useRef(false);
  const lastAnnouncementIdRef = useRef<string | null>(null);
  const sideChangeBaselineVersionRef = useRef<number | null>(null);
  const lastSideChangeKeyRef = useRef<string | null>(null);
  const [activeCard, setActiveCard] = useState<MatchCardAnnouncement | null>(null);
  const [activeSideChange, setActiveSideChange] = useState<SideChangeSignal | null>(null);
  const settings = match.state?.overlaySettings;
  const shouldShowScoreboard = Boolean(match.state && match.state.status === 'live' && settings?.visible !== false);
  const announcement = match.state?.cards?.announcement ?? null;
  const clearActiveCard = useCallback(() => setActiveCard(null), []);
  const clearSideChange = useCallback(() => setActiveSideChange(null), []);

  useEffect(() => {
    if (match.state?.status !== 'live') {
      return;
    }

    if (!announcement) {
      announcementReadyRef.current = true;
      lastAnnouncementIdRef.current = null;
      return;
    }

    if (!announcementReadyRef.current) {
      announcementReadyRef.current = true;
      lastAnnouncementIdRef.current = announcement.id;
      return;
    }

    if (lastAnnouncementIdRef.current === announcement.id) {
      return;
    }

    lastAnnouncementIdRef.current = announcement.id;
    setActiveCard(announcement);
  }, [announcement, match.state?.status]);

  useEffect(() => {
    if (!match.state) {
      return;
    }

    const signal = getSideChangeSignal(match.state);
    const nextKey = signal?.key ?? null;

    if (sideChangeBaselineVersionRef.current === null) {
      sideChangeBaselineVersionRef.current = match.state.version;
      lastSideChangeKeyRef.current = nextKey;
      return;
    }

    if (match.state.version <= sideChangeBaselineVersionRef.current) {
      lastSideChangeKeyRef.current = nextKey;
      return;
    }

    if (!signal || nextKey === lastSideChangeKeyRef.current) {
      return;
    }

    lastSideChangeKeyRef.current = nextKey;

    if (signal.totalGames % 2 === 1) {
      setActiveSideChange(signal);
    }
  }, [match.state]);

  useEffect(() => {
    if (!shouldShowScoreboard || !overlayRef.current || prefersReducedMotion()) {
      return undefined;
    }

    const scoreboard = overlayRef.current.querySelector('.scoreboard');

    if (!scoreboard) {
      return undefined;
    }

    const enterX = settings?.position === 'top-left' ? -120 : 0;
    const enterY = settings?.position === 'bottom-center' ? 80 : settings?.position === 'center' ? 36 : -24;
    const startScale = settings?.size === 'large' ? 0.92 : 0.96;
    const timeline = createTimeline({
      defaults: {
        ease: 'outExpo',
      },
    });

    timeline
      .set(scoreboard, {
        opacity: 0,
        translateX: enterX,
        translateY: enterY,
        scale: startScale,
      })
      .add(scoreboard, {
        opacity: [0, 1],
        translateX: [enterX, 0],
        translateY: [enterY, 0],
        scale: [startScale, 1],
        duration: 540,
      })
      .add(
        scoreboard.querySelectorAll('.scoreboard-header, .score-grid-head, .set-strip'),
        {
          opacity: [0, 1],
          translateY: [20, 0],
          duration: 380,
          delay: stagger(48),
        },
        '-=310',
      )
      .add(
        scoreboard.querySelectorAll('.team-logo, .team-identity, .score-number, .point-number, .status-badge'),
        {
          opacity: [0, 1],
          scale: [0.76, 1],
          duration: 380,
          delay: stagger(44, { from: 'center' }),
        },
        '-=280',
      );

    return () => {
      timeline.revert();
    };
  }, [settings?.position, settings?.size, shouldShowScoreboard]);

  return (
    <main className="overlay-page">
      {shouldShowScoreboard && match.state ? (
        <div
          className="overlay-score-wrap"
          data-position={settings?.position ?? 'top-left'}
          data-size={settings?.size ?? 'standard'}
          ref={overlayRef}
        >
          <Scoreboard state={match.state} teams={match.teams} mode="overlay" />
        </div>
      ) : null}
      {activeCard ? (
        <MatchCardAnnouncementOverlay
          announcement={activeCard}
          teams={match.teams}
          onDone={clearActiveCard}
        />
      ) : null}
      {activeSideChange ? (
        <SideChangeOverlay signal={activeSideChange} onDone={clearSideChange} />
      ) : null}
      {match.state?.overlaySettings.visible === false ? <div className="overlay-blank" /> : null}
      {!match.state || match.state.status !== 'live' ? (
        <div className="overlay-loading">KPL</div>
      ) : null}
    </main>
  );
}

function SideChangeOverlay({ signal, onDone }: { signal: SideChangeSignal; onDone: () => void }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!ref.current) {
      return undefined;
    }

    if (prefersReducedMotion()) {
      const timeoutId = window.setTimeout(onDone, 3_800);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    const badge = ref.current.querySelector('.side-change-badge');
    const panelAnimation = animate(ref.current, {
      opacity: [{ from: 0, to: 1 }],
      duration: 140,
      ease: 'outCubic',
    });
    const badgeAnimation = badge
      ? animate(badge, {
          opacity: [{ from: 0, to: 1 }],
          scale: [{ from: 0.7, to: 1 }],
          y: [{ from: 30, to: 0 }],
          duration: 520,
          ease: 'outBack(1.45)',
        })
      : null;
    const outTimer = window.setTimeout(() => {
      if (!ref.current) {
        onDone();
        return;
      }

      animate(ref.current, {
        opacity: [{ from: 1, to: 0 }],
        y: [{ from: 0, to: -18 }],
        duration: 320,
        ease: 'inCubic',
        onComplete: onDone,
      });
    }, 3_600);

    return () => {
      window.clearTimeout(outTimer);
      panelAnimation.revert();
      badgeAnimation?.revert();
    };
  }, [onDone]);

  return (
    <div className="side-change-announcement" ref={ref}>
      <div className="side-change-badge">
        <span>CAMBIO DE LADO</span>
        <strong>{signal.homeGames}-{signal.awayGames}</strong>
        <small>Set {signal.setNumber}</small>
      </div>
    </div>
  );
}

function MatchCardAnnouncementOverlay({
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
  const teamStyle = {
    '--team-color': team?.primaryColor ?? '#ff2c78',
  } as CSSProperties;

  useEffect(() => {
    if (!ref.current) {
      return undefined;
    }

    if (prefersReducedMotion()) {
      const timeoutId = window.setTimeout(onDone, 5_500);

      return () => {
        window.clearTimeout(timeoutId);
      };
    }

    const cardImage = ref.current.querySelector('.stream-card-image');
    const caption = ref.current.querySelector('.stream-card-caption');
    const panelAnimation = animate(ref.current, {
      opacity: [{ from: 0, to: 1 }],
      duration: 160,
      ease: 'outCubic',
    });
    const imageAnimation = cardImage
      ? animate(cardImage, {
          opacity: [{ from: 0, to: 1 }],
          scale: [{ from: 0.62, to: 1 }],
          rotate: [{ from: -8, to: 0 }],
          y: [{ from: 80, to: 0 }],
          duration: 720,
          ease: 'outBack(1.55)',
        })
      : null;
    const captionAnimation = caption
      ? animate(caption, {
          opacity: [{ from: 0, to: 1 }],
          y: [{ from: 18, to: 0 }],
          delay: 240,
          duration: 360,
          ease: 'outCubic',
        })
      : null;
    const outTimer = window.setTimeout(() => {
      if (!ref.current) {
        onDone();
        return;
      }

      animate(ref.current, {
        opacity: [{ from: 1, to: 0 }],
        scale: [{ from: 1, to: 0.94 }],
        y: [{ from: 0, to: -28 }],
        duration: 420,
        ease: 'inCubic',
        onComplete: onDone,
      });
    }, 5_700);

    return () => {
      window.clearTimeout(outTimer);
      panelAnimation.revert();
      imageAnimation?.revert();
      captionAnimation?.revert();
    };
  }, [onDone]);

  if (!card) {
    return null;
  }

  return (
    <div className="stream-card-announcement" ref={ref}>
      <div className="stream-card-caption" style={teamStyle}>
        <span className="stream-card-team-logo">
          {team?.logoUrl ? <img src={team.logoUrl} alt="" /> : streamTeamLabel(team, announcement.teamId).slice(0, 3)}
        </span>
        <strong>{streamTeamLabel(team, announcement.teamId)}</strong>
        <span>utiliza {announcement.cardName}</span>
      </div>
      <img className="stream-card-image" src={card.imageUrl} alt="" />
    </div>
  );
}

function streamTeamLabel(team: Team | undefined, teamId: string): string {
  if (team?.id === 'kings-of-favar') {
    return 'KOF';
  }

  if (!team) {
    return teamId;
  }

  const initials = team.name
    .split(/\s+/)
    .filter((part) => part.toLowerCase() !== 'of')
    .map((part) => part[0])
    .join('')
    .toUpperCase();

  return initials || team.shortName;
}

function getSideChangeSignal(state: MatchState): SideChangeSignal | null {
  if (state.status !== 'live' && state.status !== 'finished') {
    return null;
  }

  const candidate = getSideChangeCandidateSet(state.sets);

  if (!candidate) {
    return null;
  }

  const totalGames = candidate.set.homeGames + candidate.set.awayGames;

  if (totalGames <= 0) {
    return null;
  }

  return {
    key: `${state.id}:set-${candidate.index + 1}:${candidate.set.homeGames}-${candidate.set.awayGames}:${candidate.set.status}`,
    setNumber: candidate.index + 1,
    homeGames: candidate.set.homeGames,
    awayGames: candidate.set.awayGames,
    totalGames,
  };
}

function getSideChangeCandidateSet(sets: MatchSetScore[]): { set: MatchSetScore; index: number } | null {
  const lastIndex = sets.length - 1;
  const lastSet = sets[lastIndex];

  if (!lastSet) {
    return null;
  }

  if (lastSet.status === 'complete' || lastSet.homeGames + lastSet.awayGames > 0) {
    return { set: lastSet, index: lastIndex };
  }

  const previousSet = sets[lastIndex - 1];

  if (previousSet?.status === 'complete') {
    return { set: previousSet, index: lastIndex - 1 };
  }

  return { set: lastSet, index: lastIndex };
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
