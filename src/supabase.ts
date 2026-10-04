import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { AppConfig } from './config';

let supabaseClient: SupabaseClient | null = null;

export function getSupabaseClient(config?: AppConfig): SupabaseClient | null {
  if (supabaseClient) return supabaseClient;
  if (!config || !config.supabaseUrl || !config.supabaseServiceRoleKey) return null;

  try {
    supabaseClient = createClient(config.supabaseUrl, config.supabaseServiceRoleKey, {
      auth: {
        autoRefreshToken: false,
        persistSession: false
      }
    });
    return supabaseClient;
  } catch (err: any) {
    console.warn('[Supabase] Failed to initialize client:', err.message);
    return null;
  }
}
