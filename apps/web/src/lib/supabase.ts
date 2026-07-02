import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY as string | undefined;

export const hasSupabaseConfig = Boolean(supabaseUrl && supabasePublishableKey);

export const supabase = createClient(
  supabaseUrl ?? 'http://localhost:54321',
  supabasePublishableKey ?? 'missing-publishable-key',
);

export function assertSupabaseConfig(): void {
  if (!hasSupabaseConfig) {
    throw new Error('Faltan VITE_SUPABASE_URL y VITE_SUPABASE_PUBLISHABLE_KEY.');
  }
}
