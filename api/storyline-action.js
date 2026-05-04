// Vercel Serverless Function — 处理 Watchlist 上的 storyline 操作
// POST /api/storyline-action  body = { id, action, value? }
//   action='pin'      → pinned = true
//   action='unpin'    → pinned = false
//   action='dismiss'  → dismissed = true (Watchlist 不再展示)
//   action='close'    → status = 'closed' (主动结束跟踪)
//   action='reopen'   → status = 'active'
//   action='notes'    → notes = value (字符串)
//
// 环境变量:SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY(注意:这个端点会写库,
// 必须用 service_role,前端 anon key 没权限改)
const { createClient } = require('@supabase/supabase-js');

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY 未配置' });
  }

  // Vercel 会自动 parse JSON body,但有时 req.body 是 string,做下兼容
  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { id, action, value } = body || {};
  if (!id || !action) {
    return res.status(400).json({ error: 'missing id or action' });
  }

  const ALLOWED = ['pin', 'unpin', 'dismiss', 'close', 'reopen', 'notes'];
  if (!ALLOWED.includes(action)) {
    return res.status(400).json({ error: `invalid action; allowed: ${ALLOWED.join(',')}` });
  }

  let updateFields = {};
  switch (action) {
    case 'pin':     updateFields = { pinned: true };      break;
    case 'unpin':   updateFields = { pinned: false };     break;
    case 'dismiss': updateFields = { dismissed: true };   break;
    case 'close':   updateFields = { status: 'closed' };  break;
    case 'reopen':  updateFields = { status: 'active' };  break;
    case 'notes':   updateFields = { notes: String(value || '').slice(0, 1000) }; break;
  }

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('storylines')
      .update(updateFields)
      .eq('id', id)
      .select()
      .single();
    if (error) throw error;
    return res.status(200).json({ ok: true, storyline: data });
  } catch (err) {
    console.error('storyline-action error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
