// Supabase Edge Function: send-v10
// 由前端（EdgeOne 静态版）调用，转发企微 webhook，规避浏览器 CORS / 密钥暴露。
//
// 入参（前端 cloudSend 传入）：
//   { items: [{ webhookUrl, content, groupName }], testMode: bool }
// 返回：
//   { success: bool, results: [{ groupName, success, error, imageResults }] }
//
// 部署（二选一）：
//   A. 控制台：Supabase → Edge Functions → New Function → 名称 send-v10 → 粘贴本文件 → Deploy
//   B. CLI：把本目录放到 supabase/functions/ 下，根目录放 supabase/config.toml，
//           `supabase functions deploy send-v10`
//
// 说明：函数运行在 Supabase 托管运行时，使用 Deno 标准库，无需额外密钥（webhook 由前端传入）。

const encoder = new TextEncoder();

// ---------- 紧凑 md5（WeCom image 消息要求 base64 + md5） ----------
function md5(bytes: Uint8Array): string {
  const s = (n: number) => (n >>> 0).toString(16).padStart(8, '0');
  const K = [
    0xd76aa478,0xe8c7b756,0x242070db,0xc1bdceee,0xf57c0faf,0x4787c62a,0xa8304613,0xfd469501,
    0x698098d8,0x8b44f7af,0xffff5bb1,0x895cd7be,0x6b901122,0xfd987193,0xa679438e,0x49b40821,
    0xf61e2562,0xc040b340,0x265e5a51,0xe9b6c7aa,0xd62f105d,0x02441453,0xd8a1e681,0xe7d3fbc8,
    0x21e1cde6,0xc33707d6,0xf4d50d87,0x455a14ed,0xa9e3e905,0xfcefa3f8,0x676f02d9,0x8d2a4c8a,
    0xfffa3942,0x8771f681,0x6d9d6122,0xfde5380c,0xa4beea44,0x4bdecfa9,0xf6bb4b60,0xbebfbc70,
    0x289b7ec6,0xeaa127fa,0xd4ef3085,0x04881d05,0xd9d4d039,0xe6db99e5,0x1fa27cf8,0xc4ac5665,
    0xf4292244,0x432aff97,0xab9423a7,0xfc93a039,0x655b59c3,0x8f0ccc92,0xffeff47d,0x85845dd1,
    0x6fa87e4f,0xfe2ce6e0,0xa3014314,0x4e0811a1,0xf7537e82,0xbd3af235,0x2ad7d2bb,0xeb86d391,
  ];
  const S = [7,12,17,22,7,12,17,22,7,12,17,22,7,12,17,22,5,9,14,20,5,9,14,20,5,9,14,20,5,9,14,20,4,11,16,23,4,11,16,23,4,11,16,23,4,11,16,23,6,10,15,21,6,10,15,21,6,10,15,21,6,10,15,21];
  const shift = (x: number, n: number) => (x << n) | (x >>> (32 - n));
  const add = (a: number, b: number) => (a + b) & 0xffffffff;
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const len = bytes.length;
  const bitLen = len * 8;
  const withPad = new Uint8Array(((len + 8) & ~0x3f) + 64);
  withPad.set(bytes);
  withPad[len] = 0x80;
  const dv = new DataView(withPad.buffer);
  dv.setUint32(withPad.length - 8, bitLen >>> 0, true);
  dv.setUint32(withPad.length - 4, Math.floor(bitLen / 0x100000000), true);
  for (let off = 0; off < withPad.length; off += 64) {
    const M = new Uint32Array(16);
    for (let i = 0; i < 16; i++) M[i] = dv.getUint32(off + i * 4, true);
    let A = a0, B = b0, C = c0, D = d0;
    for (let i = 0; i < 64; i++) {
      let F: number, g: number;
      if (i < 16) { F = (B & C) | (~B & D); g = i; }
      else if (i < 32) { F = (D & B) | (~D & C); g = (5 * i + 1) % 16; }
      else if (i < 48) { F = B ^ C ^ D; g = (3 * i + 5) % 16; }
      else { F = C ^ (B | ~D); g = (7 * i) % 16; }
      F = add(add(add(F, A), K[i]), M[g]);
      A = D; D = C; C = B; B = add(B, shift(F, S[i]));
    }
    a0 = add(a0, A); b0 = add(b0, B); c0 = add(c0, C); d0 = add(d0, D);
  }
  return s(a0) + s(b0) + s(c0) + s(d0);
}

