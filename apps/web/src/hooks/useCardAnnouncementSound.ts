import { useCallback, useEffect, useRef, useState } from 'react';

const CARD_REVEAL_SOUND_URL = '/sounds/card-reveal.mp3';

export function useCardAnnouncementSound({
  announcementId,
  enabled,
  volume,
}: {
  announcementId: string | null;
  enabled: boolean;
  volume: number;
}): {
  blocked: boolean;
  unlock: () => void;
} {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const lastSeenAnnouncementIdRef = useRef<string | null>(null);
  const pendingAnnouncementIdRef = useRef<string | null>(null);
  const volumeRef = useRef(volume);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const audio = new Audio(CARD_REVEAL_SOUND_URL);
    audio.preload = 'auto';
    audio.volume = clampVolume(volume);
    audioRef.current = audio;

    return () => {
      audio.pause();
      audioRef.current = null;
    };
  }, []);

  useEffect(() => {
    volumeRef.current = volume;

    if (audioRef.current) {
      audioRef.current.volume = clampVolume(volume);
    }
  }, [volume]);

  const playSound = useCallback((nextAnnouncementId: string): void => {
    const audio = audioRef.current ?? new Audio(CARD_REVEAL_SOUND_URL);
    audioRef.current = audio;
    audio.volume = clampVolume(volumeRef.current);
    audio.currentTime = 0;

    void audio.play()
      .then(() => {
        pendingAnnouncementIdRef.current = null;
        setBlocked(false);
      })
      .catch(() => {
        pendingAnnouncementIdRef.current = nextAnnouncementId;
        setBlocked(true);
      });
  }, []);

  useEffect(() => {
    if (!announcementId) {
      lastSeenAnnouncementIdRef.current = null;
      pendingAnnouncementIdRef.current = null;
      setBlocked(false);
      return;
    }

    if (lastSeenAnnouncementIdRef.current === announcementId) {
      return;
    }

    lastSeenAnnouncementIdRef.current = announcementId;

    if (!enabled) {
      pendingAnnouncementIdRef.current = null;
      setBlocked(false);
      return;
    }

    playSound(announcementId);
  }, [announcementId, enabled, playSound]);

  const unlock = useCallback(() => {
    const pendingAnnouncementId = pendingAnnouncementIdRef.current ?? announcementId;

    if (!enabled || !pendingAnnouncementId) {
      setBlocked(false);
      return;
    }

    playSound(pendingAnnouncementId);
  }, [announcementId, enabled, playSound]);

  return { blocked, unlock };
}

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) {
    return 0.55;
  }

  return Math.min(1, Math.max(0, value));
}
