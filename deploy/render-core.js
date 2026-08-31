/**
 * 培训通知助手 — 渲染核心（单一数据源）
 *
 * 这是 v10.html::replaceVars / training-notification-server.js::renderContent /
 * send-due-action.js::renderContent 三处逻辑的【唯一真源】。
 *
 * 之前三处各写一份，极易在改一处时另一处"悄悄变回去"或格式分叉，导致：
 *   - 推送概览/预览显示 {{项目名}} 而非真实值
 *   - 前端预览与企微实际发送文案不一致
 * 现在统一抽到此处，三处都 require / 加载本模块，从此改一处即全局生效。
 *
 * 用法：
 *   Node  : const RC = require('./render-core');  RC.renderContent(...)
 *   浏览器: <script src="/render-core.js"></script>  ->  window.RenderCore.replaceVars(...)
 *
 * 关键约定（三处必须一致，已在此固化）：
 *   - NBSP2 = 2 个 U+00A0，做任务缩进；禁用 NBSP3/4 与普通空格。
 *   - 读取项目字段一律 `(_p && _p.xxx) || 兜底`，避免跨项目预览时 _p 为 undefined 抛错。
 *   - 支持 5 种占位符写法：{{key}} 「key」 【key】 （key） (key)。
 *   - paste 模式（inputMode==='paste'）原样返回，不做任何替换。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RenderCore = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var NBSP2 = '  '; // 2 × U+00A0 (NBSP). 紧贴任务名文本，0.5 em/字符 × 2 = 1 em 缩进 = 与编号后首字对齐

  function linkifyUrl(s) {
    if (!s) return '';
    return String(s).replace(/(https?:\/\/[^\s]+)/g, '[$1]($1)');
  }

  function fmtDateTime(dateStr, timeStr) {
    var s = dateStr || '';
    if (timeStr) s += (s ? ' ' : '') + timeStr;
    return s || '';
  }

  function fmtStageTime(s) {
    var start = fmtDateTime(s.startDate, s.startTime);
    var end = fmtDateTime(s.endDate, s.endTime);
    if (!start && !end) return '（未设定）';
    if (!end) return start;
    if (!start) return end;
    return start + ' ~ ' + end;
  }

  // 任务列表算法（三处完全一致）：
  //   - 勾选 = 显式选定的任务；取消勾选（全空）= 通知中不包含学习任务，渲染为 (无)
  //   - 2026-08-27 之前误改为"空 = 全量代入"（怕出现 (无)），与用户预期相反；现回正
  //   - taskOrder 仅排序，且仅在命中 baseTasks 时使用；taskOrder 缺失 / 全是无效 ID（脏数据）→ 用 baseTasks 天然顺序
  function resolveTasks(stage, ac) {
    var stageTasks = stage.tasks || [];
    var taskIdsArr = Array.isArray(ac.taskIds) ? ac.taskIds : [];
    if (taskIdsArr.length === 0) return [];   // 不勾 → 通知中不带学习任务，渲染时显示 (无)
    var baseTasks = stageTasks.filter(function (t) { return taskIdsArr.indexOf(t.id) !== -1; });
    var order = Array.isArray(ac.taskOrder) ? ac.taskOrder : [];
    var orderHits = order.filter(function (id) { return baseTasks.some(function (t) { return t.id === id; }); });
    var tasks;
    if (orderHits.length > 0) {
      tasks = order.map(function (id) { return baseTasks.find(function (t) { return t.id === id; }); }).filter(Boolean);
    } else {
      tasks = baseTasks;
    }
    return tasks;
  }

  function formatAtt(a, indent) {
    if (!a || !a.url) return '';
    var name = a.name || (a.type === 'image' ? '图片' : '链接');
    if (a.type === 'image') return indent + name + '\n' + indent + '![' + name + '](' + a.url + ')';
    var linkText = a.linkText || a.url;
    return indent + name + '[' + linkText + '](' + a.url + ')';
  }

  function buildTaskLines(stage, ac) {
    var tasks = resolveTasks(stage, ac);
    var taskLines = tasks.map(function (t, i) {
      var line = (i + 1) + '. ' + (t.name || '未命名任务') + (t.dueDate ? '（截止 ' + t.dueDate + '）' : '');
      if (t.description) {
        var desc = String(t.description).replace(/\r\n?/g, '\n');
        line += '\n' + NBSP2 + desc.split('\n').join('\n' + NBSP2);
      }
      var attLines = (t.attachments || []).map(function (a) { return formatAtt(a, NBSP2); }).filter(Boolean).join('\n');
      if (attLines) line += '\n' + attLines;
      return line;
    }).join('\n') || '（无）';
    var attLines = tasks.map(function (t) {
      return (t.attachments || []).map(function (a) {
        if (!a.url) return '';
        var name = a.name || (a.type === 'image' ? '图片' : '链接');
        if (a.type === 'image') return '- ' + name + '\n  ![' + name + '](' + a.url + ')';
        return '- ' + name + '[' + (a.linkText || name) + '](' + a.url + ')';
      }).filter(Boolean).join('\n');
    }).filter(Boolean).join('\n') || '（无）';
    return { taskLines: taskLines, attLines: attLines };
  }

  function buildReplacers(stage, _p, ac) {
    var both = buildTaskLines(stage, ac);
    var taskLines = both.taskLines;
    var attLines = both.attLines;
    var dt = ac.notifyAt
      ? new Date(ac.notifyAt).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
      : '（未设定）';
    // stageList 必须用 _p（项目级），跨项目预览时取传入项目的阶段，而非编辑中项目
    var stageList = ((_p && _p.stages) || []).map(function (s, i) {
      return (i + 1) + '. ' + (s.name || '阶段 ' + (i + 1)) +
        (s.startDate || s.endDate ? '（' + (s.startDate || '') + (s.endDate ? ' ~ ' + s.endDate : '') + '）' : '');
    }).join('\n');
    var placeOrLink = stage.placeOrLink || '';
    var placeOrLinkLinked = linkifyUrl(placeOrLink);
    return {
      '项目名': (_p && _p.projectName) || '（未命名项目）',
      '负责人': (_p && _p.owner) || '',
      '培训目的': (_p && _p.purpose) || '',
      '项目描述': (_p && _p.description) || '',
      '整体安排': (_p && _p.overallArrangement) || '',
      '项目开始': (_p && _p.startDate) || '',
      '项目结束': (_p && _p.endDate) || '',
      '阶段名': stage.name || '',
      '阶段开始日': stage.startDate || '',
      '阶段结束日': stage.endDate || '',
      '阶段开始时间': fmtDateTime(stage.startDate, stage.startTime) || '（未设定）',
      '阶段结束时间': fmtDateTime(stage.endDate, stage.endTime) || '（未设定）',
      '阶段时间': fmtStageTime(stage),
      '预期时间': fmtStageTime(stage),
      '培训类型': stage.trainingType === 'online' ? '线上' : stage.trainingType === 'offline' ? '线下' : '',
      '线上链接': stage.meetingLink || '',
      '线下场地': stage.venue || '',
      '地点/链接': placeOrLinkLinked,
      '任务列表': taskLines,
      '附件列表': attLines,
      '发送时间': dt,
      '阶段列表': stageList
    };
  }

  function runReplacements(raw, replacers) {
    var out = raw;
    var entries = Object.keys(replacers);
    for (var i = 0; i < entries.length; i++) {
      var key = entries[i];
      var safe = String(replacers[key]);
      out = out.replace(new RegExp('\\{\\{' + key + '\\}\\}', 'g'), safe);
      out = out.replace(new RegExp('「' + key + '」', 'g'), safe);
      out = out.replace(new RegExp('【' + key + '】', 'g'), safe);
      out = out.replace(new RegExp('（' + key + '）', 'g'), safe); // 全角圆括号
      out = out.replace(new RegExp('\\(' + key + '\\)', 'g'), safe);    // 半角圆括号
    }
    return out;
  }

  // 三处统一的替换执行体：paste 模式原样返回；否则按 replacers + 5 格式替换
  function applyReplacements(stage, _p, ac, raw) {
    if (!raw) return raw;
    if (ac && ac.inputMode === 'paste') return raw;
    var replacers = buildReplacers(stage, _p, ac);
    return runReplacements(raw, replacers);
  }

  // 前端入口（v10.html::replaceVars 等价）：从 n.audienceContent[aud] 取 ac
  function replaceVars(stage, n, aud, content, proj) {
    if (!content) return content;
    var ac = (n && n.audienceContent && n.audienceContent[aud]) || {};
    return applyReplacements(stage, proj || {}, ac, content);
  }

  // 后端入口（server.js / send-due-action.js::renderContent 等价）：ac 直接传入
  function renderContent(project, stage, n, ac) {
    if (!ac) return '';
    var raw = ac.content || '';
    if (!raw) return '';
    return applyReplacements(stage, project || {}, ac, raw);
  }

  // ---------- 统一发送 payload 构建（前端 cloudSend + Action send-due 共用） ----------
  // 关键约束（v10.4 恢复图文混排）：
  //   企微 webhook 的 markdown msgtype **不支持**内嵌图片（`![alt](url)` 会被降级为 `[alt](url)` 文字链接）。
  //   要实现"图片按文中位置嵌在文字中间"的【图文混排】效果，唯一可行方案是【多条消息顺序发送】：
  //     - 文本段落：msgtype='markdown'，content = 该段纯文本
  //     - 图片段落：msgtype='image'，image = { base64, md5 }  (需先下载图、转 base64、算 MD5)
  //   企微会按发送顺序把同一 bot 的连续消息聚合显示在群里，对外呈现"图文混排"。
  //   template_card（单条大图+标题+描述卡片）不是图文混排，是卡片式排版，与用户既定方案不一致。
  var SUPABASE_HOST_RE = /^https?:\/\/qyxxchifknfmvvyjvoue\.supabase\.co\/storage\/v1\/object\/public\//;

  function extractImgs(text) {
    var arr = [];
    var re = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (SUPABASE_HOST_RE.test(m[2])) arr.push({ alt: m[1] || '图片', url: m[2] });
    }
    return arr;
  }

  // 把渲染后的内容切分成「按出现顺序」的 text / image 段，是 buildSegmentedMessages / renderSegmentedPreview 共用的真源
  // 返回: [{ type:'text'|'image', text?, alt?, url? }]
  function splitIntoSegments(content) {
    var segs = [];
    if (!content) return segs;
    var re = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
    var lastIdx = 0;
    var m;
    while ((m = re.exec(content)) !== null) {
      if (m.index > lastIdx) {
        segs.push({ type: 'text', text: content.slice(lastIdx, m.index) });
      }
      segs.push({ type: 'image', alt: m[1] || '图片', url: m[2] });
      lastIdx = m.index + m[0].length;
    }
    if (lastIdx < content.length) {
      segs.push({ type: 'text', text: content.slice(lastIdx) });
    }
    return segs;
  }

  // 同步：Uint8Array -> base64 / MD5（Node 与浏览器双环境）
  function uint8ToBase64(buf) {
    if (typeof Buffer !== 'undefined' && Buffer.from) {
      return Buffer.from(buf).toString('base64');
    }
    var bin = '';
    for (var i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
    return btoa(bin);
  }
  function uint8ToMd5Hex(buf) {
    // Node（Action）：用 crypto
    if (typeof require === 'function') {
      try {
        var crypto = require('crypto');
        if (crypto && crypto.createHash) {
          return crypto.createHash('md5').update(Buffer.from(buf)).digest('hex');
        }
      } catch (e) { /* fall through to browser */ }
    }
    // 浏览器：复用 md5-lite.min.js 暴露的 md5 全局（<script src="md5-lite.min.js">）
    if (typeof md5 === 'function') {
      return md5(Array.prototype.slice.call(buf));
    }
    throw new Error('MD5 not available: 浏览器需先加载 md5-lite.min.js；Node 需可访问 crypto');
  }

  // 构建企微发送的"多消息数组"（图文混排真源）
  // 参数: renderedContent = 已替换占位符的最终文案
  // options: {
  //   testMode: bool,           // 测试模式：在首段前加【测试】
  //   fetchImpl: Function,      // 可选：自定义 fetch（Node 18+ 全局 fetch 可用；测试可注入 mock）
  //   downloadImages: bool,     // 是否下载图片转 base64+md5（默认 true；设为 false 时图片段会被跳过，节省带宽）
  // }
  // 返回: Promise<Array<WeComMessage>> —— 每条 msgtype ∈ {markdown, image}
  // 抛出网络错误时，整段降级为：图片段用 __skip_image__ 标记（不抛错，调用方可决定如何处理）
  async function buildSegmentedMessages(renderedContent, options) {
    options = options || {};
    var testMode = !!options.testMode;
    var downloadImages = options.downloadImages !== false;
    var fetchImpl = options.fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);

    var raw = renderedContent || '';
    if (testMode) raw = '【测试】' + raw;
    var segs = splitIntoSegments(raw);

    var out = [];
    for (var i = 0; i < segs.length; i++) {
      var seg = segs[i];
      if (seg.type === 'text') {
        var t = (seg.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (t) out.push({ msgtype: 'markdown', markdown: { content: t } });
      } else if (seg.type === 'image') {
        if (!downloadImages) {
          out.push({ msgtype: '__skip_image__', alt: seg.alt, url: seg.url, reason: 'downloadImages=false' });
          continue;
        }
        if (!fetchImpl) {
          out.push({ msgtype: '__skip_image__', alt: seg.alt, url: seg.url, reason: 'no fetchImpl' });
          continue;
        }
        try {
          var resp = await fetchImpl(seg.url);
          if (!resp.ok) {
            out.push({ msgtype: '__skip_image__', alt: seg.alt, url: seg.url, reason: 'HTTP ' + resp.status });
            continue;
          }
          var buf = new Uint8Array(await resp.arrayBuffer());
          out.push({
            msgtype: 'image',
            image: { base64: uint8ToBase64(buf), md5: uint8ToMd5Hex(buf) },
            meta: { alt: seg.alt, url: seg.url, bytes: buf.length }
          });
        } catch (e) {
          out.push({ msgtype: '__skip_image__', alt: seg.alt, url: seg.url, reason: (e && e.message) || String(e) });
        }
      }
    }
    return out;
  }

  // 前端预览渲染：把分段数组渲染成所见即所得的 HTML
  // 视觉上对齐企微实际呈现：每段独立气泡（text 用 markdown 渲染，image 用 <img> 标签）
  function renderSegmentedPreview(segments) {
    if (!segments || segments.length === 0) return '<span class="sub">（空）</span>';
    var html = '';
    for (var i = 0; i < segments.length; i++) {
      var seg = segments[i];
      if (seg.type === 'text') {
        var t = (seg.text || '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
        if (t) html += '<div class="seg-msg seg-text">' + renderMdPreview(t) + '</div>';
      } else if (seg.type === 'image') {
        html += '<div class="seg-msg seg-image"><img src="' + esc(seg.url) + '" alt="' + esc(seg.alt || '图片') + '"></div>';
      }
    }
    return html || '<span class="sub">（空）</span>';
  }

  // v10.3 临时方案：buildTemplateCard + renderTemplateCardPreview 保留为 legacy 导出，
  // 防止外部代码误用；新代码请用 buildSegmentedMessages + renderSegmentedPreview。

  // 把 markdown 里的图片语法移除并规整空白（template_card legacy 路径用）
  function stripImgs(text) {
    return text.replace(/!\[([^\]]*)\]\(\s*[^)\s]+\s*\)/g, '')
               .replace(/[ \t]+\n/g, '\n')
               .replace(/\n{3,}/g, '\n\n')
               .trim();
  }
  function buildTemplateCard(renderedContent, options) {
    options = options || {};
    var testMode = !!options.testMode;
    var articleUrl = options.articleUrl || 'https://work.weixin.qq.com/';

    var raw = renderedContent || '';
    if (testMode) raw = '【测试】' + raw;

    var imgs = extractImgs(raw);
    var cleaned = stripImgs(raw);

    if (imgs.length === 0) {
      return { msgtype: 'markdown', markdown: { content: raw } };
    }

    var lines = cleaned.split(/\n+/);
    var title = ((lines.shift() || '通知').trim() || '通知').slice(0, 64);
    var desc = (lines.join('\n').trim() || cleaned.slice(0, 200)).slice(0, 512);

    return {
      msgtype: 'template_card',
      template_card: {
        card_type: 'image_text',
        main_title: { title: title, desc: '' },
        card_image: { url: imgs[0].url, aspect_ratio: 1.3 },
        sub_title_text: desc,
        card_action: { type: 1, url: articleUrl }
      }
    };
  }

  function renderTemplateCardPreview(payload) {
    if (!payload) return '<span class="sub">（空）</span>';
    if (payload.msgtype === 'markdown') {
      return renderMdPreview(payload.markdown && payload.markdown.content);
    }
    if (payload.msgtype === 'template_card' && payload.template_card) {
      var card = payload.template_card;
      var html = '<div class="tpl-card">';
      if (card.card_image && card.card_image.url) {
        html += '<div class="tpl-card-image"><img src="' + esc(card.card_image.url) + '" alt=""></div>';
      }
      if (card.main_title && (card.main_title.title || card.main_title.desc)) {
        html += '<div class="tpl-card-title">' + esc(card.main_title.title || '') +
                (card.main_title.desc ? '<div class="tpl-card-titledesc">' + esc(card.main_title.desc) + '</div>' : '') +
                '</div>';
      }
      if (card.sub_title_text) {
        html += '<div class="tpl-card-subtitle">' + esc(card.sub_title_text).replace(/\n/g, '<br>') + '</div>';
      }
      html += '</div>';
      return html;
    }
    return '<span class="sub">（未知格式）</span>';
  }

  // ---------- 前端预览用：markdown → HTML ----------
  function esc(s) {
    return (s || '').replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }
  function renderMdPreview(md) {
    if (!md) return '<span class="sub">（空）</span>';
    var html = esc(md);
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, url) {
      return '<img src="' + esc(url) + '" alt="' + esc(alt) + '">';
    });
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, t, u) {
      return '<a href="' + esc(u) + '" target="_blank">' + esc(t) + '</a>';
    });
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  return {
    NBSP2: NBSP2,
    replaceVars: replaceVars,
    renderContent: renderContent,
    renderMdPreview: renderMdPreview,
    // v10.4 图文混排（新真源，前端 + Action 共用）
    splitIntoSegments: splitIntoSegments,
    buildSegmentedMessages: buildSegmentedMessages,
    renderSegmentedPreview: renderSegmentedPreview,
    // v10.3 临时方案（legacy，保留避免外部代码误用）
    renderTemplateCardPreview: renderTemplateCardPreview,
    buildTemplateCard: buildTemplateCard,
    extractImgs: extractImgs,
    stripImgs: stripImgs,
    esc: esc,
    linkifyUrl: linkifyUrl,
    fmtDateTime: fmtDateTime,
    fmtStageTime: fmtStageTime
  };
});
