import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '../.env');
const envContent = fs.readFileSync(envPath, 'utf8');

const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim();
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

async function trySql() {
  const sql = `
    ALTER TABLE marketing_materials ADD COLUMN IF NOT EXISTS category text DEFAULT 'general';
    ALTER TABLE marketing_materials ADD COLUMN IF NOT EXISTS content text;
    ALTER TABLE marketing_materials ADD COLUMN IF NOT EXISTS drive_url text;
    ALTER TABLE marketing_materials ADD COLUMN IF NOT EXISTS sort_order integer DEFAULT 0;
  `;

  // Try rpc 'exec_sql' or similar if present
  const { data, error } = await supabase.rpc('exec_sql', { query: sql });
  if (error) {
    console.log('rpc exec_sql not present:', error.message);
  } else {
    console.log('SQL executed successfully via RPC!');
  }
}

trySql();
