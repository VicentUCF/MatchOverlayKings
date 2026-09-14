export { fingerprintProfile } from './fingerprint.js';
export {
  FfmpegProgressError,
  FfmpegProgressParser,
  type FfmpegProgressErrorCode,
  type FfmpegProgressRecord,
} from './ffmpeg-progress.js';
export {
  FfmpegHealthError,
  FfmpegHealthTracker,
  type FfmpegHealth,
  type FfmpegHealthErrorCode,
} from './ffmpeg-health.js';
export { FfmpegCourtPipeline } from './ffmpeg-court-pipeline.js';
export {
  FfmpegCourtPipelineError,
  type FfmpegCourtPipelineErrorCode,
  type FfmpegCourtPipelineLifecycle,
  type FfmpegCourtPipelineOptions,
} from './ffmpeg-court-pipeline-model.js';
export {
  NodeProcessSpawner,
  ProcessAdapterError,
  type ManagedProcessPort,
  type ManagedProcessStatus,
  type ProcessAdapterErrorCode,
  type ProcessCloseStatus,
  type ProcessDiagnostics,
  type ProcessSignal,
  type ProcessSignalResult,
  type ProcessSpawnerPort,
} from './managed-process.js';
export {
  ProgressStreamError,
  type ProgressStreamErrorCode,
} from './progress-queue.js';
export {
  NodeScheduler,
  ProcessStopError,
  stopFfmpeg,
  stopMediaMtx,
  type ProcessStopErrorCode,
  type SchedulerPort,
  type StopProcessOptions,
} from './process-stop.js';
export { buildFfmpegCommandPlan, type FfmpegPlanInput } from './ffmpeg-plan.js';
export { buildMediaMtxPlan, type MediaMtxPlan } from './mediamtx-plan.js';
export {
  MediaMtxApiClient,
  MediaMtxApiClientError,
  MediaMtxApiClientFactory,
  type MediaMtxApiClientConfig,
  type MediaMtxApiClientErrorCode,
  type MediaMtxApiClientFactoryPort,
  type MediaMtxApiClientPort,
  type MediaMtxPathsSnapshot,
  type MediaMtxPathStatus,
} from './mediamtx-api-client.js';
export {
  createMediaMtxApiCredentials,
  MediaMtxApiCredentialFactory,
  MediaMtxApiCredentialsError,
  type MediaMtxApiCredentialFactoryPort,
  type MediaMtxApiCredentials,
  type MediaMtxApiCredentialsErrorCode,
  type MediaMtxApiPlannerCredentials,
  type RandomBytesPort,
} from './mediamtx-api-credentials.js';
export {
  EphemeralRuntimeFilesError,
  isEphemeralRuntimeCleanupRecovery,
  NodeEphemeralRuntimeFiles,
  type EphemeralRuntimeArtifact,
  type EphemeralRuntimeCleanupRecovery,
  type EphemeralRuntimeFilesErrorCode,
  type EphemeralRuntimeFilesOptions,
  type EphemeralRuntimeFilesPort,
} from './ephemeral-runtime-files.js';
export {
  MediaMtxReadinessError,
  waitForMediaMtxReadiness,
  type MediaMtxReadinessErrorCode,
  type MediaMtxReadinessOptions,
} from './mediamtx-readiness.js';
export {
  MediaMtxService,
  MediaMtxServiceError,
  type MediaMtxServiceErrorCode,
  type MediaMtxServiceOptions,
  type MediaMtxServiceStatus,
} from './mediamtx-service.js';
export {
  AlsaAudioDescriptorSchema,
  LocalMediaBindingsSchema,
  LocalMediaRuntimeConfigSchema,
  LocalSrtProgramSinkSchema,
  OverlayInputDescriptorSchema,
  V4l2VideoDescriptorSchema,
  type AlsaAudioDescriptor,
  type LocalMediaRuntimeConfig,
  type LocalSrtProgramSink,
  type OverlayInputDescriptor,
  type V4l2VideoDescriptor,
} from './media-runtime-config.js';
export type { ProcessCommandPlan, ProcessStdioPlan } from './process-command-plan.js';
export {
  AgentLoggerError,
  JsonLineLogger,
  type AgentLogEvent,
  type AgentLogFields,
  type AgentLogLevel,
  type AgentLogger,
  type JsonLineLoggerOptions,
} from './agent-logger.js';
export {
  AgentConfigSchema,
  CourtSnapshotSchema,
  CourtWorkerConfigSchema,
  SupervisorSnapshotsSchema,
  type AgentConfig,
  type CourtSnapshot,
  type CourtWorkerConfig,
  type SupervisorSnapshots,
} from './config.js';
export { CourtWorker } from './court-worker.js';
export {
  LocalAgentRuntimeConfigError,
  LocalAgentRuntimeConfigSchema,
  parseLocalAgentEnvironment,
  type LocalAgentRuntimeConfig,
  type RuntimeCredential,
} from './local-runtime-config.js';
export {
  LocalSecretResolver,
  LocalSecretResolverError,
  type LocalSecretResolverErrorCode,
  type ResolvedSecret,
} from './local-secret-resolver.js';
export {
  ControlPlaneAdapterError,
  type ControlPlaneAdapterErrorCode,
  type ControlPlanePort,
} from './control-plane.js';
export type {
  ControlPlaneRequest,
  ControlPlaneRequestExecutor,
  ControlPlaneResponse,
} from './control-plane-request.js';
export {
  PipelineRuntimeSchema,
  ProfileFingerprintSchema,
  ReconcileInputSchema,
  type PipelineRuntime,
  type PipelineTarget,
  type ProfileFingerprint,
  type ReconcileInput,
  type ReconciliationAction,
  type ReconciliationResult,
  type RestartAction,
  type StartAction,
  type StopAction,
} from './models.js';
export type { CourtPipelinePort } from './ports.js';
export { reconcileOutput } from './reconcile.js';
export {
  createAuthenticatedSupabaseControlPlane,
  createAuthenticatedSupabaseSdkClient,
  type AuthenticatedSupabaseClient,
} from './supabase-client.js';
export { SupabaseControlPlane } from './supabase-control-plane.js';
export type {
  AdmissionDecision,
  CourtInspectionResult,
  CourtShutdownResult,
  CourtWorkerResult,
  SupervisorReconciliationResult,
  SupervisorShutdownResult,
} from './orchestration-models.js';
export { Supervisor, type CourtPipelinePorts } from './supervisor.js';
export {
  loadProductionAgentConfig,
  parseProductionAgentConfig,
  ProductionAgentConfigError,
  type ProductionAgentConfig,
} from './production-agent-config.js';
export {
  composeProductionAgent,
  ProductionCompositionError,
  type ProductionAgentComposition,
  type ProductionCourtComposition,
} from './production-composition.js';
export {
  ObservedStateProjectionError,
  ObservedStateProjector,
} from './observed-state-projection.js';
export {
  ProductionReconciliationError,
  ProductionReconciliationLoop,
  type ProductionReconciliationLoopOptions,
  type ReconciliationControlPlanePort,
  type ReconciliationSupervisorPort,
} from './production-reconciliation-loop.js';
export {
  NodeProductionSignalSource,
  ProductionAgentLifecycle,
  ProductionAgentShutdownDeadlineError,
  type ProductionAgentLifecycleOptions,
  type ProductionAgentLoopPort,
  type ProductionSignal,
  type ProductionSignalSource,
} from './production-agent-lifecycle.js';
export { runProductionAgent } from './main.js';
