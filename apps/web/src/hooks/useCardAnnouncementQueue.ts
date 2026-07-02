import { useCallback, useEffect, useRef, useState } from 'react';
import type { MatchCardAnnouncement } from '@kpl/shared';

export function useCardAnnouncementQueue(
  announcement: MatchCardAnnouncement | null,
  isLive: boolean,
): {
  activeAnnouncement: MatchCardAnnouncement | null;
  completeAnnouncement: () => void;
  queuedCount: number;
} {
  const announcementReadyRef = useRef(false);
  const lastAnnouncementIdRef = useRef<string | null>(null);
  const activeAnnouncementRef = useRef<MatchCardAnnouncement | null>(null);
  const [activeAnnouncement, setActiveAnnouncement] = useState<MatchCardAnnouncement | null>(null);
  const [queuedAnnouncements, setQueuedAnnouncements] = useState<MatchCardAnnouncement[]>([]);

  useEffect(() => {
    activeAnnouncementRef.current = activeAnnouncement;
  }, [activeAnnouncement]);

  useEffect(() => {
    if (!isLive) {
      announcementReadyRef.current = false;
      lastAnnouncementIdRef.current = null;
      setActiveAnnouncement(null);
      setQueuedAnnouncements([]);
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

    if (!activeAnnouncementRef.current) {
      setActiveAnnouncement(announcement);
      return;
    }

    setQueuedAnnouncements((current) => {
      if (current.some((item) => item.id === announcement.id)) {
        return current;
      }

      return [...current, announcement];
    });
  }, [announcement, isLive]);

  useEffect(() => {
    if (activeAnnouncement || queuedAnnouncements.length === 0) {
      return;
    }

    const [nextAnnouncement, ...remainingAnnouncements] = queuedAnnouncements;
    setQueuedAnnouncements(remainingAnnouncements);
    setActiveAnnouncement(nextAnnouncement ?? null);
  }, [activeAnnouncement, queuedAnnouncements]);

  const completeAnnouncement = useCallback(() => {
    setActiveAnnouncement(null);
  }, []);

  return {
    activeAnnouncement,
    completeAnnouncement,
    queuedCount: queuedAnnouncements.length,
  };
}
