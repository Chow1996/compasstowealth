// Vercel Serverless Function — 处理 Watchlist 上的 subtopic 操作
// POST /api/subtopic-action  body = { canonical_name, action, value? }
//   action='pin'        → pinned = true
//   action='unpin'      → pinned = false
//   action='dismiss'    → dismissed = true (Watchlist 不再展示)
//   action='undismiss'  → dismissed = false
//   action='notes'      → notes = value (≤ 1000 字符)
//
// 环境变量:SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY(必须 service_role,前端 anon 无写权限)
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

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const { canonical_name, action, value } = body || {};
  if (!canonical_name || !action) {
    return res.status(400).json({ error: 'missing canonical_name or action' });
  }

  const ALLOWED = ['pin', 'unpin', 'dismiss', 'undismiss', 'notes'];
  if (!ALLOWED.includes(action)) {
    return res.status(400).json({ error: `invalid action; allowed: ${ALLOWED.join(',')}` });
  }

  let updateFields = {};
  switch (action) {
    case 'pin':       updateFields = { pinned: true };       break;
    case 'unpin':     updateFields = { pinned: false };      break;
    case 'dismiss':   updateFields = { dismissed: true };    break;
    case 'undismiss': updateFields = { dismissed: false };   break;
    case 'notes':     updateFields = { notes: String(value || '').slice(0, 1000) }; break;
  }

  try {
    const supabase = createClient(url, key, { auth: { persistSession: false } });
    const { data, error } = await supabase
      .from('subtopics')
      .update(updateFields)
      .eq('canonical_name', canonical_name)
      .select()
      .single();
    if (error) throw error;
    return res.status(200).json({ ok: true, subtopic: data });
  } catch (err) {
    console.error('subtopic-action error:', err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
