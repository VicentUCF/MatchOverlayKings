import {
  DeviceSchema,
  OutputSchema,
  PrincipalSchema,
  ProductionAssignmentSchema,
  ProductionEventDaySchema,
  ProductionEventSchema,
} from '@kpl/production-contracts';
import { describe, expect, it } from 'vitest';
import type { ProductionProvisioningAdapter } from './production-provisioning-contracts.js';
import {
  ScheduleProductionEventInputSchema,
  UpsertMachinePrincipalInputSchema,
} from './production-provisioning-contracts.js';
import {
  createProductionSetupDraft,
  runProductionSetup,
  type ProductionSetupInventory,
} from './production-setup-orchestrator.js';

const IDS = {
  club: '10000000-0000-4000-8000-000000000001',
  courts: [
    '20000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000003',
    '20000000-0000-4000-8000-000000000004',
  ],
} as const;

function emptyInventory(): ProductionSetupInventory {
  return {
    eventDays: [], principals: [], devices: [], events: [], assignments: [], outputs: [],
    courts: [
      { id: IDS.courts[0], clubId: IDS.club, slug: 'pista-1', name: 'Pista 1', productionEnabled: true },
      { id: IDS.courts[1], clubId: IDS.club, slug: 'pista-2', name: 'Pista 2', productionEnabled: true },
      { id: IDS.courts[2], clubId: IDS.club, slug: 'pista-3', name: 'Pista 3', productionEnabled: true },
      { id: IDS.courts[3], clubId: IDS.club, slug: 'pista-4', name: 'Pista 4', productionEnabled: true },
    ],
  };
}

function validDraft() {
  let sequence = 0;
  const draft = createProductionSetupDraft(emptyInventory(), IDS.club, () =>
    `30000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`,
  );
  return {
    ...draft,
    eventDayName: 'Jornada KPL', eventDate: '2026-09-14', timeZone: 'Europe/Madrid',
    agentAuthUserId: '40000000-0000-4000-8000-000000000001',
    courts: draft.courts.map((court, index) => ({
      ...court,
      captureAuthUserId: `50000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
      captureRef: `local://capture/pista-${index + 1}`,
      outputRef: `local://output/pista-${index + 1}`,
      title: `Partido pista ${index + 1}`,
      scheduledStartAt: `2026-09-14T${String(10 + index).padStart(2, '0')}:00`,
      scheduledEndAt: `2026-09-14T${String(11 + index).padStart(2, '0')}:00`,
    })),
  };
}

function stoppingAdapter(calls: string[]): ProductionProvisioningAdapter {
  return {
    upsertEventDay: async () => {
      calls.push('event-day');
      return { kind: 'accepted', value: ProductionEventDaySchema.parse({
        id: '30000000-0000-4000-8000-000000000001', clubId: IDS.club, name: 'Jornada KPL',
        eventDate: '2026-09-14', timeZone: 'Europe/Madrid', status: 'active', version: 1,
      }) };
    },
    upsertMachinePrincipal: async () => {
      calls.push('principal');
      return { kind: 'transport' };
    },
    upsertDevice: async () => ({ kind: 'accepted', value: DeviceSchema.parse({
      id: '60000000-0000-4000-8000-000000000001', clubId: IDS.club,
      principalId: '70000000-0000-4000-8000-000000000001', name: 'Captura', kind: 'camera',
      enabled: true, lastHeartbeatAt: null, version: 1,
    }) }),
    scheduleEvent: async () => ({ kind: 'accepted', value: ProductionEventSchema.parse({
      id: '80000000-0000-4000-8000-000000000001', eventDayId: '30000000-0000-4000-8000-000000000001',
      clubId: IDS.club, courtId: IDS.courts[0], title: 'Partido',
      scheduledStartAt: '2026-09-14T10:00:00.000Z', scheduledEndAt: '2026-09-14T11:00:00.000Z',
      status: 'scheduled', version: 1,
    }) }),
    upsertAssignment: async () => ({ kind: 'accepted', value: ProductionAssignmentSchema.parse({
      id: '90000000-0000-4000-8000-000000000001', eventId: '80000000-0000-4000-8000-000000000001',
      principalId: '70000000-0000-4000-8000-000000000001', role: 'agent', active: true, version: 1,
    }) }),
    upsertOutput: async () => ({ kind: 'accepted', value: OutputSchema.parse({
      id: 'a0000000-0000-4000-8000-000000000001', eventId: '80000000-0000-4000-8000-000000000001',
      clubId: IDS.club, courtId: IDS.courts[0], name: 'Programa', kind: 'program', transport: 'srt',
      enabled: true, version: 1,
    }) }),
    setEventStatus: async () => ({ kind: 'accepted', value: ProductionEventSchema.parse({
      id: '80000000-0000-4000-8000-000000000001', eventDayId: '30000000-0000-4000-8000-000000000001',
      clubId: IDS.club, courtId: IDS.courts[0], title: 'Partido',
      scheduledStartAt: '2026-09-14T10:00:00.000Z', scheduledEndAt: '2026-09-14T11:00:00.000Z',
      status: 'ready', version: 2,
    }) }),
  };
}

