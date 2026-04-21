import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { env } from './env';
import type { Database } from '../types/supabase.types';


let _supabase: SupabaseClient<Database> | null = null;

export function getSupabaseClient(): SupabaseClient<Database> {
  if (_supabase) return _supabase;

  _supabase = createClient<Database>(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
    db: {
      schema: 'public',
    },
  });

  return _supabase;
}

/**
 * Convenience export — the singleton instance.
 * Import this directly in repos: `import { supabase } from '../config/supabase'`
 */
export const supabase = getSupabaseClient();
