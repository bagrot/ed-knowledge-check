import { createClient } from "@supabase/supabase-js";

const configuredSupabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL || "";
const supabasePublishableKey = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY || "";
const supabaseUrl = typeof window === "undefined" ? configuredSupabaseUrl : `${window.location.origin}/supabase`;

export const isSupabaseConfigured = Boolean(configuredSupabaseUrl && supabasePublishableKey);

if (process.env.NODE_ENV === 'production' && !isSupabaseConfigured) {
  throw new Error('Supabase configuration is required for production');
}

export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabasePublishableKey, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : null;
