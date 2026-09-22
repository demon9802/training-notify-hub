// Supabase Edge Function: send-due-scheduled
// 云端定时发送（方案 A：替代 GitHub Action 与本地 Node 调度器）
//
// 设计定位：
//   - 这是「定时自动发送」的唯一生产链路，由 pg_cron 每 5 分钟调用一次（见 scheduled-setup.sql）。
//   - 数据真源 = Supabase tn_kv（与 EdgeOne 前端一致）；本地 Node 8788 仅保留手动立即发送 / 预览，不再自动发送。
//   - 用 tn_sends 表主键 claim 做幂等，与任何手动发送 / 其他调度器互不重复。
//
// 与 render-core.js 的一致性（硬约束）：
//   - 下方 buildNewsPayload / cleanMarkdownForNews / extractImgs / splitTitleDesc 必须与
//     render-core.js、send-v10/index.ts 字节级一致（企微 markdown_v2 inline 图文混排真源；news 单 article 已废弃）。
//   - 下方 renderContent / replaceVars 必须与 render-core.js 一致（占位符 5 格式渲染）。
//   - 任何一处修改，其余两处必须同步。
//
// 部署（控制台）：
//   1) Supabase → Edge Functions → New Function → 名称 send-due-scheduled → 粘贴本文件 → Deploy
//   2) 同一函数 → Secrets/Variables 设置 SUPABASE_URL 与 SUPABASE_SERVICE_ROLE_KEY
//   3) SQL Editor 执行 scheduled-setup.sql 建立 pg_cron（每 5 分钟触发 + 保活）
//
// 保活：本函数被 pg_cron 每 5 分钟调用一次，本身就是对项目的 HTTP 访问，足以阻止免费版 7 天暂停；
//       另在 scheduled-setup.sql 中建了 keepalive cron（每 12h，?ping=1）作为双保险。

