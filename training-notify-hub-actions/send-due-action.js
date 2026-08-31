/**
 * 培训通知助手 — 云端定时发送（GitHub Actions 入口）
 *
 * 作用：脱离本地电脑，由 GitHub Actions 定时读取 Supabase，到点自动发送通知 / 节点提醒。
 * 去重：用 tn_sends 表的 PRIMARY KEY 做原子 claim，本地 Node 与云端不会重复发送。
 *
 * 运行所需环境变量（在仓库 Secrets 中配置，不要写进代码）：
 *   TN_SUPABASE_URL
 *   TN_SUPABASE_SERVICE_ROLE_KEY
 *
 * 频率建议：GitHub Actions cron 最短 5 分钟；本工具用 15~30 分钟一次即可（免费额度友好）。
 * 注意：cron 时间避开整点（如 17/47 分），避免高负载被延迟/丢弃。
 */
const { createClient } = require('@supabase/supabase-js');
const RC = require('./render-core');

const url = process.env.TN_SUPABASE_URL;
const key = process.env.TN_SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('缺少 TN_SUPABASE_URL / TN_SUPABASE_SERVICE_ROLE_KEY，退出。');
  process.exit(1);
}
const sb = createClient(url, key, { auth: { persistSession: false } });
const RUN_ID = `gha-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
console.log('[boot] Node=' + process.version + ' RUN_ID=' + RUN_ID + ' TZ=' + (process.env.TZ || ''));
const AUDIENCES = ['student', 'lecturer', 'manager'];
const AUD_LABEL = { student: '学员', lecturer: '讲师', manager: '管理' };
const NODE_LABEL = { start: '启动', midway: '中程', due: '截止', post: '截止后' };

function iso(d) { return d.toISOString(); }
function addHours(d, h) { return new Date(d.getTime() + h * 3600 * 1000); }

async function sendWeCom(webhook, payload) {
  const resp = await fetch(webhook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const text = await resp.text();
  let ok = resp.ok;
  let warn = '';
  try {
    const j = JSON.parse(text);
    if (j.errcode && j.errcode !== 0) { ok = false; warn = j.errmsg; }
  } catch (e) { if (!resp.ok) warn = text.slice(0, 200); }
  return { ok, warn };
}

async function claim(sendId) {
  // 先查是否已存在（被别人认领）
  const { data: existing } = await sb.from('tn_sends').select('id').eq('id', sendId).single();
  if (existing) return false;
  const { error } = await sb.from('tn_sends').insert({
    id: sendId, status: 'claimed', claimed_by: RUN_ID, claimed_at: iso(new Date())
  });
  if (error) {
    if (error.code === '23505') return false; // 唯一冲突，别人抢到了
    console.error('claim insert error', sendId, error.message);
    return false;
  }
  return true;
}
async function markSent(sendId, status, extra = {}) {
  await sb.from('tn_sends').update({
    status,
    sent_at: status === 'sent' ? iso(new Date()) : null,
    last_error: extra.last_error || null,
    updated_at: iso(new Date())
  }).eq('id', sendId);
}

async function loadKV(key) {
  const { data, error } = await sb.from('tn_kv').select('data').eq('key', key).single();
  if (error || !data) return null;
  return data.data;
}

async function main() {
  const groups = (await loadKV('global_groups')) || [];
  const settings = (await loadKV('app_settings')) || {};
  const reminderWebhook = (settings.reminderWebhook || '').trim();

  const { data: projRows, error } = await sb.from('tn_kv').select('key,data').like('key', 'project:%');
  if (error) { console.error('读取项目失败', error.message); process.exit(1); }

  // 先一次性拉今天所有已 sent 的 tn_sends，用于 reconcile 阶段把 a 补回 n.sentAudiences。
  // tn_sends 表只有 id, status, claimed_by, claimed_at, sent_at, last_error, updated_at；
  // project_id / notification_id / audience 全部从 id 字符串里解析（格式：<pid>:<nid>:<aud>:<phase>）。
  // 这样即使前端 silentSave 用 stale 内存覆盖 tn_kv，下一次 Action 跑也能修复过来。
  const { data: sentRows } = await sb.from('tn_sends').select('id,status').eq('status', 'sent');
  const sentMap = new Map(); // key: projectId::notificationId → Set(audience)
  let totalReconciled = 0;

  console.log('[load] projects=' + (projRows||[]).length + ' groups=' + groups.length + ' sent-history=' + (sentRows||[]).length + ' reminderWebhook=' + (reminderWebhook ? 'set' : 'none'));
  for (const r of (sentRows || [])) {
    const m = /^([^:]+):([^:]+):([^:]+):(main|reminder1d|reminder2h)$/.exec(r.id || '');
    if (!m) continue;
    if (r.status !== 'sent') continue;
    const [, pid, nid, aud] = m;
    const k = pid + '::' + nid;
    if (!sentMap.has(k)) sentMap.set(k, new Set());
    sentMap.get(k).add(aud);
  }

    const now = new Date();
    for (const row of projRows || []) {
      const projectId = row.key.replace(/^project:/, '');
      const project = row.data;
      let changed = false;
      const reasons = { noac:0, disabled:0, noNotifyAt:0, badDate:0, future:0, pastWindow:0, noGroup:0, hit:0 };
      let nodeCount = 0;

      // 阶段 1：扫描 + 发送当前应发的通知
      for (const stage of (project.stages || [])) {
        for (const n of (stage.notifications || [])) {
          nodeCount++;
          // 受众级发送：用 ac.notifyAt 判断窗口，n 自身不需要 notifyAt。
          // 旧逻辑用 n.notifyAt 但数据里只有 ac.notifyAt，导致整批被 continue 跳过、空跑。
          for (const a of AUDIENCES) {
            const ac = (n.audienceContent || {})[a];
            if (!ac) { reasons.noac++; continue; }
            if (!ac.enabled) { reasons.disabled++; continue; }
            if (!ac.notifyAt) { reasons.noNotifyAt++; continue; }
            const at = new Date(ac.notifyAt);
            if (isNaN(at.getTime())) { reasons.badDate++; continue; }
            if (now < at) { reasons.future++; continue; }
            if (now > addHours(at, 24)) { reasons.pastWindow++; continue; }
            if (!(ac.targetGroups || []).length) { reasons.noGroup++; continue; }
            reasons.hit++;

            // 主发送：到点后 24 小时内（GitHub Actions 调度可能延迟 2-8h，6h 窗口会漏发）
            const sendId = `${projectId}:${n.id}:${a}:main`;
            if (await claim(sendId)) {
              const targets = (ac.targetGroups || []).map(id => groups.find(g => g.id === id)).filter(Boolean);
              let okAll = true, errs = [];
              for (const g of targets) {
                if (!g.webhookUrl) continue;
                // 必须在发送前渲染：ac.content 是模板原文，含 {{项目名}}{{培训目的}}{{任务列表}} 等占位符，
                // 不渲染就等于把 "原始模板" 发给群。渲染失败降级原文，宁可发占位符也不阻塞告警。
                let body;
                try { body = RC.renderContent(project, stage, n, ac) || ac.content || ''; }
                catch (e) { body = ac.content || ''; }
                // [v10.4 图文混排] 用 render-core.buildSegmentedMessages 构建多消息数组——
                // 与前端 cloudSend 字节级一致：文本段发 markdown、图片段下载→base64+md5→发 image 消息，
                // 企微按顺序接收自动聚合显示"图文混排"效果。已确认 v10.3 的 template_card 卡片式排版与既定方案不符。
                const msgs = await RC.buildSegmentedMessages(body);
                let groupOk = true, groupErr = null, skippedImgs = [];
                for (const m of msgs) {
                  if (m.msgtype === '__skip_image__') {
                    skippedImgs.push(m.alt + (m.reason ? '（' + m.reason + '）' : ''));
                    continue;
                  }
                  const r = await sendWeCom(g.webhookUrl, m);
                  if (!r.ok) { groupOk = false; groupErr = r.warn; }
                }
                const r = { ok: groupOk, warn: groupErr || (skippedImgs.length ? '已跳过 ' + skippedImgs.length + ' 张图片' : '') };
                if (skippedImgs.length > 0) {
                  console.warn('[send] ' + projectId + '/' + n.id + '/' + a + ' 部分图片跳过：' + skippedImgs.join('、'));
                }
                if (!r.ok) { okAll = false; errs.push(g.name + ':' + r.warn); }
              }
              if (okAll) {
                await markSent(sendId, 'sent');
                n.status = 'sent'; n.sentAt = iso(new Date());
                if (!n.sentAudiences) n.sentAudiences = [];
                if (!n.sentAudiences.includes(a)) n.sentAudiences.push(a);
                console.log('[send] OK   ' + projectId + '/' + n.id + '/' + a + ' groups=' + targets.length);
              } else {
                await markSent(sendId, 'failed', { last_error: errs.join('; ') });
                console.log('[send] FAIL ' + projectId + '/' + n.id + '/' + a + ' ' + errs.join('; '));
              }
              changed = true;
            } else {
              console.log('[send] SKIP-claimed ' + projectId + '/' + n.id + '/' + a);
            }

          // 提醒 T-1 天（确认节点）
          if (!n.reminder1dSentAt && now >= addHours(at, -24) && now < at && reminderWebhook) {
            const sendId = `${projectId}:${n.id}:${a}:reminder1d`;
            if (await claim(sendId)) {
              const content = `【节点确认】${project.projectName || '项目'} · ${stage.name || '阶段'} · ${NODE_LABEL[n.node] || ''}通知（${AUD_LABEL[a]}）\n发送时间：${ac.notifyAt}\n请确认文案与受众已就绪。`;
              const r = await sendWeCom(reminderWebhook, { msgtype: 'markdown', markdown: { content } });
              if (r.ok) { await markSent(sendId, 'sent'); n.reminder1dSentAt = iso(new Date()); console.log('[reminder1d] OK ' + projectId + '/' + n.id + '/' + a); }
              else { await markSent(sendId, 'failed', { last_error: r.warn }); console.log('[reminder1d] FAIL ' + projectId + '/' + n.id + '/' + a + ' ' + r.warn); }
              changed = true;
            }
          }

          // 提醒 T-2 小时（测试版全量）
          if (!n.reminder2hSentAt && now >= addHours(at, -2) && now < at && reminderWebhook) {
            const sendId = `${projectId}:${n.id}:${a}:reminder2h`;
            if (await claim(sendId)) {
              const content = `【发送前测试】${project.projectName || '项目'} · ${stage.name || '阶段'} · ${NODE_LABEL[n.node] || ''}通知（${AUD_LABEL[a]}）将在 ${ac.notifyAt} 发送，以下为测试版全文：\n\n${(() => { try { return RC.renderContent(project, stage, n, ac) || ac.content || ''; } catch (e) { return ac.content || ''; } })()}`;
              const r = await sendWeCom(reminderWebhook, { msgtype: 'markdown', markdown: { content } });
              if (r.ok) { await markSent(sendId, 'sent'); n.reminder2hSentAt = iso(new Date()); console.log('[reminder2h] OK ' + projectId + '/' + n.id + '/' + a); }
              else { await markSent(sendId, 'failed', { last_error: r.warn }); console.log('[reminder2h] FAIL ' + projectId + '/' + n.id + '/' + a + ' ' + r.warn); }
              changed = true;
            }
          }
        }
      }
    }

    // 阶段 2：reconcile — 把 tn_sends 已 sent 的 a 补回 n.sentAudiences / n.sentAt
    // 解决问题：前端 silentSave 用内存里 stale project 写回 cloud 时，可能会把 n.sentAudiences push 后的值
    // 覆盖丢，导致推送概览永远看不到"已发送+实际发送时间"。
    // 这里跨受众无关：tn_sends 是事实源；以它为准回灌项目状态。
    // 拉一次 tn_sends 的 sent_at 字典（key: pid::nid::aud:phase → ISO sent_at），用真实历史回填 n.sentAt
    const { data: sentFullRows } = await sb.from('tn_sends').select('id,sent_at,status').eq('status','sent');
    const sentAtMap = new Map();
    for(const r of (sentFullRows||[])){
      const m = /^([^:]+):([^:]+):([^:]+):(main|reminder1d|reminder2h)$/.exec(r.id||'');
      if(!m) continue;
      if(!r.sent_at) continue;
      sentAtMap.set(r.id, r.sent_at);
    }
    for (const stage of (project.stages || [])) {
      for (const n of (stage.notifications || [])) {
        const sentAuds = sentMap.get(projectId + '::' + n.id);
        if (!sentAuds || sentAuds.size === 0) continue;
        if (!n.sentAudiences) n.sentAudiences = [];
        let nChanged = false;
        for (const a of sentAuds) {
          if (!n.sentAudiences.includes(a)) { n.sentAudiences.push(a); nChanged = true; }
        }
        // 至少有一个 a 进 sentAudiences，就把状态/发送时间对齐（哪怕 n.status 是 draft 也修）
        if (n.sentAudiences.length > 0) {
          if (n.status !== 'sent') { n.status = 'sent'; nChanged = true; }
          // 仅在 sentAt 为空时回填；用 tn_sends 里第一条 main 阶段的真实 sent_at，而不是当前时间
          if (!n.sentAt) {
            const key = projectId + ':' + n.id + ':' + Array.from(sentAuds)[0] + ':main';
            n.sentAt = sentAtMap.get(key) || iso(new Date());
            nChanged = true;
          }
          // 顺手补回 reminder1d/2h 的时间戳（如有）
          const r1key = projectId + ':' + n.id + ':' + Array.from(sentAuds)[0] + ':reminder1d';
          if(sentAtMap.has(r1key) && !n.reminder1dSentAt){ n.reminder1dSentAt = sentAtMap.get(r1key); nChanged = true; }
          const r2key = projectId + ':' + n.id + ':' + Array.from(sentAuds)[0] + ':reminder2h';
          if(sentAtMap.has(r2key) && !n.reminder2hSentAt){ n.reminder2hSentAt = sentAtMap.get(r2key); nChanged = true; }
        }
        if (nChanged) { changed = true; totalReconciled++; }
      }
    }

    console.log('[scan] project=' + projectId + ' nodes=' + nodeCount + ' reasons=' + JSON.stringify(reasons));
    if (changed) {
      await sb.from('tn_kv').update({ data: project, updated_at: iso(new Date()) }).eq('key', row.key);
      console.log('已更新项目', projectId);
    }
  }
  console.log('[reconcile] 回灌 ' + totalReconciled + ' 个通知的 sentAudiences');
  console.log('云端发送任务完成。RUN_ID=', RUN_ID);
}
main().catch(e => { console.error('FATAL', e); process.exit(1); });
