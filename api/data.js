// Vercel Serverless Function — 实时从 Supabase 拉数据,拼成原 data.json 的结构返回
// 部署后访问:https://compasstowealth.vercel.app/api/data
//
// 环境变量(在 Vercel Dashboard → Settings → Environment Variables 配):
//   SUPABASE_URL=https://odnbppebduxavyewuafu.supabase.co
//   SUPABASE_ANON_KEY=<你的 anon key,前端可见 OK>

const { createClient } = require('@supabase/supabase-js');

const AI_THEME = 'AI 产业链';

// 把 Supabase row → dashboard cluster 块
function eventToCluster(e) {
  return {
    cluster: e.themes?.[0] || '其他',
    name: e.name || '',
    desc: e.description || '',
    heat: e.heat || 0,
    days_count: 1,
    first_date: e.event_date,
    last_date: e.event_last_date || e.event_date,
    levels: [{ level: e.heat >= 80 ? 'L3' : e.heat >= 70 ? 'L2' : 'L1', date: e.event_date }],
    tks: e.tickers || [],
    category: e.category,
    source_tag: e.source_tag,
    okx_impact: e.okx_impact,
  };
}

// 跨源去重:LLM 把同一新闻从多源各抽一次,得合到一条。
// 策略:按 heat 倒序,逐个检查是否跟已留下的某条"明显是同一事件"
//   - ticker 集合 Jaccard ≥ 0.5(共享 ≥ 2 个 ticker)
//   - 或 标题前 4 个有效字符相同
//   - 且 heat 差 ≤ 6(避免完全无关的同 ticker 事件被合)
function dedupEvents(events) {
  const tokenize = (s) => (s || '')
    .replace(/[，。、,.\s\-—|·:：!！?？""''「」《》()（）/]/g, '')
    .toLowerCase()
    .split('')
    .filter(c => /[一-龥a-z0-9]/.test(c));

  const titleHead = (name) => tokenize(name).slice(0, 4).join('');

  const isSameStory = (a, b) => {
    if (Math.abs((a.heat || 0) - (b.heat || 0)) > 6) return false;
    // Rule 1: ticker 集合重叠 ≥ 2 个 + Jaccard ≥ 0.4
    const at = new Set(a.tickers || []);
    const bt = new Set(b.tickers || []);
    const tInter = [...at].filter(t => bt.has(t)).length;
    const tUnion = new Set([...at, ...bt]).size;
    if (tInter >= 2 && tUnion > 0 && tInter / tUnion >= 0.4) return true;
    // Rule 2: 标题字符级 Jaccard ≥ 0.6(catch 同新闻不同表述)
    const titleA = new Set(tokenize(a.name));
    const titleB = new Set(tokenize(b.name));
    if (titleA.size >= 4 && titleB.size >= 4) {
      const tnInter = [...titleA].filter(t => titleB.has(t)).length;
      const tnUnion = new Set([...titleA, ...titleB]).size;
      if (tnUnion > 0 && tnInter / tnUnion >= 0.6) return true;
    }
    // Rule 3: 标题前 4 字相同
    if (titleHead(a.name) && titleHead(a.name) === titleHead(b.name)) return true;
    return false;
  };

  const sorted = [...events].sort((a, b) => (b.heat || 0) - (a.heat || 0));
  const out = [];
  for (const e of sorted) {
    if (out.some(kept => isSameStory(kept, e))) continue;
    out.push(e);
  }
  return out;
}

function bucketByHeat(e) {
  const h = e.heat || 0;
  if (h >= 80) return 'L3';
  if (h >= 70) return 'L2';
  return 'L1';
}

function dateRange(end, days) {
  const end_ = new Date(end + 'T00:00:00Z');
  const start = new Date(end_);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return start.toISOString().slice(0, 10);
}

