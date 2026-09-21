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

const supabaseUrl = env.SUPABASE_URL;
const supabaseKey = env.SUPABASE_SERVICE_KEY;

if (!supabaseUrl || !supabaseKey) {
  console.error('Missing Supabase credentials');
  process.exit(1);
}

const supabase = createClient(supabaseUrl, supabaseKey);

async function checkAndMigrate() {
  console.log('Checking Supabase connection...');
  const { data: testData, error: testErr } = await supabase.from('marketing_materials').select('*').limit(5);
  if (testErr) {
    console.error('Error fetching marketing_materials:', testErr);
  } else {
    console.log('marketing_materials current rows count:', testData.length);
    if (testData.length > 0) {
      console.log('Sample row columns:', Object.keys(testData[0]));
    }
  }

  // Let's test inserting a record with category, content, drive_url
  console.log('Checking if enhanced columns exist...');
  const testInsert = {
    type: 'copy',
    title: '__migration_test__',
    category: 'dm',
    content: 'Test swipe content',
    url: 'https://example.com'
  };

  const { data: insData, error: insErr } = await supabase.from('marketing_materials').insert(testInsert).select('*').single();
  if (insErr) {
    console.log('Column check result:', insErr.message);
  } else {
    console.log('Enhanced columns already exist! Cleaning up test record...');
    await supabase.from('marketing_materials').delete().eq('id', insData.id);
  }

  // Fetch list of products to see current products
  const { data: prods, error: prodErr } = await supabase.from('products').select('id, slug, name');
  if (prods) {
    console.log('Current products:', prods);
  }
}

checkAndMigrate();
