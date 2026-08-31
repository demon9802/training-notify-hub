// Supabase Edge Function: send-v10
// 由前端（EdgeOne 静态版）调用，转发企微 webhook，规避浏览器 CORS / 密钥暴露。
//
// 入参（前端 cloudSend 传入）：
//   { items: [{ webhookUrl, content, groupName, articleUrl? }], testMode: bool }
// 返回：
//   { success: bool, results: [{ groupName, success, error, format }] }
//
// 部署（控制台）：
//   Supabase → Edge Functions → 选中 send-v10 → Code → 粘贴本文件 → Deploy
//
// 说明：
//   - 用 Deno 标准 fetch，无需任何外部库
//   - 直接 inline news 单 article 构建逻辑（与 render-core.buildNewsPayload 行为一致）
//   - 注意：render-core.js 是 CommonJS，不能直接 require；这里内联实现，结构必须与 render-core 严格对齐
//     ——任何修改两处必须同步

// ========== 内联实现（与 render-core.buildNewsPayload 行为一致） ==========
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

// 清理 news description 不渲染的 markdown 语法（与 render-core.cleanMarkdownForNews 字节级一致）
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
  const titleRaw = ((lines.shift() || '通知').trim() || '通知');
  const title = titleRaw.length > 64 ? titleRaw.slice(0, 63) + '…' : titleRaw;
  let descriptionRaw = lines.join('\n').trim();
  if (!descriptionRaw) descriptionRaw = cleaned.slice(0, 200).trim();
  return { title, description: descriptionRaw };
}

// 构建企微发送 payload（news 单 article·图文混排真源，与 render-core.buildNewsPayload 一致）
function buildNewsPayload(renderedContent: string, options: { testMode?: boolean; articleUrl?: string }) {
  options = options || {};
  const testMode = !!options.testMode;
  const articleUrl = options.articleUrl || 'https://work.weixin.qq.com/';

  let raw = renderedContent || '';
  if (testMode) raw = '【测试】' + raw;

  const imgs = extractImgs(raw);
  const cleaned = stripImgs(raw);

  // 无图：markdown_v2
  if (imgs.length === 0) {
    return { msgtype: 'markdown_v2', markdown_v2: { content: raw } };
  }

  // 有图：news 单 article
  const split = splitTitleDesc(cleaned);
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

// ========== 发送 ==========
async function sendOne(item: any, testMode: boolean) {
  const webhookUrl: string = item.webhookUrl;
  const groupName: string = item.groupName || webhookUrl;
  if (!webhookUrl) return { groupName, success: false, error: '缺少 webhookUrl' };

  const articleUrl = item.articleUrl || 'https://work.weixin.qq.com/';
  const payload = buildNewsPayload(item.content || '', { testMode, articleUrl });
  const format = payload.msgtype;

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
    // 非标准 JSON 响应（如 HTML 错误页）：靠 HTTP 状态判断
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
  // CORS preflight：必须返回 null body（204 状态码不允许带 body，否则 Deno 抛错）
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