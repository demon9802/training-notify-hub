// Supabase Edge Function: send-v10
// 由前端（EdgeOne 静态版）调用，转发企微 webhook，规避浏览器 CORS / 密钥暴露。
//
// [v10.7.3 根因修复] 此函数已退化为"无脑代理"——payload 由前端 RenderCore.buildNewsPayload
//   构造（items[].payload 字段），本函数只负责 POST webhook 并读回 errcode，不再参与
//   payload 构建。理由：之前 send-v10 内联了一份 buildNewsPayload（news 单 article 模式），
//   与前端 RenderCore 的 markdown_v2 真源不一致，导致 preview（前端 RenderCore）和群内实际
//   （云端 send-v10）出现"卡片式 / ** 字面量 / 图片未渲染"等差异。新流程：
//     1) 前端 RenderCore 构造 payload（单一真源 = 永远 markdown_v2 + inline ![]()）
//     2) send-v10 接收 items[].payload，原样 POST webhook
//     3) 即使 send-v10 部署了旧版 / 未部署，前端也会降级到 no-cors 直发同一 payload
//        → 群内实际 = preview，永远一致
//
// 入参（前端 cloudSend 传入）：
//   { items: [{ webhookUrl, groupName, payload: { msgtype, markdown_v2?:{content}, news?:... } }], testMode: bool }
// 返回：
//   { success: bool, results: [{ groupName, success, error, format }] }
//
// 部署（控制台）：
//   Supabase → Edge Functions → 选中 send-v10 → Code → 粘贴本文件 → Deploy
//
// 说明：
//   - 用 Deno 标准 fetch，无需任何外部库
//   - payload 形态完全由前端 RenderCore 决定（markdown_v2 优先，兼容旧 news 单 article）
//   - 旧版入参（items[].content 无 payload 字段）保留兼容路径，但**新部署必须用 payload 路径**

// ========== 兼容旧版：内联 buildNewsPayload（仅在 items[].payload 缺失时降级使用） ==========
// [v10.7.3] 注：这段代码保留仅为兼容旧版调用方，**新调用方应传 items[].payload**。
//   当 send-v10 部署的是旧版（无 payload 字段支持）时，前端 invoke 会失败 → 降级 no-cors。
//   真正要解决 preview ≠ 群内，必须把本函数升级到新版（接收 payload）。
const SUPABASE_HOST_RE = /^https?:\/\/qyxxchifknfmvvyjvoue\.supabase\.co\/storage\/v1\/object\/public\//;

function extractImgsLegacy(text: string): { alt: string; url: string }[] {
  const arr: { alt: string; url: string }[] = [];
  const re = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    if (SUPABASE_HOST_RE.test(m[2])) arr.push({ alt: m[1] || '图片', url: m[2] });
  }
  return arr;
}

function cleanMarkdownForNewsLegacy(text: string): string {
  if (!text) return '';
  let s = String(text);
  s = s.replace(/!\[[^\]]*\]\(\s*[^)\s]+\s*\)/g, '');
  s = s.replace(/!\[[^\]]*\]/g, '');
  s = s.replace(/\*\*([^*]+)\*\*/g, '$1');
  s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');
  s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return s;
}

function splitTitleDescLegacy(cleaned: string): { title: string; description: string } {
  const lines = cleaned.split(/\n+/);
  const titleRaw = ((lines.shift() || '通知').trim() || '通知');
  const title = titleRaw.length > 64 ? titleRaw.slice(0, 63) + '…' : titleRaw;
  let descriptionRaw = lines.join('\n').trim();
  if (!descriptionRaw) descriptionRaw = cleaned.slice(0, 200).trim();
  return { title, description: descriptionRaw };
}

// 兼容旧版 buildNewsPayload（仅在 items[].payload 缺失时使用）
function buildNewsPayloadLegacy(renderedContent: string, options: { testMode?: boolean; articleUrl?: string }) {
  options = options || {};
  const testMode = !!options.testMode;
  const articleUrl = options.articleUrl || 'https://work.weixin.qq.com/';

  let raw = renderedContent || '';
  if (testMode) raw = '【测试】' + raw;

  const imgs = extractImgsLegacy(raw);
  const cleaned = cleanMarkdownForNewsLegacy(raw);

  if (imgs.length === 0) {
    return { msgtype: 'markdown_v2', markdown_v2: { content: raw } };
  }

  const split = splitTitleDescLegacy(cleaned);
  const mainPic = imgs[0].url;

  let description = split.description;
  if (imgs.length > 1) {
    const moreLinks = imgs.slice(1).map((im, i) => {
      const alt = im.alt || ('图片' + (i + 2));
      return '[查看图片：' + alt + '](' + im.url + ')';
    }).join('\n');
    description = (description ? description + '\n\n' : '') + moreLinks;
  }
  if (description.length > 512) description = description.slice(0, 511) + '…';

  return {
    msgtype: 'news',
    news: {
      articles: [{
        title: split.title,
        description,
        url: articleUrl,
        picurl: mainPic
      }]
    }
  };
}

// ========== 发送（v10.7.3 代理模式） ==========
async function sendOne(item: any, testMode: boolean) {
  const webhookUrl: string = item.webhookUrl;
  const groupName: string = item.groupName || webhookUrl;
  if (!webhookUrl) return { groupName, success: false, error: '缺少 webhookUrl' };

  // [v10.7.3 代理模式] 优先用 items[].payload（前端 RenderCore 真源），不再在云端构造
  let payload: any;
  let format: string;
  if (item.payload && item.payload.msgtype) {
    payload = item.payload;
    format = payload.msgtype;
  } else {
    // 兼容旧版：仅在 payload 缺失时降级为内联 buildNewsPayload（不推荐）
    const articleUrl = item.articleUrl || 'https://work.weixin.qq.com/';
    payload = buildNewsPayloadLegacy(item.content || '', { testMode, articleUrl });
    format = payload.msgtype;
  }

  try {
    const resp = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await resp.text();
    let j: any = null;
    try { j = JSON.parse(text); } catch (_) { /* 非 JSON 响应 */ }
    if (j && j.errcode !== undefined) {
      if (j.errcode === 0) return { groupName, success: true, error: null, format };
      return { groupName, success: false, error: `errcode:${j.errcode} errmsg:${j.errmsg || ''}`, format };
    }
    if (resp.ok) return { groupName, success: true, error: null, format, warning: '非标准 JSON 响应' };
    return { groupName, success: false, error: `HTTP ${resp.status} ${text.slice(0, 100)}`, format };
  } catch (e: any) {
    return { groupName, success: false, error: e.message || String(e), format };
  }
}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  try {
    const { items, testMode } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return new Response(
        JSON.stringify({ success: false, error: '缺少发送项' }),
        { status: 400, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
      );
    }
    const results = [];
    for (const item of items) results.push(await sendOne(item, !!testMode));
    return new Response(
      JSON.stringify({ success: results.every((r) => r.success), results }),
      { status: 200, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  } catch (e: any) {
    return new Response(
      JSON.stringify({ success: false, error: e.message || String(e) }),
      { status: 500, headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' } }
    );
  }
});
