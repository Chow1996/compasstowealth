// Vercel Serverless Function — 实时从 Supabase 拉数据,拼成原 data.json 的结构返回
// 部署后访问:https://compasstowealth.vercel.app/api/data
//
// 环境变量(在 Vercel Dashboard → Settings → Environment Variables 配):
//   SUPABASE_URL=https://odnbppebduxavyewuafu.supabase.co
//   SUPABASE_ANON_KEY=<你的 anon key,前端可见 OK>

const { createClient } = require('@supabase/supabase-js');

const AI_THEME = 'AI 产业链';

// AI 主题下,ticker → 子产业链 的映射(用于覆盖清单分组 & 矩阵分列)
// 这块没放数据库 schema 里,因为子分组不会经常变,加一个 ticker 也是改前端
const TICKER_GROUPS = {
  '核心算力 · GPU / ASIC / CPU': ['NVDA', 'AMD', 'INTC', 'AVGO', 'ARM'],
  '内存 / HBM / 存储': ['MU', 'SNDK', 'WDC'],
  '半导体设备 / 代工': ['TSM', 'ASML', 'AMAT', 'LRCX', 'KLAC'],
  'AI 应用 / SaaS / 云算力': ['PLTR', 'META', 'MSFT', 'GOOGL', 'AMZN', 'ORCL', 'CRWV'],
  '中国 AI / 中概': ['BABA', 'BIDU', 'PDD', 'JD'],
  '卫星 · 量子 · 光模块 · Neocloud': ['IONQ', 'AAOI', 'COHR', 'NBIS', 'RGTI'],
  '衍生品 · 半导体指数代币': ['CHIP'],
};
const TICKER_TO_GROUP = {};
Object.entries(TICKER_GROUPS).forEach(([g, tks]) => tks.forEach(t => { TICKER_TO_GROUP[t] = g; }));

// 竞对矩阵的 4 列(头行简称)→ TICKER_GROUPS 的精确 key
const MATRIX_COL_GROUPS = {
  '核心算力': '核心算力 · GPU / ASIC / CPU',
  'HBM': '内存 / HBM / 存储',
  'AI 应用': 'AI 应用 / SaaS / 云算力',
  '半导体设备': '半导体设备 / 代工',
};
const ALL_EXCHANGES = ['Binance', 'Hyperliquid', 'Bitget', 'OKX', 'Bybit'];

