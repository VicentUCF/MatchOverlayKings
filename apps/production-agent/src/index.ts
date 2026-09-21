export { fingerprintProfile } from './domain/fingerprint.js';
export {
  FfmpegProgressError,
  FfmpegProgressParser,
  type FfmpegProgressErrorCode,
  type FfmpegProgressRecord,
} from './infrastructure/ffmpeg/ffmpeg-progress.js';
export {
  FfmpegHealthError,
  FfmpegHealthTracker,
  type FfmpegHealth,
  type FfmpegHealthErrorCode,
} from './infrastructure/ffmpeg/ffmpeg-health.js';
export { FfmpegCourtPipeline } from './infrastructure/ffmpeg/ffmpeg-court-pipeline.js';
export {
  FfmpegCourtPipelineError,
  type FfmpegCourtPipelineErrorCode,
  type FfmpegCourtPipelineLifecycle,
  type FfmpegCourtPipelineOptions,
} from './infrastructure/ffmpeg/ffmpeg-court-pipeline-model.js';
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
} from './infrastructure/process/managed-process.js';
export {
  ProgressStreamError,
  type ProgressStreamErrorCode,
} from './infrastructure/process/progress-queue.js';
export {
  NodeScheduler,
  ProcessStopError,
  stopFfmpeg,
  stopMediaMtx,
  type ProcessStopErrorCode,
  type SchedulerPort,
  type StopProcessOptions,
} from './infrastructure/process/process-stop.js';
export { buildFfmpegCommandPlan, type FfmpegPlanInput } from './infrastructure/ffmpeg/ffmpeg-plan.js';
export { buildMediaMtxPlan, type MediaMtxPlan } from './infrastructure/mediamtx/mediamtx-plan.js';
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
} from './infrastructure/mediamtx/mediamtx-api-client.js';
export {
  createMediaMtxApiCredentials,
  MediaMtxApiCredentialFactory,
  MediaMtxApiCredentialsError,
  type MediaMtxApiCredentialFactoryPort,
  type MediaMtxApiCredentials,
  type MediaMtxApiCredentialsErrorCode,
  type MediaMtxApiPlannerCredentials,
  type RandomBytesPort,
} from './infrastructure/mediamtx/mediamtx-api-credentials.js';
export {
  EphemeralRuntimeFilesError,
  isEphemeralRuntimeCleanupRecovery,
  NodeEphemeralRuntimeFiles,
  type EphemeralRuntimeArtifact,
  type EphemeralRuntimeCleanupRecovery,
  type EphemeralRuntimeFilesErrorCode,
  type EphemeralRuntimeFilesOptions,
  type EphemeralRuntimeFilesPort,
} from './infrastructure/process/ephemeral-runtime-files.js';
export {
  MediaMtxReadinessError,
  waitForMediaMtxReadiness,
  type MediaMtxReadinessErrorCode,
  type MediaMtxReadinessOptions,
} from './infrastructure/mediamtx/mediamtx-readiness.js';
export {
  MediaMtxService,
  MediaMtxServiceError,
  type MediaMtxServiceErrorCode,
  type MediaMtxServiceOptions,
  type MediaMtxServiceStatus,
} from './infrastructure/mediamtx/mediamtx-service.js';
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
} from './infrastructure/config/media-runtime-config.js';
export type { ProcessCommandPlan, ProcessStdioPlan } from './infrastructure/process/process-command-plan.js';
export {
  AgentLoggerError,
  JsonLineLogger,
  type AgentLogEvent,
  type AgentLogFields,
  type AgentLogLevel,
  type AgentLogger,
  type JsonLineLoggerOptions,
} from './infrastructure/process/agent-logger.js';
export {
  AgentConfigSchema,
  CourtSnapshotSchema,
  CourtWorkerConfigSchema,
  SupervisorSnapshotsSchema,
  type AgentConfig,
  type CourtSnapshot,
  type CourtWorkerConfig,
  type SupervisorSnapshots,
} from './domain/config.js';
export { CourtWorker } from './application/court-worker.js';
export {
  LocalAgentRuntimeConfigError,
  LocalAgentRuntimeConfigSchema,
  parseLocalAgentEnvironment,
  type LocalAgentRuntimeConfig,
  type RuntimeCredential,
} from './infrastructure/config/local-runtime-config.js';
export {
  LocalSecretResolver,
  LocalSecretResolverError,
  type LocalSecretResolverErrorCode,
  type ResolvedSecret,
} from './infrastructure/config/local-secret-resolver.js';
export {
  ControlPlaneAdapterError,
  type ControlPlaneAdapterErrorCode,
  type ControlPlanePort,
} from './infrastructure/supabase/control-plane.js';
export type {
  ControlPlaneRequest,
  ControlPlaneRequestExecutor,
  ControlPlaneResponse,
} from './infrastructure/supabase/control-plane-request.js';
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
} from './domain/models.js';
export type { CourtPipelinePort } from './domain/ports.js';
export { reconcileOutput } from './domain/reconcile.js';
export {
  createAuthenticatedSupabaseControlPlane,
  createAuthenticatedSupabaseSdkClient,
  type AuthenticatedSupabaseClient,
} from './infrastructure/supabase/supabase-client.js';
export { SupabaseControlPlane } from './infrastructure/supabase/supabase-control-plane.js';
export type {
  AdmissionDecision,
  CourtInspectionResult,
  CourtShutdownResult,
  CourtWorkerResult,
  SupervisorReconciliationResult,
  SupervisorShutdownResult,
} from './domain/orchestration-models.js';
export { Supervisor, type CourtPipelinePorts } from './application/supervisor.js';
export {
  loadProductionAgentConfig,
  parseProductionAgentConfig,
  ProductionAgentConfigError,
  type ProductionAgentConfig,
} from './application/production-agent-config.js';
export {
  composeProductionAgent,
  ProductionCompositionError,
  type ProductionAgentComposition,
  type ProductionCourtComposition,
} from './application/production-composition.js';
export {
  ObservedStateProjectionError,
  ObservedStateProjector,
} from './application/observed-state-projection.js';
export {
  ProductionReconciliationError,
  ProductionReconciliationLoop,
  type ProductionReconciliationLoopOptions,
  type ReconciliationControlPlanePort,
  type ReconciliationSupervisorPort,
} from './application/production-reconciliation-loop.js';
export {
  NodeProductionSignalSource,
  ProductionAgentLifecycle,
  ProductionAgentShutdownDeadlineError,
  type ProductionAgentLifecycleOptions,
  type ProductionAgentLoopPort,
  type ProductionSignal,
  type ProductionSignalSource,
} from './application/production-agent-lifecycle.js';
export { runProductionAgent } from './bootstrap/main.js';
