import { createClient as _createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_KEY!;

// Service-role client — bypasses Row Level Security.
// Only used server-side (API routes). Never expose SUPABASE_SERVICE_KEY to the browser.
export function createClient() {
  return _createClient(supabaseUrl, supabaseServiceKey, {
    auth: { persistSession: false },
  });
}