// ---------- WeCom 发送 ----------
async function wecomMarkdown(webhookUrl: string, content: string): Promise<{ success: boolean; error?: string }> {
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'markdown_v2', markdown_v2: { content } }),
    });
    const j = await r.json();
    if (j.errcode === 0) return { success: true };
    return { success: false, error: `errcode:${j.errcode}, errmsg:${j.errmsg}` };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

async function wecomImage(webhookUrl: string, b64: string, md5hex: string): Promise<{ success: boolean; error?: string }> {
  try {
    const r = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msgtype: 'image', image: { base64: b64, md5: md5hex } }),
    });
    const j = await r.json();
    if (j.errcode === 0) return { success: true };
    return { success: false, error: `errcode:${j.errcode}, errmsg:${j.errmsg}` };
  } catch (e: any) {
    return { success: false, error: e.message || String(e) };
  }
}

function extractImages(content: string): { content: string; imgs: { name: string; url: string }[] } {
  const imgs: { name: string; url: string }[] = [];
  const re = /!\[([^\]]*)\]\((https?:\/\/[^)\s]+)\)/g;
  const cleaned = content.replace(re, (_m, name, url) => {
    imgs.push({ name: name || '图片', url });
    return '';
  });
  const final = cleaned.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return { content: final, imgs };
}

async function sendOne(item: any, testMode: boolean) {
  const webhookUrl: string = item.webhookUrl;
  const groupName: string = item.groupName || webhookUrl;
  if (!webhookUrl) return { groupName, success: false, error: '缺少 webhookUrl' };
  const { content, imgs } = extractImages(item.content || '');
  const prefix = testMode ? '【测试】' : '';
  const body = prefix + content;

  const r = await wecomMarkdown(webhookUrl, body);
  if (!r.success) return { groupName, success: false, error: r.error, imageResults: [] };

  const imageResults: any[] = [];
  for (const img of imgs) {
    try {
      const resp = await fetch(img.url);
      if (!resp.ok) { imageResults.push({ name: img.name, success: false, error: '图片下载失败 ' + resp.status }); continue; }
      const buf = new Uint8Array(await resp.arrayBuffer());
      let binary = '';
      for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
      const b64 = btoa(binary);
      const md5hex = md5(buf);
      const ir = await wecomImage(webhookUrl, b64, md5hex);
      imageResults.push({ name: img.name, success: ir.success, error: ir.error || null });
    } catch (e: any) {
      imageResults.push({ name: img.name, success: false, error: e.message || String(e) });
    }
  }
  const failed = imageResults.filter((x) => !x.success);
  return { groupName, success: true, error: null, imageResults, warning: failed.length ? `${failed.length} 张图片发送失败` : null };
}

Deno.serve(async (req) => {
  // CORS（供前端跨域调用，可选；Supabase Functions 默认允许）
  if (req.method === 'OPTIONS') {
    return new Response('ok', { status: 204, headers: { 'Access-Control-Allow-Origin': '*' } });
  }
  try {
    const { items, testMode } = await req.json();
    if (!Array.isArray(items) || items.length === 0) {
      return new Response(JSON.stringify({ success: false, error: '缺少发送项' }), { status: 400, headers: { 'Content-Type': 'application/json' } });
    }
    const results = [];
    for (const item of items) results.push(await sendOne(item, !!testMode));
    return new Response(JSON.stringify({ success: results.every((r) => r.success), results }), {
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  } catch (e: any) {
    return new Response(JSON.stringify({ success: false, error: e.message || String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
});
