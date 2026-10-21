// POST a challenge run; the run is replayed and only a verified score is stored.
// Deploy with JWT checks off (the browser sends the public key, not a user session):
//   supabase functions deploy submit-score --no-verify-jwt
import { createClient } from 'jsr:@supabase/supabase-js@2';
import { handleSubmit } from '../_shared/submit.js';

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};

// The service role key is injected by Supabase into the function's environment; it never reaches the browser.
const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
  auth: { persistSession: false }
});

const store = {
  async getBest(code: string, playerId: string, input: string) {
    const { data, error } = await db.from('scores').select('score')
      .eq('code', code).eq('player_id', playerId).eq('input', input).maybeSingle();
    if (error) throw error;
    return data;
  },
  async save(row: Record<string, unknown>) {
    const { error } = await db.from('scores').upsert(row, { onConflict: 'code,player_id,input' });
    if (error) throw error;
  },
  // input null = every input type (the combined board).
  async rank(code: string, input: string | null, score: number) {
    const board = () => {
      const q = db.from('scores').select('id', { count: 'exact', head: true }).eq('code', code);
      return input ? q.eq('input', input) : q;
    };
    const ahead = await board().gt('score', score);
    const all = await board();
    if (ahead.error) throw ahead.error;
    if (all.error) throw all.error;
    return { rank: (ahead.count ?? 0) + 1, total: all.count ?? 0 };
  }
};

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: cors });
  try {
    const { status, body } = await handleSubmit(await req.text(), store);
    return Response.json(body, { status, headers: cors });
  } catch (e) {
    console.error(e);
    return Response.json({ ok: false, error: 'The leaderboard is having trouble. Try again in a minute.' }, { status: 500, headers: cors });
  }
});
