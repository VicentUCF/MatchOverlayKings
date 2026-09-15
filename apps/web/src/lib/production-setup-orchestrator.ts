import type { ProductionProvisioningAdapter, ProductionProvisioningResult } from './production-provisioning-contracts.js';
import type { ProductionCourtSlug } from './production-overview-types.js';
import type {
  ProductionSetupCompletion,
  ProductionSetupDraft,
  ProductionSetupInventory,
  ProductionSetupInventoryLoadResult,
  ProductionSetupRunResult,
  SetupCourtDraft,
  SetupOperationProgress,
  SetupUnit,
} from './production-setup-types.js';

export type {
  ProductionSetupDraft,
  ProductionSetupInventory,
  ProductionSetupInventoryLoadResult,
  ProductionSetupRunResult,
  SetupOperationProgress,
} from './production-setup-types.js';

const SHARED_AGENT_NAME = 'Agente local compartido';
const TOTAL_COURT_PARTS = 7 as const;

type SetupRequest = {
  readonly adapter: ProductionProvisioningAdapter;
  readonly draft: ProductionSetupDraft;
  readonly inventory: ProductionSetupInventory;
  readonly reload: () => Promise<ProductionSetupInventoryLoadResult>;
  readonly onProgress: (progress: SetupOperationProgress) => void;
};

type PlannedOperation = {
  readonly unit: SetupUnit;
  readonly execute: () => Promise<ProductionProvisioningResult<unknown>>;
};

export function createProductionSetupDraft(
  inventory: ProductionSetupInventory,
  clubId: string,
  createId: () => string = () => crypto.randomUUID(),
): ProductionSetupDraft {
  const eventDay = inventory.eventDays.find(({ status }) => status === 'active');
  const agent = inventory.principals.find(({ kind, active }) => kind === 'agent' && active);
  return {
    clubId,
    eventDayId: eventDay?.id ?? createId(),
    eventDayName: eventDay?.name ?? '',
    eventDate: eventDay?.eventDate ?? '',
    timeZone: eventDay?.timeZone ?? 'Europe/Madrid',
    agentPrincipalId: agent?.id ?? createId(),
    agentAuthUserId: agent?.authUserId ?? '',
    courts: inventory.courts.filter(({ productionEnabled }) => productionEnabled)
      .map(({ slug }) => courtDraft(inventory, eventDay?.id, agent?.id, slug, createId)),
  };
}

export function deriveProductionSetupCompletion(
  inventory: ProductionSetupInventory,
  draft: ProductionSetupDraft,
): ProductionSetupCompletion {
  const eventDay = inventory.eventDays.find(({ id, status }) => id === draft.eventDayId && status === 'active');
  const agent = inventory.principals.find(({ id, kind, active }) =>
    id === draft.agentPrincipalId && kind === 'agent' && active);
  const courts = draft.courts.map((court) => {
    const event = inventory.events.find(({ id, eventDayId }) => id === court.eventId && eventDayId === draft.eventDayId);
    const parts = [
      inventory.principals.some(({ id, kind, active }) => id === court.devicePrincipalId && kind === 'device' && active),
      inventory.devices.some(({ id, principalId, enabled }) => id === court.deviceId && principalId === court.devicePrincipalId && enabled),
      event !== undefined,
      inventory.assignments.some(({ id, eventId, principalId, role, active }) =>
        id === court.captureAssignmentId && eventId === court.eventId && principalId === court.devicePrincipalId && role === 'capture' && active),
      inventory.assignments.some(({ id, eventId, principalId, role, active }) =>
        id === court.agentAssignmentId && eventId === court.eventId && principalId === draft.agentPrincipalId && role === 'agent' && active),
      inventory.outputs.some(({ id, eventId, kind, transport, enabled }) =>
        id === court.outputId && eventId === court.eventId && kind === 'program' && transport === 'srt' && enabled),
      event?.status === 'ready' || event?.status === 'live',
    ];
    const acceptedParts = parts.filter(Boolean).length;
    return { slug: court.slug, acceptedParts, totalParts: TOTAL_COURT_PARTS, complete: acceptedParts === TOTAL_COURT_PARTS };
  });
  const completeCourts = courts.filter(({ complete }) => complete).length;
  const sharedComplete = eventDay !== undefined && agent !== undefined;
  return {
    sharedComplete,
    completeCourts,
    courts,
    complete: sharedComplete && courts.length > 0 && completeCourts === courts.length,
  };
}