describe('production setup orchestration', () => {
  it('retains accepted progress and stops at the first non-accepted server result', async () => {
    const calls: string[] = [];
    const progress: string[] = [];

    const result = await runProductionSetup({
      adapter: stoppingAdapter(calls), draft: validDraft(), inventory: emptyInventory(),
      reload: async () => ({ kind: 'success', inventory: emptyInventory() }),
      onProgress: (update) => progress.push(`${update.unit}:${update.kind}`),
    });

    expect(calls).toEqual(['event-day', 'principal']);
    expect(progress).toEqual(['shared:pending', 'shared:accepted', 'shared:pending', 'shared:transport']);
    expect(result.kind).toBe('transport');
  });

  it('preserves generated identifiers when a missing record is retried', async () => {
    const draft = validDraft();
    const eventDayIds: unknown[] = [];
    const baseAdapter = stoppingAdapter([]);
    const adapter: ProductionProvisioningAdapter = {
      ...baseAdapter,
      upsertEventDay: async (input) => {
        eventDayIds.push(input);
        return { kind: 'transport' };
      },
    };

    const request = {
      adapter, draft, inventory: emptyInventory(),
      reload: async () => ({ kind: 'success', inventory: emptyInventory() } as const),
      onProgress: () => undefined,
    };
    await runProductionSetup(request);
    await runProductionSetup(request);

    expect(eventDayIds).toEqual([expect.objectContaining({ eventDayId: draft.eventDayId }), expect.objectContaining({ eventDayId: draft.eventDayId })]);
  });

  it('schedules local court times in the event-day time zone', async () => {
    const scheduleInputs: unknown[] = [];
    const baseAdapter = stoppingAdapter([]);
    const adapter: ProductionProvisioningAdapter = {
      ...baseAdapter,
      upsertMachinePrincipal: async (input) => {
        const value = UpsertMachinePrincipalInputSchema.parse(input);
        return { kind: 'accepted', value: PrincipalSchema.parse({
          id: value.principalId, clubId: value.clubId, kind: value.kind,
          displayName: value.displayName, active: value.active, version: 1,
        }) };
      },
      scheduleEvent: async (input) => {
        scheduleInputs.push(ScheduleProductionEventInputSchema.parse(input));
        return baseAdapter.scheduleEvent(input);
      },
    };

    await runProductionSetup({
      adapter, draft: validDraft(), inventory: emptyInventory(),
      reload: async () => ({ kind: 'success', inventory: emptyInventory() }),
      onProgress: () => undefined,
    });

    expect(scheduleInputs[0]).toEqual(expect.objectContaining({
      scheduledStartAt: '2026-09-14T08:00:00.000Z',
      scheduledEndAt: '2026-09-14T09:00:00.000Z',
    }));
  });
});
