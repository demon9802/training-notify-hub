// Supabase Edge Function: send-due-series
// 系列推送独立定时发送链路（与 send-due-scheduled 完全并行、互不干扰）。
//
// 设计定位：
//   - 数据真源 = Supabase tn_kv 的 `series:<pid>` 键（与 project:<pid> 隔离）。
//   - 由 pg_cron 每 5 分钟调用一次（见 series-cron.sql）。
//   - 用 tn_sends 表主键 claim 做幂等，与现有通知调度互不重复。
//   - 现有通知的定时发送（send-due-scheduled）、图文编排、推送概览：零改动。
//
// 部署（控制台）：
//   1) Supabase → Edge Functions → New Function → 名称 send-due-series → 粘贴本文件 → Deploy
//   2) 同一函数 → Secrets/Variables 设置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY
//   3) SQL Editor 执行 series-cron.sql 建立 pg_cron（每 5 分钟触发）
//
// 发送窗口：notifyAt 后 0..24h 内发送（与现有调度一致）。

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RUN_ID = `series-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// ============ Supabase REST 封装 ============
function q(params: Record<string, string>): string {
  const p = new URLSearchParams();
  for (const k in params) p.set(k, params[k]);
  return p.toString();
}
async function sbRest(path: string, method = 'GET', body?: any) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    method,
    headers: {
      'apikey': SUPABASE_SERVICE_ROLE_KEY,
      'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      'Prefer': 'return=minimal'
    },
    body: body ? JSON.stringify(body) : undefined
  });
  return r;
}
async function loadKV(key: string): Promise<any> {
  const r = await sbRest(`tn_kv?${q({ select: 'data', key: 'eq.' + key })}`);
  if (!r.ok) return null;
  const rows = await r.json();
  return (rows && rows[0] && rows[0].data) || null;
}

// ============ 发送 + 幂等 ============
async function sendWeCom(webhook: string, payload: any) {
  const resp = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  let ok = resp.ok, warn = '';
  try {
    const j = JSON.parse(text);
    if (j.errcode && j.errcode !== 0) { ok = false; warn = j.errmsg; }
  } catch (e) { if (!resp.ok) warn = text.slice(0, 200); }
  return { ok, warn };
}
async function claim(sendId: string): Promise<boolean> {
  const r = await sbRest('tn_sends', 'POST', [{
    id: sendId, status: 'claimed', claimed_by: RUN_ID, claimed_at: new Date().toISOString()
  }]);
  return r.ok;
}
async function markSent(sendId: string, status: string, lastError?: string) {
  await sbRest(`tn_sends?${q({ id: 'eq.' + sendId })}`, 'PATCH', {
    status,
    sent_at: status === 'sent' ? new Date().toISOString() : null,
    last_error: lastError || null,
    updated_at: new Date().toISOString()
  });
}

// ============ payload 构建（系列内容已是具体文案，无需模板变量渲染） ============
function buildSeriesPayload(day: any, s: any) {
  const layout = day.layout || s.layout || 'inline';
  const title = day.title || '';
  const body = day.body || '';
  const link = day.link || '';
  const img = day.img || '';
  if (layout === 'card' && img) {
    return {
      msgtype: 'news',
      news: {
        articles: [{
          title: title || '通知',
          description: body.replace(/!\[[^\]]*\]\([^)]*\)/g, '').slice(0, 200),
          url: link || 'https://work.weixin.qq.com/',
          picurl: img
        }]
      }
    };
  }
  // 图文并排 / 纯文字 / 卡片无图降级
  let content = '';
  if (title) content += '**' + title + '**\n';
  content += body;
  if (link) content += '\n[查看详情](' + link + ')';
  return { msgtype: 'markdown_v2', markdown_v2: { content } };
}

// 解析某天发送时间：日期 + 系列 time，强制按东八区
function parseSeriesAt(date: string, time: string): number {
  if (!date) return NaN;
  const t = time || '09:00';
  return new Date(date + 'T' + t + '+08:00').getTime();
}

// ============ 主流程 ============
async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: '缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY' };
  }
  const groups = (await loadKV('global_groups')) || [];
  const seriesResp = await sbRest(`tn_kv?${q({ select: 'key,data', key: 'like.series*' })}`);
  if (!seriesResp.ok) return { ok: false, error: '读取系列失败: ' + seriesResp.status };
  const seriesRows = await seriesResp.json();

  const now = new Date();
  const nowMs = now.getTime();
  const sent: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];

  for (const row of seriesRows || []) {
    const pid = String(row.key).replace(/^series:/, '');
    const data = row.data;
    if (!data || !Array.isArray(data.series)) continue;
    const projSeries = data.series as any[];
    for (const s of projSeries) {
      if (!s || !s.days) continue;
      const targets = (s.targetGroupIds || []).map((id: string) => groups.find((g: any) => g.id === id)).filter(Boolean);
      if (targets.length === 0) { skipped.push(`${pid}/${s.id}:无目标群`); continue; }
      for (const date of Object.keys(s.days)) {
        const day = s.days[date] || {};
        if (day.skip) { continue; }
        const atMs = parseSeriesAt(date, s.time);
        if (isNaN(atMs)) { skipped.push(`${pid}/${s.id}/${date}:时间解析失败`); continue; }
        if (nowMs < atMs) continue;                       // 还没到点
        if (nowMs > atMs + 24 * 3600 * 1000) continue;     // 超过 24h 窗口，跳过

        const sendId = `${pid}:${s.id}:${date}:main`;
        const existingResp = await sbRest(`tn_sends?${q({ id: 'eq.' + sendId, select: '*' })}`);
        const existingRows = existingResp.ok ? await existingResp.json() : [];
        const existing = existingRows[0];
        if (existing && existing.status === 'sent' && existing.sent_at) {
          const sentAtMs = new Date(existing.sent_at).getTime();
          if (sentAtMs >= atMs - 60 * 1000) { continue; } // 已真实发送
        }
        if (existing) { await sbRest(`tn_sends?${q({ id: 'eq.' + sendId })}`, 'DELETE'); }

        if (!(await claim(sendId))) { skipped.push(`${pid}/${s.id}/${date}:已被认领`); continue; }

        let okAll = true; const errs: string[] = [];
        const payload = buildSeriesPayload(day, s);
        for (const g of targets) {
          if (!g.webhookUrl) continue;
          const r = await sendWeCom(g.webhookUrl, payload);
          if (!r.ok) { okAll = false; errs.push(`${g.name}:${r.warn}`); }
        }
        if (okAll) { await markSent(sendId, 'sent'); sent.push(`${pid}/${s.id}/${date}`); }
        else { await markSent(sendId, 'failed', errs.join('; ')); errors.push(`${pid}/${s.id}/${date}: ${errs.join('; ')}`); }
      }
    }
  }

  return { ok: true, runId: RUN_ID, scanned: (seriesRows || []).length, sent, skipped, errors, now: now.toISOString() };
}

// ============ HTTP 入口 ============
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (url.searchParams.get('ping') === '1') {
    return new Response(JSON.stringify({ ok: true, ping: true, ts: Date.now() }), { headers });
  }
  try {
    const result = await main();
    return new Response(JSON.stringify(result), { status: result.ok ? 200 : 500, headers });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 500, headers });
  }
});