export async function runProductionSetup(request: SetupRequest): Promise<ProductionSetupRunResult> {
  let current = request.inventory;
  const operations = planOperations(request, () => current);
  for (const operation of operations) {
    request.onProgress({ unit: operation.unit, kind: 'pending' });
    const result = await operation.execute();
    if (result.kind !== 'accepted') {
      request.onProgress({ unit: operation.unit, kind: result.kind });
      return { kind: result.kind, unit: operation.unit, inventory: current };
    }
    request.onProgress({ unit: operation.unit, kind: 'accepted' });
    const loaded = await request.reload();
    if (loaded.kind !== 'success') {
      request.onProgress({ unit: operation.unit, kind: loaded.kind });
      return { kind: loaded.kind, unit: operation.unit, inventory: current };
    }
    current = loaded.inventory;
  }
  return deriveProductionSetupCompletion(current, request.draft).complete
    ? { kind: 'complete', inventory: current }
    : { kind: 'partial', inventory: current };
}

function planOperations(request: SetupRequest, inventory: () => ProductionSetupInventory): PlannedOperation[] {
  const operations: PlannedOperation[] = [];
  const draft = request.draft;
  if (!inventory().eventDays.some(({ id, status }) => id === draft.eventDayId && status === 'active')) {
    operations.push({ unit: 'shared', execute: () => request.adapter.upsertEventDay({
      eventDayId: draft.eventDayId, clubId: draft.clubId, name: draft.eventDayName,
      eventDate: draft.eventDate, timeZone: draft.timeZone, status: 'active',
      expectedVersion: inventory().eventDays.find(({ id }) => id === draft.eventDayId)?.version ?? 0,
    }) });
  }
  if (!inventory().principals.some(({ id, kind, active }) => id === draft.agentPrincipalId && kind === 'agent' && active)) {
    operations.push({ unit: 'shared', execute: () => request.adapter.upsertMachinePrincipal({
      principalId: draft.agentPrincipalId, clubId: draft.clubId, authUserId: draft.agentAuthUserId,
      kind: 'agent', displayName: SHARED_AGENT_NAME, active: true,
      expectedVersion: inventory().principals.find(({ id }) => id === draft.agentPrincipalId)?.version ?? 0,
    }) });
  }
  for (const court of draft.courts) planDevicePrincipal(request, inventory, court, operations);
  for (const court of draft.courts) planDevice(request, inventory, court, operations);
  for (const court of draft.courts) planSchedule(request, inventory, court, operations);
  for (const court of draft.courts) planAssignments(request, inventory, court, operations);
  for (const court of draft.courts) planOutput(request, inventory, court, operations);
  for (const court of draft.courts) planStatus(request, inventory, court, operations);
  return operations;
}

function planDevicePrincipal(request: SetupRequest, inventory: () => ProductionSetupInventory, court: SetupCourtDraft, operations: PlannedOperation[]): void {
  if (inventory().principals.some(({ id, kind, active }) => id === court.devicePrincipalId && kind === 'device' && active)) return;
  operations.push({ unit: court.slug, execute: () => request.adapter.upsertMachinePrincipal({
    principalId: court.devicePrincipalId, clubId: request.draft.clubId, authUserId: court.captureAuthUserId,
    kind: 'device', displayName: `Captura ${court.slug}`, active: true,
    expectedVersion: inventory().principals.find(({ id }) => id === court.devicePrincipalId)?.version ?? 0,
  }) });
}

function planDevice(request: SetupRequest, inventory: () => ProductionSetupInventory, court: SetupCourtDraft, operations: PlannedOperation[]): void {
  if (inventory().devices.some(({ id, enabled }) => id === court.deviceId && enabled)) return;
  operations.push({ unit: court.slug, execute: () => request.adapter.upsertDevice({
    deviceId: court.deviceId, principalId: court.devicePrincipalId, name: `Captura ${court.slug}`,
    kind: 'camera', secretRef: court.captureRef, enabled: true,
    expectedVersion: inventory().devices.find(({ id }) => id === court.deviceId)?.version ?? 0,
  }) });
}

function planSchedule(request: SetupRequest, inventory: () => ProductionSetupInventory, court: SetupCourtDraft, operations: PlannedOperation[]): void {
  if (inventory().events.some(({ id }) => id === court.eventId)) return;
  operations.push({ unit: court.slug, execute: () => request.adapter.scheduleEvent({
    eventId: court.eventId, eventDayId: request.draft.eventDayId, courtSlug: court.slug, title: court.title,
    scheduledStartAt: localTimestamp(court.scheduledStartAt, request.draft.timeZone),
    scheduledEndAt: localTimestamp(court.scheduledEndAt, request.draft.timeZone),
    expectedVersion: inventory().events.find(({ id }) => id === court.eventId)?.version ?? 0,
  }) });
}