module.exports = async (req, res) => {
  // CORS 兼容
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600'); // 边缘缓存 5 分钟

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_ANON_KEY;
  if (!url || !key) {
    return res.status(500).json({ error: 'SUPABASE_URL / SUPABASE_ANON_KEY 未配置' });
  }
  const supabase = createClient(url, key, { auth: { persistSession: false } });

  try {
    // 1. 拉所有 events(带 themes/tickers join 的视图)
    const { data: events, error: evErr } = await supabase
      .from('v_events_full')
      .select('*')
      .order('event_date', { ascending: false })
      .order('heat', { ascending: false })
      .limit(500);
    if (evErr) throw evErr;

    // 2. 拉 KOL views
    const { data: kolViews } = await supabase
      .from('v_kol_views_full')
      .select('*')
      .order('view_date', { ascending: false })
      .limit(200);

    // 3. 拉 raw_signals(限制 200 条最近的)
    const { data: rawSignals } = await supabase
      .from('raw_signals')
      .select('source, source_url, title, content, published_at, detected_tickers, raw_score, fetched_for_date')
      .order('published_at', { ascending: false, nullsFirst: false })
      .limit(200);

    // 4. 拉竞对动作(从 cex_announce 来源的 raw_signals)
    const { data: cexAnnounce } = await supabase
      .from('raw_signals')
      .select('title, content, published_at, source_url')
      .eq('source', 'cex_announce')
      .order('published_at', { ascending: false })
      .limit(50);

    const safeEvents = dedupEvents(events || []);
    const safeKol = kolViews || [];
    const safeRaw = rawSignals || [];
    const safeCex = cexAnnounce || [];

    // ==== meta ====
    const allDates = [...new Set(safeEvents.map(e => e.event_date).filter(Boolean))].sort();
    const dateMax = allDates[allDates.length - 1] || new Date().toISOString().slice(0, 10);
    const dateMin = allDates[0] || dateMax;
    const meta = {
      date_max: dateMax,
      date_min: dateMin,
      days_count: allDates.length,
      all_dates: allDates,
    };

    // ==== today / week / month ====
    const today = safeEvents
      .filter(e => e.event_date === dateMax)
      .map(eventToCluster)
      .slice(0, 12);

    const weekStart = dateRange(dateMax, 7);
    const week = safeEvents
      .filter(e => e.event_date >= weekStart)
      .map(eventToCluster)
      .slice(0, 15);

    const monthStart = dateRange(dateMax, 30);
    const month = safeEvents
      .filter(e => e.event_date >= monthStart)
      .map(eventToCluster)
      .slice(0, 20);

    // ==== ai_week / ai_strict / ai_full ====
    const aiEvents = safeEvents.filter(e => (e.themes || []).includes(AI_THEME));
    const ai_week = aiEvents
      .filter(e => e.event_date >= weekStart)
      .map(eventToCluster)
      .slice(0, 10);
    const ai_strict = aiEvents
      .filter(e => (e.heat || 0) >= 85)
      .map(eventToCluster)
      .slice(0, 5);
    const ai_full = aiEvents
      .map(e => ({
        category: e.category,
        source_tag: e.source_tag,
        name: e.name,
        desc: e.description,
        heat: e.heat,
        urgency: e.urgency,
        tickers: e.tickers,
        okx_impact: e.okx_impact,
        event_date: e.event_date,
      }))
      .slice(0, 30);

    // ==== latest (今日 dispatch 块) ====
    const todayEv = safeEvents.filter(e => e.event_date === dateMax);
    const todayBuckets = { L3: [], L2: [], L1: [] };
    todayEv.forEach(e => todayBuckets[bucketByHeat(e)].push(e));

    const tickerCount = {};
    todayEv.forEach(e => (e.tickers || []).forEach(t => { tickerCount[t] = (tickerCount[t] || 0) + 1; }));
    const topTkToday = Object.entries(tickerCount).sort((a, b) => b[1] - a[1]).slice(0, 14).map(x => x[0]);

    const todayKols = safeKol.filter(k => k.view_date === dateMax).slice(0, 12).map(k => ({
      n: k.kol_handle, v: k.view_text, s: k.sentiment === '看多' ? 'p' : k.sentiment === '看空' ? 'n' : '0',
    }));
    const todayComp = safeCex.filter(c => (c.published_at || '').slice(0, 10) === dateMax).slice(0, 12).map(c => ({
      what: c.title, detail: c.content,
    }));

    const latest = {
      summary: aiEvents[0]?.description || '',
      topTk: topTkToday,
      L3: todayBuckets.L3.slice(0, 5).map(e => ({
        name: e.name, tk: (e.tickers || []).join(','), heat: e.heat, urg: e.urgency,
        desc: e.description, act: e.okx_impact, comp: '', gap: '',
      })),
      L2: todayBuckets.L2.slice(0, 7).map(e => ({
        name: e.name, heat: e.heat, desc: e.description, tks: (e.tickers || []).join(','),
        sig: e.source_tag, cluster_explicit: (e.themes || [])[0] || '',
      })),
      L1: todayBuckets.L1.slice(0, 9).map(e => ({
        name: e.name, desc: e.description, sig: e.source_tag,
        cluster_explicit: (e.themes || [])[0] || '',
      })),
      comp: todayComp,
      kols: todayKols,
      tg: [],
      st: [],
      ex: [],
    };

    // ==== kpi ====
    const dWeekAgo = dateRange(dateMax, 7);
    const weekEv = safeEvents.filter(e => e.event_date >= dWeekAgo);
    const weekKol = safeKol.filter(k => k.view_date >= dWeekAgo);
    const weekComp = safeCex.filter(c => (c.published_at || '').slice(0, 10) >= dWeekAgo);
    const weekRaw = safeRaw.filter(r => r.fetched_for_date >= dWeekAgo);

    const kpi = {
      l3_week: weekEv.filter(e => (e.heat || 0) >= 80).length,
      kol_week: weekKol.length,
      comp_week: weekComp.length,
      msgs_week: weekRaw.length,
      gap_count: 0, // 漏单计数,后面填
      today_l3: todayBuckets.L3.length,
      today_l2: todayBuckets.L2.length,
      today_l1: todayBuckets.L1.length,
      today_kols: todayKols.length,
      today_comp: todayComp.length,
    };

    // 拉 tickers 算漏单(全拉,JS 里过滤,避免 supabase-js 的 not-null 语法坑)
    const { data: gapsData } = await supabase
      .from('tickers')
      .select('ticker, name, priority, competitors_listed, okx_perp');
    const gaps = (gapsData || []).filter(
      t => !t.okx_perp && Array.isArray(t.competitors_listed) && t.competitors_listed.length > 0
    );
    kpi.gap_count = gaps.length;

    // ==== top_tickers_week ====
    const weekTkCount = {};
    weekEv.forEach(e => (e.tickers || []).forEach(t => { weekTkCount[t] = (weekTkCount[t] || 0) + 1; }));
    const top_tickers_week = Object.entries(weekTkCount).sort((a, b) => b[1] - a[1]).slice(0, 15);

    // ==== exchanges (从 raw_signals 按 source 计数) ====
    const exchCount = {};
    safeRaw.forEach(r => { exchCount[r.source] = (exchCount[r.source] || 0) + 1; });
    const exchanges = Object.entries(exchCount).map(([n, c]) => ({ n, c, s: 1 }));

    // ==== ai_comp_dated ====
    const ai_comp_dated = safeCex.slice(0, 5).map(c => ({
      date: (c.published_at || '').slice(0, 10),
      what: c.title,
      detail: c.content,
    }));

    // ==== ai_kols_dated ====
    const ai_kols_dated = safeKol.slice(0, 18).map(k => ({
      date: k.view_date, n: k.kol_handle, v: k.view_text,
      s: k.sentiment === '看多' ? 'p' : k.sentiment === '看空' ? 'n' : '0',
    }));

    // ==== raw_items_by_date ====
    // 用 LLM 抽出的 events 喂前端 aggregateRange(),字段名要跟 index.html 的渲染器对齐
    // (name/desc/heat/urg/tks/cluster_explicit),不能用 raw_signals 那一套(title/score/tickers)
    const rawByDate = {};
    safeEvents.forEach(e => {
      const d = e.event_date;
      if (!d) return;
      if (!rawByDate[d]) rawByDate[d] = [];
      rawByDate[d].push({
        date: d,
        level: (e.heat || 0) >= 80 ? 'L3' : (e.heat || 0) >= 70 ? 'L2' : 'L1',
        cluster_explicit: (e.themes || [])[0] || null,
        name: e.name,
        desc: e.description || '',
        heat: e.heat || 0,
        urg: e.urgency || '',
        tk: (e.tickers || [])[0] || '',
        tks: e.tickers || [],
        gap: [],
        comp: [],
        sig: e.source_tag ? [e.source_tag] : [],
        act: e.okx_impact || '',
      });
    });

    // ==== ai_kol_consensus / ai_kol_views_filtered / ai_macro_warnings ====
    // 这三块需要进一步 LLM 聚合,目前空数组占位
    const ai_kol_consensus = [];
    const ai_kol_views_filtered = safeKol
      .filter(k => (k.themes || []).includes(AI_THEME))
      .slice(0, 9)
      .map(k => ({
        date: k.view_date, name: k.kol_handle,
        sentiment: k.sentiment === '看多' ? 'up' : k.sentiment === '看空' ? 'down' : 'neutral',
        view: k.view_text, tks: k.tickers || [],
      }));
    const ai_macro_warnings = [];
    const tg_today = [];

    const result = {
      meta, today, week, month, ai_week, latest, kpi,
      exchanges, top_tickers_week, tg_today,
      ai_strict, ai_comp_dated, ai_kols_dated,
      raw_items_by_date: rawByDate,
      ai_full, ai_kol_consensus, ai_kol_views_filtered, ai_macro_warnings,
      _generated_at: new Date().toISOString(),
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
