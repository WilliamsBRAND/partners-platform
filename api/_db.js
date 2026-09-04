import { createClient } from '@supabase/supabase-js';

const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_KEY || '';

let client = null;

export function getDb() {
  if (!supabaseUrl || !supabaseKey) return null;
  if (!client) {
    client = createClient(supabaseUrl, supabaseKey, {
      auth: { persistSession: false },
    });
  }
  return client;
}

export function json(res, status, body, headers = {}) {
  res.status(status);
  res.setHeader('Content-Type', 'application/json');
  for (const [k, v] of Object.entries(headers)) {
    res.setHeader(k, v);
  }
  return res.end(JSON.stringify(body));
}
