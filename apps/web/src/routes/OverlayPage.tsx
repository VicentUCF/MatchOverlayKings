import { useCallback, useEffect, useRef, useState } from 'react';
import { createTimeline, stagger } from 'animejs';
import type { MatchSetScore, MatchState } from '@kpl/shared';
import { CardAnnouncementScene } from '../components/CardAnnouncementScene.js';
import { PrematchOverlayScene } from '../components/PrematchOverlayScene.js';
import { Scoreboard } from '../components/Scoreboard.js';
import { SideChangeScene } from '../components/SideChangeScene.js';
import { useCardAnnouncementQueue } from '../hooks/useCardAnnouncementQueue.js';
import { useMatchSocket } from '../hooks/useMatchSocket.js';

interface SideChangeSignal {
  key: string;
  setNumber: number;
  homeGames: number;
  awayGames: number;
  totalGames: number;
}

interface PrematchSceneState {
  state: MatchState;
  exiting: boolean;
}

interface SideChangeSceneState {
  signal: SideChangeSignal;
  state: MatchState;
}

export function OverlayPage({ eventId }: { eventId: string }) {
  const match = useMatchSocket(eventId, 'overlay', '');
  const overlayRef = useRef<HTMLDivElement>(null);
  const sideChangeBaselineVersionRef = useRef<number | null>(null);
  const lastSideChangeKeyRef = useRef<string | null>(null);
  const [activeSideChange, setActiveSideChange] = useState<SideChangeSceneState | null>(null);
  const [prematchScene, setPrematchScene] = useState<PrematchSceneState | null>(null);
  const settings = match.state?.overlaySettings;
  const shouldShowScoreboard = Boolean(match.state && match.state.status === 'live' && settings?.visible !== false);
  const announcement = match.state?.cards?.announcement ?? null;
  const { activeAnnouncement, completeAnnouncement } = useCardAnnouncementQueue(announcement, match.state?.status === 'live');
  const clearSideChange = useCallback(() => setActiveSideChange(null), []);
  const clearPrematchScene = useCallback(() => setPrematchScene(null), []);

  useEffect(() => {
    document.documentElement.classList.add('overlay-document');
    document.body.classList.add('overlay-body');

    return () => {
      document.documentElement.classList.remove('overlay-document');
      document.body.classList.remove('overlay-body');
    };
  }, []);

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
      setActiveSideChange({ signal, state: match.state });
    }
  }, [match.state]);

  useEffect(() => {
    if (!match.state) {
      setPrematchScene(null);
      return;
    }

    if (match.state.status === 'pre_match') {
      setPrematchScene({ state: match.state, exiting: false });
      return;
    }

    if (match.state.status === 'live') {
      setPrematchScene((current) => (current ? { ...current, exiting: true } : null));
      return;
    }

    setPrematchScene(null);
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
    const startScale = 0.96;
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
  }, [settings?.position, shouldShowScoreboard]);

  return (
    <main className="overlay-page">
      {shouldShowScoreboard && match.state ? (
        <div
          className="overlay-score-wrap"
          data-position={settings?.position ?? 'top-left'}
          ref={overlayRef}
        >
          <Scoreboard state={match.state} teams={match.teams} mode="overlay" />
        </div>
      ) : null}
      {activeAnnouncement ? (
        <CardAnnouncementScene
          announcement={activeAnnouncement}
          teams={match.teams}
          onDone={completeAnnouncement}
        />
      ) : null}
      {activeSideChange ? (
        <SideChangeScene
          signal={activeSideChange.signal}
          state={activeSideChange.state}
          teams={match.teams}
          onDone={clearSideChange}
        />
      ) : null}
      {prematchScene ? (
        <PrematchOverlayScene
          state={prematchScene.state}
          teams={match.teams}
          exiting={prematchScene.exiting}
          onExitComplete={clearPrematchScene}
        />
      ) : null}
      {match.state?.overlaySettings.visible === false ? <div className="overlay-blank" /> : null}
      {!match.state || match.state.status === 'finished' ? (
        <div className="overlay-loading">KPL</div>
      ) : null}
    </main>
  );
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
