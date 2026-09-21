export type ProcessStdioPlan = 'ignore' | 'pipe';

export type ProcessCommandPlan = {
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<'LANG' | 'LC_ALL', string>>;
  readonly stdio: readonly ProcessStdioPlan[];
  readonly shell: false;
};

export const MEDIA_PROCESS_ENV = Object.freeze({
  LANG: 'C.UTF-8',
  LC_ALL: 'C.UTF-8',
});
