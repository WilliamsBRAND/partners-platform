import { createClient } from '@supabase/supabase-js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envContent = fs.readFileSync(path.join(__dirname, '../.env'), 'utf8');
const env = {};
envContent.split('\n').forEach(line => {
  const [k, ...v] = line.split('=');
  if (k && v.length) env[k.trim()] = v.join('=').trim();
});

const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

// Format helper
export function packMaterial(item) {
  const category = item.category || 'general';
  const type = item.type || (category === 'creative' ? 'image' : (category === 'drive_link' ? 'link' : 'copy'));
  const title = String(item.title || '').trim() || 'Promotional Asset';
  const content = String(item.content || '').trim();
  const url = String(item.url || '').trim();
  const drive_url = String(item.drive_url || '').trim();

  // Pack structured metadata into url column
  const meta = {
    category,
    content,
    url: url || drive_url,
    drive_url
  };

  const packedUrl = 'meta:' + encodeURIComponent(JSON.stringify(meta));
  return {
    product_id: item.product_id,
    type: type === 'copy' ? 'asset' : type,
    title,
    url: packedUrl
  };
}

export function unpackMaterial(row) {
  if (!row) return null;
  let category = 'general';
  let content = '';
  let url = row.url || '';
  let drive_url = '';
  let type = row.type || 'asset';

  if (url.startsWith('meta:')) {
    try {
      const parsed = JSON.parse(decodeURIComponent(url.slice(5)));
      category = parsed.category || 'general';
      content = parsed.content || '';
      url = parsed.url || '';
      drive_url = parsed.drive_url || '';
    } catch (e) {
      content = url.slice(5);
    }
  } else if (url.startsWith('copy:')) {
    category = 'dm';
    try { content = decodeURIComponent(url.slice(5)); } catch (e) { content = url.slice(5); }
    url = '';
  } else if (url.startsWith('review:')) {
    category = 'review';
  } else if (type === 'image' || url.match(/\.(png|jpe?g|webp|gif|svg)(\?.*)?$/i)) {
    category = 'creative';
    type = 'image';
  } else if (url.includes('drive.google.com')) {
    category = 'drive_link';
    type = 'link';
    drive_url = url;
  }

  // Determine user-friendly type
  if (!type || type === 'asset') {
    if (content) type = 'copy';
    else if (category === 'creative') type = 'image';
    else if (category === 'drive_link') type = 'link';
    else type = 'link';
  }

  return {
    id: row.id,
    product_id: row.product_id,
    category,
    type,
    title: row.title,
    content,
    url,
    drive_url,
    created_at: row.created_at
  };
}

async function runTest() {
  console.log('Testing pack and unpack...');
  const sample = {
    product_id: 'eee0450d-cf16-4ebc-bd24-92dae50eb378',
    category: 'status',
    title: 'Urgency WhatsApp Status Line',
    content: 'Want to scale your business with AI? Check this out: {LINK}',
    url: '',
    drive_url: ''
  };

  const packed = packMaterial(sample);
  console.log('Packed record:', packed);

  const { data, error } = await supabase.from('marketing_materials').insert(packed).select('*').single();
  if (error) {
    console.error('Insert error:', error);
    return;
  }

  console.log('Saved row to DB with ID:', data.id);
  const unpacked = unpackMaterial(data);
  console.log('Unpacked record:', unpacked);

  // Clean up
  await supabase.from('marketing_materials').delete().eq('id', data.id);
  console.log('Test passed and cleaned up successfully!');
}

runTest();