// 简单上币机会判断:含 OKX 缺/上币/漏单 关键词 → listing,否则 industry
function isListingEvent(e) {
  const text = ((e.name || '') + ' ' + (e.description || '') + ' ' + (e.okx_impact || '')).toLowerCase();
  return ['上币', '上线', '漏单', '建议上', '补全', '补 spot', '缺现货', 'okx 缺', 'okx无', '竞对'].some(k => text.includes(k));
}

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

    // 4. 拉竞对动作(从 cex_announce 来源的 raw_signals,带 metadata 才能区分 binance/bitget/...)
    const { data: cexAnnounce } = await supabase
      .from('raw_signals')
      .select('title, content, published_at, source_url, metadata')
      .eq('source', 'cex_announce')
      .order('published_at', { ascending: false })
      .limit(80);

    // 5. 拉 themes(含 narrative)+ tickers 全表(覆盖清单 + 矩阵共用)
    const { data: themesData } = await supabase
      .from('themes')
      .select('id, theme_name_cn, theme_name_en, narrative_current, narrative_updated_at, status, priority');
    const { data: tickersData } = await supabase
      .from('tickers')
      .select('ticker, name, category, priority, okx_perp, okx_spot, competitors_listed');

    const safeEvents = dedupEvents(events || []);
    const safeKol = kolViews || [];
    const safeRaw = rawSignals || [];
    const safeCex = cexAnnounce || [];
    const themes = themesData || [];
    const tickersAll = tickersData || [];

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
    // ai_full 字段名要跟 index.html 的 renderAiPulse() 对齐:
    // tks(不是 tickers)/ first_date+last_date(不是 event_date)/ impact_okx(不是 okx_impact)/ days_count
    // category 重映射:industry/listing/(kol 由 kol_views 走另一条路径)
    const ai_full = aiEvents
      .map(e => ({
        category: isListingEvent(e) ? 'listing' : 'industry',
        source_tag: e.source_tag || '',
        name: e.name,
        desc: e.description,
        heat: e.heat || 0,
        urgency: e.urgency,
        tks: e.tickers || [],
        impact_okx: e.okx_impact || '',
        first_date: e.event_date,
        last_date: e.event_last_date || e.event_date,
        days_count: 1,
      }))
      .slice(0, 30);

    // KOL 也喂进 ai_full(category=kol),让"AI 主题脉搏 - KOL 共识"那块有内容
    const aiKolItems = safeKol
      .filter(k => (k.themes || []).includes(AI_THEME))
      .slice(0, 9)
      .map(k => ({
        category: 'kol',
        source_tag: `@${(k.kol_handle || '').replace(/^@/,'')} · ${k.tier || ''}`,
        name: `${k.sentiment || '观点'} · ${(k.tickers || []).slice(0,3).join(' / ')}`,
        desc: k.view_text || '',
        heat: 0,
        tks: k.tickers || [],
        impact_okx: '',
        first_date: k.view_date,
        last_date: k.view_date,
        days_count: 1,
      }));
    ai_full.push(...aiKolItems);

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

    // 漏单计数:复用上面拉好的 tickersAll(避免二次请求)
    const gaps = tickersAll.filter(
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

    // ==== ai_comp_dated ==== (竞对动作时间线;含 metadata.cex 区分交易所)
    const ai_comp_dated = safeCex.slice(0, 30).map(c => ({
      date: (c.published_at || '').slice(0, 10),
      cex: ((c.metadata || {}).cex || '').toLowerCase(),
      what: c.title,
      detail: c.content,
      url: c.source_url,
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

    // ==== theme_overview ==== (AI 主题速览块,代替前端硬编码)
    const aiTheme = themes.find(t => t.theme_name_cn === AI_THEME) || {};
    const aiTickerList = tickersAll.filter(t => TICKER_TO_GROUP[t.ticker]);
    const totalAi = aiTickerList.length;
    const okxCovered = aiTickerList.filter(t => t.okx_perp || t.okx_spot).length;
    const aiGaps = aiTickerList.filter(t => !t.okx_perp && Array.isArray(t.competitors_listed) && t.competitors_listed.length > 0);
    const aiHotWeek = safeEvents.filter(e => (e.themes || []).includes(AI_THEME) && e.event_date >= dWeekAgo).length;
    const theme_overview = {
      theme_name: AI_THEME,
      narrative: aiTheme.narrative_current || '',
      narrative_updated_at: aiTheme.narrative_updated_at || null,
      kpis: {
        okx_coverage_pct: totalAi ? Math.round(okxCovered * 100 / totalAi) : 0,
        okx_coverage_text: `${okxCovered} / ${totalAi} 标的`,
        ai_hot_week: aiHotWeek,
        gap_count: aiGaps.length,
        gap_tickers: aiGaps.slice(0, 5).map(g => g.ticker),
      },
    };

    // ==== coverage_table ==== (OKX 已覆盖 vs 漏单清单,按子产业链分组)
    const coverage_table = Object.keys(TICKER_GROUPS).map(group => {
      const tickers = TICKER_GROUPS[group];
      const items = tickers
        .map(tk => {
          const row = tickersAll.find(r => r.ticker === tk);
          if (!row) return null;
          return {
            ticker: row.ticker,
            name: row.name,
            tier: (row.priority === 'P0' || row.priority === 'P1') ? 'Tier 1' : 'Tier 2',
            okx_perp: !!row.okx_perp,
            okx_spot: !!row.okx_spot,
            competitors: row.competitors_listed || [],
          };
        })
        .filter(Boolean);
      return { group, items };
    }).filter(g => g.items.length > 0);

    // ==== competitor_matrix ==== (各交易所在 AI 主题下的覆盖统计)
    const matrixCols = Object.keys(MATRIX_COL_GROUPS); // ['核心算力','HBM','AI 应用','半导体设备']
    const exStat = {};
    ALL_EXCHANGES.forEach(ex => {
      exStat[ex] = { name: ex, total: 0, by_group: {} };
      matrixCols.forEach(c => {
        const fullKey = MATRIX_COL_GROUPS[c];
        exStat[ex].by_group[c] = { covered: 0, total: TICKER_GROUPS[fullKey].length };
      });
    });
    aiTickerList.forEach(t => {
      const fullGroup = TICKER_TO_GROUP[t.ticker];
      const matrixCol = matrixCols.find(c => MATRIX_COL_GROUPS[c] === fullGroup);
      if (t.okx_perp || t.okx_spot) {
        exStat.OKX.total += 1;
        if (matrixCol) exStat.OKX.by_group[matrixCol].covered += 1;
      }
      (t.competitors_listed || []).forEach(ex => {
        if (exStat[ex]) {
          exStat[ex].total += 1;
          if (matrixCol) exStat[ex].by_group[matrixCol].covered += 1;
        }
      });
    });
    const competitor_matrix = ALL_EXCHANGES.map(ex => exStat[ex])
      .sort((a, b) => b.total - a.total);

    const result = {
      meta, today, week, month, ai_week, latest, kpi,
      exchanges, top_tickers_week, tg_today,
      ai_strict, ai_comp_dated, ai_kols_dated,
      raw_items_by_date: rawByDate,
      ai_full, ai_kol_consensus, ai_kol_views_filtered, ai_macro_warnings,
      theme_overview, coverage_table, competitor_matrix, // 新增
      _generated_at: new Date().toISOString(),
    };

    return res.status(200).json(result);
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: String(err.message || err) });
  }
};