const SUPABASE_URL = (Deno.env.get('SUPABASE_URL') || '').replace(/\/$/, '');
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
const RUN_ID = `sched-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const AUDIENCES = ['student', 'lecturer', 'manager'];
const AUD_LABEL: Record<string, string> = { student: '学员', lecturer: '讲师', manager: '管理' };
const NODE_LABEL: Record<string, string> = { start: '启动', midway: '中程', due: '截止', post: '截止后' };

// ============ 与 render-core.buildNewsPayload 行为一致（内联） ============
const SUPABASE_HOST_RE = /^https?:\/\/qyxxchifknfmvvyjvoue\.supabase\.co\/storage\/v1\/object\/public\//;

function extractImgs(text: string): { alt: string; url: string }[] {
  const arr: { alt: string; url: string }[] = [];
  const re = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (SUPABASE_HOST_RE.test(m[2])) arr.push({ alt: m[1] || '图片', url: m[2] });
  }
  return arr;
}

function cleanMarkdownForNews(text: string): string {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/!\[[^\]]*\]\(\s*[^)\s]+\s*\)/g, '');
  s = s.replace(/!\[[^\]]*\]/g, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function stripImgs(text: string): string {
  return cleanMarkdownForNews(text);
}

function splitTitleDesc(cleaned: string): { title: string; description: string } {
  const lines = cleaned.split(/\n+/);
  const titleRaw = (lines.shift() || '通知').trim() || '通知';
  const title = titleRaw.length > 64 ? titleRaw.slice(0, 63) + '…' : titleRaw;
  let descriptionRaw = lines.join('\n').trim();
  if (!descriptionRaw) descriptionRaw = cleaned.slice(0, 200).trim();
  return { title, description: descriptionRaw };
}

function buildNewsPayload(renderedContent: string, options: { testMode?: boolean; articleUrl?: string }) {
  options = options || {};
  const testMode = !!options.testMode;

  let raw = renderedContent || '';
  if (testMode) raw = '【测试】' + raw;

  // [v10.7.1] 图文模式 = markdown_v2 + inline ![]() 渲染，不走 news 卡片。
  //   news 单 article 模式被废弃：title/description/picurl + url 强耦合，无法表达"文字流里嵌 N 张图"的版式，
  //   且会把首图当 picurl 提到顶端（用户截图反馈）。
  //   现在一律 markdown_v2：![]() 在 markdown 流里渲染为图片，[t](u) 渲染为可点击链接。
  return { msgtype: 'markdown_v2', markdown_v2: { content: raw } };
}

// ============ 与 render-core.renderContent / replaceVars 行为一致（内联） ============
function safeGet(obj: any, path: string, fallback: string): string {
  if (!obj) return fallback;
  let cur: any = obj;
  const parts = String(path).split('.');
  for (let i = 0; i < parts.length; i++) {
    if (cur == null) return fallback;
    cur = cur[parts[i]];
  }
  return cur == null ? fallback : cur;
}

// [v10.7.2] 日期/时间拼接：仅日期(date) + 可选时间(time) → "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"
function joinDT(date: any, time: any): string {
  if (!date) return '';
  return time ? (date + ' ' + time) : date;
}

function fmtDateTime(s: any): string {
  if (!s) return '';
  const str = String(s).trim();
  // [v10.7.2] 仅日期直接原样返回，避免 UTC 0 点 +8 时区补出 " 08:00"
  if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
  const d = new Date(s);
  if (isNaN(d.getTime())) return s;
  const p = (n: number) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
}

function fmtStageTime(stage: any, project: any): string {
  if (!stage) return '';
  const start = stage.startDate || (project && project.startDate) || '';
  const end = stage.endDate || (project && project.endDate) || '';
  const startT = stage.startTime || '';
  const endT = stage.endTime || '';
  if (start && end) return joinDT(start, startT) + ' ~ ' + joinDT(end, endT);
  return joinDT(start || end, startT || endT);
}

// [v10.7] 与 render-core.renderTaskListMarkdown 字节级一致
function renderTaskListMarkdown(stage: any, ac: any): string {
  if (!stage || !Array.isArray(stage.tasks) || stage.tasks.length === 0) return '';
  const ac2 = ac || {};
  const order = (ac2.taskOrder && ac2.taskOrder.length) ? ac2.taskOrder : stage.tasks.map((t: any) => t.id);
  const picked = new Set(ac2.taskIds || []);
  if (picked.size === 0) return '';
  const lines: string[] = [];
  order.forEach((tid: string, idx: number) => {
    const t = stage.tasks.find((x: any) => x.id === tid);
    if (!t || !picked.has(tid)) return;
    const num = (idx + 1) + '.';
    const name = (t.name || '').trim() || '未命名任务';
    const due = t.dueDate ? '，截止 ' + t.dueDate : '';
    let line = num + ' ' + name + due;
    if (t.description && String(t.description).trim()) {
      line += '\n   说明：' + String(t.description).trim();
    }
    if (Array.isArray(t.attachments)) {
      t.attachments.forEach((a: any) => {
        if (!a || !a.url) return;
        const label = (a.name || '').trim() || (a.type === 'image' ? '图片' : '链接');
        if (a.type === 'image') {
          // [v10.7] 图片附件：用 markdown 图片语法 ![alt](url) 呈现——这样 buildNewsPayload 的 extractImgs
          //   会识别为图，整条通知走 news 单 article 模式（picurl = 第一张图）；不再是 markdown 模式下
          //   被降级为文字链接（用户反复反馈"图片应是图文形式，不是文字链接"）。
          line += '\n   ![附件图片：' + label + '](' + a.url + ')';
        } else {
          // 链接附件：保留 markdown 链接形式 [🔗 文字](url)
          line += '\n   🔗 [' + label + '](' + a.url + ')';
        }
      });
    }
    lines.push(line);
  });
  return lines.length ? lines.join('\n\n') : '';
}

function replaceVars(stage: any, n: any, aud: string, content: string, project: any): string {
  if (!content) return '';
  const ac = ((n.audienceContent || {})[aud]) || {};
  const audienceLabel = AUD_LABEL[aud] || aud;
  const _p: Record<string, string> = {
    项目名: safeGet(project, 'projectName', ''),
    培训目的: safeGet(project, 'purpose', ''),
    // [v10.7.1] v10.html 项目编辑表单字段语义是"整体培训安排"，字段名 overallArrangement。
    //         原 overallPlan 是早期遗留，已统一为 overallArrangement。
    整体安排: safeGet(project, 'overallArrangement', ''),
    项目开始: fmtDateTime(safeGet(project, 'startDate', '')),
    项目结束: fmtDateTime(safeGet(project, 'endDate', '')),
    // [v10.7.1] 负责人：v10.html data-k="owner"，之前 _p 漏注册 → {{负责人}} 渲染为空。
    负责人: safeGet(project, 'owner', ''),
    // [v10.7.1] 阶段字段补全：v10.html 第 2115 行早就有{{阶段开始时间}}{{阶段结束时间}}{{地点/链接}}。
    //   之前 _p 缺这三个，{{地点/链接}} 渲染空白。原「阶段时间」拆为两个独立变量。
    阶段名: safeGet(stage, 'name', ''),
    // [v10.7.2] 阶段时间 = 日期 + 可选具体时间（startTime/endTime 允许为空）
    阶段开始时间: joinDT(safeGet(stage, 'startDate', ''), safeGet(stage, 'startTime', '')),
    阶段结束时间: joinDT(safeGet(stage, 'endDate', ''), safeGet(stage, 'endTime', '')),
    '地点/链接': safeGet(stage, 'placeOrLink', ''),
    节点名: safeGet(n, 'label', ''),
    节点时间: fmtDateTime(safeGet(ac, 'notifyAt', '')),
    受众: audienceLabel,
    文案: safeGet(ac, 'content', ''),
    // [v10.7] 任务列表：用临时占位符占位，最后 .replace() 注入真实 markdown，
    //   避开 markdown 链接 [t](url) 与占位符 5 格式字符冲突
    任务列表: '__TASKLIST_PLACEHOLDER__'
  };
  const getByKey = (k: string) => {
    // [v10.7.3] 未知 key 保留原文（m），不替换为空字符串——避免双重 render 时把渲染产物里的
    //   半角/全角括号误吃（如 `（{{节点时间}}）` 经 patterns[0] 替换后被 patterns[3] 全角括号匹配，
    //   key 变成"2026-08-27 09:00"未知 → 整段变空）。
    if (_p.hasOwnProperty(k)) return _p[k];
    return '__TN_KEEP__';
  };
  // [v10.7.3 关键修复] 先把 markdown 图片/链接语法用临时占位符保护，避免被 patterns[4]
  //   半角括号正则 /\(([^()]+)\)/g 误吃 URL。
  const protectMarkdownSyntax = (text: string) => {
    const IMG_PH = '\u0000TNPIMG\u0000';
    const LINK_PH = '\u0000TNPLNK\u0000';
    const imgStore: string[] = [];
    const linkStore: string[] = [];
    text = text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, function (m: string) {
      imgStore.push(m);
      return IMG_PH + (imgStore.length - 1) + '_';
    });
    text = text.replace(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g, function (m: string) {
      linkStore.push(m);
      return LINK_PH + (linkStore.length - 1) + '_';
    });
    const restore = (t: string) => {
      t = t.replace(new RegExp(IMG_PH + '(\\d+)_', 'g'), function (_: string, i: string) {
        return imgStore[parseInt(i, 10)] || '';
      });
      t = t.replace(new RegExp(LINK_PH + '(\\d+)_', 'g'), function (_: string, i: string) {
        return linkStore[parseInt(i, 10)] || '';
      });
      return t;
    };
    return { text, restore };
  };
  const renderOne = (c: string) => {
    const prot = protectMarkdownSyntax(c);
    let guarded = prot.text;
    const patterns = [
      /\{\{([^{}]+)\}\}/g,
      /「([^」]+)」/g,
      /【([^】]+)】/g,
      /（([^（）]+)）/g,
      /\(([^()]+)\)/g
    ];
    for (let i = 0; i < patterns.length; i++) {
      patterns[i].lastIndex = 0;
      guarded = guarded.replace(patterns[i], (m: string, k: string) => {
        const v = getByKey(String(k).trim());
        return v === '__TN_KEEP__' ? m : v;
      });
    }
    return prot.restore(guarded);
  };
  let out = renderOne(content);
  if (out !== content) {
    let prev;
    for (let i = 0; i < 3; i++) {
      prev = out;
      out = renderOne(out);
      if (out === prev) break;
    }
  }
  // [v10.7] 任务列表：所有占位符替换跑完后注入真实 markdown
  out = out.split('__TASKLIST_PLACEHOLDER__').join(renderTaskListMarkdown(stage, ac));
  return out;
}

function renderContent(project: any, stage: any, n: any, ac: any): string {
  if (!ac) return '';
  const aud = ac.audience || n.audience || 'student';
  const nWithProj = (project && (!n._project || n._project !== project))
    ? Object.assign({}, n, { _project: project })
    : n;
  return replaceVars(stage, nWithProj, aud, ac.content || '', project);
}

// ============ Supabase REST 封装（零外部依赖，与 send-v10 风格一致） ============
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
  // 成功 = 认领到；409/错误 = 别人已认领（或被手动发送标记），视为已处理，跳过
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

// ============ 主流程 ============
async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    return { ok: false, error: '缺少 SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY（请在 Edge Function Secrets 中设置）' };
  }

  const groups = (await loadKV('global_groups')) || [];
  const settings = (await loadKV('app_settings')) || {};
  const reminderWebhook = (settings.reminderWebhook || '').trim();

  // PostgREST 的 like 通配符是 *（不是 %，% 会直接 500）。用 *project* 匹配所有 project: 前缀的键。
  const projResp = await sbRest(`tn_kv?${q({ select: 'key,data', key: 'like.*project*' })}`);
  if (!projResp.ok) return { ok: false, error: '读取项目失败: ' + projResp.status };
  const projRows = await projResp.json();

  // 读取已 sent 的 tn_sends，用于 reconcile 回灌 n.sentAudiences
  const sentResp = await sbRest(`tn_sends?${q({ select: 'id,status,sent_at', status: 'eq.sent' })}`);
  const sentRows = sentResp.ok ? await sentResp.json() : [];
  const sentMap = new Map<string, Set<string>>(); // key: pid::nid → Set(aud)
  const sentAtMap = new Map<string, string>();      // key: sendId → sent_at
  for (const r of sentRows || []) {
    const m = /^([^:]+):([^:]+):([^:]+):(main|reminder1d|reminder2h)$/.exec(r.id || '');
    if (!m) continue;
    if (r.status !== 'sent') continue;
    const [, pid, nid, aud] = m;
    const k = pid + '::' + nid;
    if (!sentMap.has(k)) sentMap.set(k, new Set());
    sentMap.get(k)!.add(aud);
    if (r.sent_at) sentAtMap.set(r.id, r.sent_at);
  }

  const now = new Date();
  const sent: string[] = [];
  const skipped: string[] = [];
  const errors: string[] = [];
  let totalReconciled = 0;

  for (const row of projRows || []) {
    const projectId = String(row.key).replace(/^project:/, '');
    const project = row.data;
    if (!project || !Array.isArray(project.stages)) continue;
    let changed = false;

    // 阶段 1：扫描并发送当前应发的通知
    for (const stage of project.stages) {
      for (const n of (stage.notifications || [])) {
        for (const a of AUDIENCES) {
          const ac = (n.audienceContent || {})[a];
          if (!ac || !ac.enabled) continue;
          if (!ac.notifyAt) continue;
          const at = new Date(ac.notifyAt);
          if (isNaN(at.getTime())) continue;
          if (now < at) continue;                                   // 未到点
          if (now.getTime() > at.getTime() + 24 * 3600 * 1000) continue; // 超过 24h 窗口
          if (!(ac.targetGroups || []).length) { skipped.push(`${projectId}/${n.id}/${a}:无目标群`); continue; }
          // 已被前端手动发送标记过 → 跳过（与 tn_sends claim 双重防重发）
          if ((n.sentAudiences || []).includes(a)) continue;

          const sendId = `${projectId}:${n.id}:${a}:main`;
          if (!(await claim(sendId))) { skipped.push(`${projectId}/${n.id}/${a}:已被认领`); continue; }

          const targets = (ac.targetGroups || []).map((id: string) => groups.find((g: any) => g.id === id)).filter(Boolean);
          let okAll = true; const errs: string[] = [];
          for (const g of targets) {
            if (!g.webhookUrl) continue;
            let body = '';
            try { body = renderContent(project, stage, n, ac) || ac.content || ''; }
            catch (e) { body = ac.content || ''; }
            const articleUrl = (stage && (stage.viewUrl || stage.url)) || (project && (project.viewUrl || project.url)) || 'https://work.weixin.qq.com/';
            const payload = buildNewsPayload(body, { articleUrl });
            const r = await sendWeCom(g.webhookUrl, payload);
            if (!r.ok) { okAll = false; errs.push(`${g.name}:${r.warn}`); }
          }
          if (okAll) {
            await markSent(sendId, 'sent');
            n.status = 'sent'; n.sentAt = new Date().toISOString();
            if (!n.sentAudiences) n.sentAudiences = [];
            if (!n.sentAudiences.includes(a)) n.sentAudiences.push(a);
            sent.push(`${projectId}/${n.id}/${a}`);
          } else {
            await markSent(sendId, 'failed', errs.join('; '));
            errors.push(`${projectId}/${n.id}/${a}: ${errs.join('; ')}`);
          }
          changed = true;

          // 提醒 T-1 天（确认节点）
          if (!n.reminder1dSentAt && now >= new Date(at.getTime() - 24 * 3600 * 1000) && now < at && reminderWebhook) {
            const rid = `${projectId}:${n.id}:${a}:reminder1d`;
            if (await claim(rid)) {
              const content = `【节点确认】${project.projectName || '项目'} · ${stage.name || '阶段'} · ${NODE_LABEL[n.node as string] || ''}通知（${AUD_LABEL[a]}）\n发送时间：${ac.notifyAt}\n请确认文案与受众已就绪。`;
              const r = await sendWeCom(reminderWebhook, { msgtype: 'markdown', markdown: { content } });
              if (r.ok) { await markSent(rid, 'sent'); n.reminder1dSentAt = new Date().toISOString(); }
              else { await markSent(rid, 'failed', r.warn); }
              changed = true;
            }
          }
          // 提醒 T-2 小时（测试版全量）
          if (!n.reminder2hSentAt && now >= new Date(at.getTime() - 2 * 3600 * 1000) && now < at && reminderWebhook) {
            const rid = `${projectId}:${n.id}:${a}:reminder2h`;
            if (await claim(rid)) {
              const content = `【发送前测试】${project.projectName || '项目'} · ${stage.name || '阶段'} · ${NODE_LABEL[n.node as string] || ''}通知（${AUD_LABEL[a]}）将在 ${ac.notifyAt} 发送，以下为测试版全文：\n\n${renderContent(project, stage, n, ac) || ac.content || ''}`;
              const r = await sendWeCom(reminderWebhook, { msgtype: 'markdown', markdown: { content } });
              if (r.ok) { await markSent(rid, 'sent'); n.reminder2hSentAt = new Date().toISOString(); }
              else { await markSent(rid, 'failed', r.warn); }
              changed = true;
            }
          }
        }
      }
    }

    // 阶段 2：reconcile — 把 tn_sends 已 sent 的受众补回 n.sentAudiences / n.sentAt
    for (const stage of project.stages) {
      for (const n of (stage.notifications || [])) {
        const sa = sentMap.get(projectId + '::' + n.id);
        if (!sa || sa.size === 0) continue;
        if (!n.sentAudiences) n.sentAudiences = [];
        let nChanged = false;
        for (const a of sa) if (!n.sentAudiences.includes(a)) { n.sentAudiences.push(a); nChanged = true; }
        if (n.sentAudiences.length > 0) {
          if (n.status !== 'sent') { n.status = 'sent'; nChanged = true; }
          if (!n.sentAt) { n.sentAt = sentAtMap.get(`${projectId}:${n.id}:${Array.from(sa)[0]}:main`) || new Date().toISOString(); nChanged = true; }
        }
        if (nChanged) { changed = true; totalReconciled++; }
      }
    }

    if (changed) {
      await sbRest(`tn_kv?${q({ key: 'eq.' + row.key })}`, 'PATCH', { data: project, updated_at: new Date().toISOString() });
    }
  }

  return { ok: true, runId: RUN_ID, scanned: (projRows || []).length, sent, skipped, errors, reconciled: totalReconciled };
}

// ============ HTTP 入口 ============
Deno.serve(async (req) => {
  const url = new URL(req.url);
  const headers = { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' };

  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });

  // 保活探测：pg_cron keepalive 用 ?ping=1 调用，立即返回，不做任何发送
  if (url.searchParams.get('ping') === '1') {
    return new Response(JSON.stringify({ ok: true, ping: true, ts: Date.now() }), { headers });
  }

  try {
    const result = await main();
    return new Response(JSON.stringify(result), {
      status: result.ok ? 200 : 500,
      headers
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ ok: false, error: String(e && e.message || e) }), { status: 500, headers });
  }
});
