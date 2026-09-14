import { describe, expect, it } from 'vitest';
import { parseLocalAgentEnvironment } from '../src/local-runtime-config.js';

const courtIds = [
  '10000000-0000-4000-8000-000000000001',
  '10000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000003',
  '10000000-0000-4000-8000-000000000004',
] as const;

function validEnvironment(): Readonly<Record<string, string>> {
  return {
    PATH: '/usr/bin',
    KPL_AGENT_COURT_IDS: courtIds.join(','),
    KPL_AGENT_MAX_CONCURRENT_PIPELINES: '3',
    KPL_AGENT_SUPABASE_URL: 'https://project.supabase.co',
    KPL_AGENT_SUPABASE_PUBLISHABLE_KEY: 'publishable-example',
    KPL_AGENT_ACCESS_TOKEN: 'agent-access-example',
    KPL_AGENT_SECRET_ROOT: '/var/lib/kpl-agent/secrets',
    KPL_AGENT_POLL_INTERVAL_MS: '1000',
    KPL_AGENT_SHUTDOWN_DEADLINE_MS: '30000',
  };
}

describe('local agent runtime config', () => {
  it('parses a strict four-court local environment without serializing credentials', () => {
    const config = parseLocalAgentEnvironment(validEnvironment());

    expect(config.courtIds).toEqual(courtIds);
    expect(config.maxConcurrentPipelines).toBe(3);
    expect(config.supabaseUrl).toBe('https://project.supabase.co');
    expect(config.pollIntervalMs).toBe(1000);
    expect(config.shutdownDeadlineMs).toBe(30000);
    expect(JSON.stringify(config)).not.toContain('publishable-example');
    expect(JSON.stringify(config)).not.toContain('agent-access-example');
  });

  it.each([
    ['HTTP URL', 'http://project.supabase.co'],
    ['URL credentials', 'https://user:password@project.supabase.co'],
    ['URL path', 'https://project.supabase.co/rest/v1'],
    ['URL query', 'https://project.supabase.co?debug=true'],
    ['URL fragment', 'https://project.supabase.co#fragment'],
  ])('rejects a Supabase %s', (_label, supabaseUrl) => {
    const parse = () => parseLocalAgentEnvironment({
      ...validEnvironment(),
      KPL_AGENT_SUPABASE_URL: supabaseUrl,
    });

    expect(parse).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(parse).not.toThrow(supabaseUrl);
  });

  it('canonicalizes an HTTPS Supabase origin with a trailing slash', () => {
    const config = parseLocalAgentEnvironment({
      ...validEnvironment(),
      KPL_AGENT_SUPABASE_URL: 'https://PROJECT.supabase.co:443/',
    });

    expect(config.supabaseUrl).toBe('https://project.supabase.co');
  });

  it.each([
    ['leading whitespace', ' secret'],
    ['trailing whitespace', 'secret '],
    ['line feed', 'sec\nret'],
    ['delete control', 'sec\u007fret'],
    ['over length', 'x'.repeat(4097)],
  ])('rejects credential %s without exposing it', (_label, credential) => {
    const parse = () => parseLocalAgentEnvironment({
      ...validEnvironment(),
      KPL_AGENT_ACCESS_TOKEN: credential,
    });

    expect(parse).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(parse).not.toThrow(credential);
  });

  it.each([
    ['missing token', { KPL_AGENT_ACCESS_TOKEN: undefined }],
    ['empty key', { KPL_AGENT_SUPABASE_PUBLISHABLE_KEY: '' }],
    ['duplicate court', { KPL_AGENT_COURT_IDS: [...courtIds.slice(0, 3), courtIds[0]].join(',') }],
    ['wrong concurrency', { KPL_AGENT_MAX_CONCURRENT_PIPELINES: '4' }],
    ['relative secret root', { KPL_AGENT_SECRET_ROOT: './secrets' }],
    ['short poll interval', { KPL_AGENT_POLL_INTERVAL_MS: '99' }],
    ['long shutdown deadline', { KPL_AGENT_SHUTDOWN_DEADLINE_MS: '120001' }],
    ['unknown agent field', { KPL_AGENT_UNEXPECTED: 'value' }],
  ])('rejects %s', (_label, override) => {
    const parse = () => parseLocalAgentEnvironment({ ...validEnvironment(), ...override });

    expect(parse).toThrowError(expect.objectContaining({ code: 'INVALID_CONFIG' }));
    expect(parse).not.toThrow('agent-access-example');
  });
});