function planAssignments(request: SetupRequest, inventory: () => ProductionSetupInventory, court: SetupCourtDraft, operations: PlannedOperation[]): void {
  const assignments = [
    { id: court.captureAssignmentId, principalId: court.devicePrincipalId, role: 'capture' },
    { id: court.agentAssignmentId, principalId: request.draft.agentPrincipalId, role: 'agent' },
  ] as const;
  for (const assignment of assignments) {
    if (inventory().assignments.some(({ id, active }) => id === assignment.id && active)) continue;
    operations.push({ unit: court.slug, execute: () => request.adapter.upsertAssignment({
      assignmentId: assignment.id, eventId: court.eventId, principalId: assignment.principalId,
      role: assignment.role, active: true,
      expectedVersion: inventory().assignments.find(({ id }) => id === assignment.id)?.version ?? 0,
    }) });
  }
}

function planOutput(request: SetupRequest, inventory: () => ProductionSetupInventory, court: SetupCourtDraft, operations: PlannedOperation[]): void {
  if (inventory().outputs.some(({ id, enabled }) => id === court.outputId && enabled)) return;
  operations.push({ unit: court.slug, execute: () => request.adapter.upsertOutput({
    outputId: court.outputId, eventId: court.eventId, name: `Programa ${court.slug}`,
    kind: 'program', transport: 'srt', secretRef: court.outputRef, enabled: true,
    expectedVersion: inventory().outputs.find(({ id }) => id === court.outputId)?.version ?? 0,
  }) });
}

function planStatus(request: SetupRequest, inventory: () => ProductionSetupInventory, court: SetupCourtDraft, operations: PlannedOperation[]): void {
  const event = inventory().events.find(({ id }) => id === court.eventId);
  if (event?.status === 'ready' || event?.status === 'live') return;
  operations.push({ unit: court.slug, execute: () => request.adapter.setEventStatus({
    eventId: court.eventId, status: 'ready',
    expectedVersion: inventory().events.find(({ id }) => id === court.eventId)?.version ?? 0,
  }) });
}

function courtDraft(
  inventory: ProductionSetupInventory,
  eventDayId: string | undefined,
  agentId: string | undefined,
  slug: ProductionCourtSlug,
  createId: () => string,
): SetupCourtDraft {
  const court = inventory.courts.find((candidate) => candidate.slug === slug);
  const event = inventory.events.find((candidate) => candidate.courtId === court?.id && candidate.eventDayId === eventDayId);
  const capture = inventory.assignments.find(({ eventId, role, active }) => eventId === event?.id && role === 'capture' && active);
  const namedPrincipal = inventory.principals.find(({ displayName, kind }) => displayName === `Captura ${slug}` && kind === 'device');
  const devicePrincipal = inventory.principals.find(({ id }) => id === capture?.principalId) ?? namedPrincipal;
  const device = inventory.devices.find(({ principalId }) => principalId === devicePrincipal?.id);
  const agentAssignment = inventory.assignments.find(({ eventId, principalId, role, active }) =>
    eventId === event?.id && principalId === agentId && role === 'agent' && active);
  const output = inventory.outputs.find(({ eventId, kind, transport }) => eventId === event?.id && kind === 'program' && transport === 'srt');
  return {
    slug, devicePrincipalId: devicePrincipal?.id ?? createId(), deviceId: device?.id ?? createId(),
    eventId: event?.id ?? createId(), captureAssignmentId: capture?.id ?? createId(),
    agentAssignmentId: agentAssignment?.id ?? createId(), outputId: output?.id ?? createId(),
    captureAuthUserId: devicePrincipal?.authUserId ?? '', captureRef: '', outputRef: '',
    title: event?.title ?? '', scheduledStartAt: event ? toLocalInput(event.scheduledStartAt) : '',
    scheduledEndAt: event ? toLocalInput(event.scheduledEndAt) : '',
  };
}

function localTimestamp(value: string, timeZone: string): string {
  const parts = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (parts === null) return value;
  const numbers = parts.slice(1).map(Number);
  const utcGuess = Date.UTC(numbers[0] ?? 0, (numbers[1] ?? 1) - 1, numbers[2] ?? 1, numbers[3] ?? 0, numbers[4] ?? 0);
  try {
    const zonedParts = new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(utcGuess));
    const valueFor = (type: Intl.DateTimeFormatPartTypes) => Number(zonedParts.find((part) => part.type === type)?.value ?? 0);
    const representedUtc = Date.UTC(valueFor('year'), valueFor('month') - 1, valueFor('day'), valueFor('hour'), valueFor('minute'));
    return new Date(utcGuess - (representedUtc - utcGuess)).toISOString();
  } catch {
    return value;
  }
}

function toLocalInput(value: string): string {
  return value.slice(0, 16);
}
