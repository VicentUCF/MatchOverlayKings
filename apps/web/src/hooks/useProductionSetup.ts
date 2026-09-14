import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createProductionProvisioningAdapter } from '../lib/production-provisioning-adapter.js';
import { createProductionSetupInventoryAdapter } from '../lib/production-setup-inventory.js';
import { createProductionSetupDraft, runProductionSetup } from '../lib/production-setup-orchestrator.js';
import type {
  ProductionSetupDraft,
  ProductionSetupWorkspaceState,
  SetupCourtDraft,
} from '../lib/production-setup-types.js';

const inventoryAdapter = createProductionSetupInventoryAdapter();
const provisioningAdapter = createProductionProvisioningAdapter();

type SharedDraftField = 'eventDayName' | 'eventDate' | 'timeZone' | 'agentAuthUserId';
type CourtDraftField = 'captureAuthUserId' | 'captureRef' | 'outputRef' | 'title'
  | 'scheduledStartAt' | 'scheduledEndAt';

export type ProductionSetupController = {
  readonly state: ProductionSetupWorkspaceState;
  readonly updateShared: (field: SharedDraftField, value: string) => void;
  readonly updateCourt: (slug: SetupCourtDraft['slug'], field: CourtDraftField, value: string) => void;
  readonly refresh: () => Promise<void>;
  readonly submit: () => Promise<void>;
};

type ProductionSetupInFlight = {
  current: Promise<void> | null;
};

export function submitProductionSetupOnce(
  inFlight: ProductionSetupInFlight,
  submit: () => Promise<void>,
): Promise<void> {
  if (inFlight.current !== null) return inFlight.current;
  const pending = submit().finally(() => {
    if (inFlight.current === pending) inFlight.current = null;
  });
  inFlight.current = pending;
  return pending;
}

export function useProductionSetup(clubId: string): ProductionSetupController {
  const [state, setState] = useState<ProductionSetupWorkspaceState>({ kind: 'loading' });
  const inFlight = useRef<Promise<void> | null>(null);
  const load = useCallback(() => inventoryAdapter.load(clubId), [clubId]);

  useEffect(() => {
    let active = true;
    setState({ kind: 'loading' });
    void load().then((result) => {
      if (!active) return;
      if (result.kind === 'success') {
        setState({
          kind: 'ready', inventory: result.inventory,
          draft: createProductionSetupDraft(result.inventory, clubId), progress: null, dirty: false,
        });
      } else if (result.kind === 'forbidden') {
        setState({ kind: 'forbidden' });
      } else {
        setState({ kind: 'error', error: result.kind });
      }
    });
    return () => { active = false; };
  }, [clubId, load]);

  const updateDraft = useCallback((update: (draft: ProductionSetupDraft) => ProductionSetupDraft) => {
    setState((current) => current.kind === 'ready'
      ? { ...current, draft: update(current.draft), dirty: true, progress: null }
      : current);
  }, []);
  const updateShared = useCallback((field: SharedDraftField, value: string) => {
    updateDraft((draft) => ({ ...draft, [field]: value }));
  }, [updateDraft]);
  const updateCourt = useCallback((slug: SetupCourtDraft['slug'], field: CourtDraftField, value: string) => {
    updateDraft((draft) => ({
      ...draft,
      courts: draft.courts.map((court) => court.slug === slug ? { ...court, [field]: value } : court),
    }));
  }, [updateDraft]);

  const refresh = useCallback(async () => {
    const result = await load();
    setState((current) => {
      if (result.kind === 'success' && current.kind === 'ready') {
        return { ...current, inventory: result.inventory, progress: null };
      }
      if (result.kind === 'forbidden') return { kind: 'forbidden' };
      if (result.kind !== 'success') return { kind: 'error', error: result.kind };
      return current;
    });
  }, [load]);

  const submit = useCallback(() => {
    if (state.kind !== 'ready' || state.progress?.kind === 'pending') return Promise.resolve();
    return submitProductionSetupOnce(inFlight, async () => {
      const draft = state.draft;
      const result = await runProductionSetup({
        adapter: provisioningAdapter, draft, inventory: state.inventory, reload: load,
        onProgress: (progress) => setState((current) => current.kind === 'ready'
          ? { ...current, progress }
          : current),
      });
      setState((current) => current.kind === 'ready'
        ? {
            ...current, inventory: result.inventory, draft,
            progress: result.kind === 'complete' || result.kind === 'partial'
              ? current.progress
              : { unit: result.unit, kind: result.kind },
            dirty: result.kind !== 'complete',
          }
        : current);
    });
  }, [load, state]);

  return useMemo(() => ({ state, updateShared, updateCourt, refresh, submit }),
    [state, submit, updateCourt, updateShared, refresh]);
}
