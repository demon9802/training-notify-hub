// render-core.js — 培训通知助手·渲染/构建真源（Node + 浏览器共用）
//
// 单一真源原则：所有发送路径必须共用同一套构建逻辑：
//   1) 前端 cloudSend（Edge Function 调用 / no-cors 降级）
//   2) Edge Function send-v10（云端转发企微）
//   3) GitHub Action send-due（定时调度）
// 三处 payload 必须字节级一致 → 群里实际收到的 = 预览看到的。
//
// 关键约束（企微 API 硬限制）：
//   - markdown / markdown_v2 都不支持内嵌图片（![alt](url) 会被降级成文字链接）
//   - 要实现"一条通知·图文混排"（大图占顶 + 多行文字描述）→ 必须 msgtype='news'
//     单 article = title (≤64) + description (≤512, 含 \n/列表/链接) + picurl (1 张) + url (跳转)
//   - picurl 是 URL，企微服务器直接抓——前端/Edge Function 不需要下载转 base64
//   - v10.3 / v10.4 试过的 template_card（卡片式）/ 分段发送（多消息聚合）均与既定方案不符，
//     已废弃。v10.5 统一回归 news 单 article。

(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.RenderCore = factory();
  }
})(typeof globalThis !== 'undefined' ? globalThis : (typeof window !== 'undefined' ? window : this), function () {

  // ---------- 基础常量 ----------
  // NBSP2：2×U+00A0，是目前唯一能对齐编号后文字+说明的方案（U+3000/U+2003 过宽）
  var NBSP2 = '  ';

  // 仅匹配 Supabase Storage 公网 URL（避免误把别的图当成本系统图）
  var SUPABASE_HOST_RE = /^https?:\/\/qyxxchifknfmvvyjvoue\.supabase\.co\/storage\/v1\/object\/public\//;

  // ---------- 工具函数 ----------
  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function linkifyUrl(s) {
    if (!s) return s;
    var re = /(https?:\/\/[^\s<>"]+)/g;
    return String(s).replace(re, function (u) { return '[' + u + '](' + u + ')'; });
  }

  function fmtDateTime(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return s;
    var p = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtStageTime(stage, project) {
    // 项目级"开始/结束"时间渲染；缺失字段返回空串（不显示）
    if (!stage) return '';
    var start = stage.startDate || (project && project.startDate) || '';
    var end = stage.endDate || (project && project.endDate) || '';
    if (start && end) return fmtDateTime(start) + ' ~ ' + fmtDateTime(end);
    return fmtDateTime(start || end);
  }

  // ---------- 变量替换（占位符渲染） ----------
  // 占位符 5 种格式都支持：{{key}} / 「key」 / 【key】 / （key）全角 / (key)半角
  // _p.xxx 链式访问 → 必须 `(_p && _p.xxx) || '兜底'` 短路防 undefined 报错
  function safeGet(obj, path, fallback) {
    if (!obj) return fallback;
    var cur = obj;
    var parts = String(path).split('.');
    for (var i = 0; i < parts.length; i++) {
      if (cur == null) return fallback;
      cur = cur[parts[i]];
    }
    return cur == null ? fallback : cur;
  }

  function replaceVars(stage, n, aud, content) {
    if (!content) return '';
    // [v10.5] 不再硬编码 state.project——浏览器 / Node 双环境都能用
    // 浏览器从全局 state 取；Node 端（如 GitHub Action）从传入的 n 上下文推断（n._project 由调用方注入）
    var project = (typeof state !== 'undefined' && state.project) ||
                  (typeof window !== 'undefined' && window.state && window.state.project) ||
                  (n && n._project) ||
                  (stage && stage._project) ||
                  null;
    var ac = ((n.audienceContent || {})[aud]) || {};
    var audienceLabel = { student: '学员', lecturer: '讲师', manager: '管理' }[aud] || aud;

    var _p = {
      项目名: safeGet(project, 'projectName', ''),
      培训目的: safeGet(project, 'purpose', ''),
      培训类型: safeGet(project, 'type', ''),
      整体安排: safeGet(project, 'overallPlan', ''),
      项目开始: fmtDateTime(safeGet(project, 'startDate', '')),
      项目结束: fmtDateTime(safeGet(project, 'endDate', '')),
      阶段名: safeGet(stage, 'name', ''),
      阶段时间: fmtStageTime(stage, project),
      节点名: safeGet(n, 'label', ''),
      节点时间: fmtDateTime(safeGet(ac, 'notifyAt', '')),
      受众: audienceLabel,
      文案: safeGet(ac, 'content', '')
    };

    function getByKey(k) {
      if (_p.hasOwnProperty(k)) return _p[k];
      return '';
    }

    function renderOne(content) {
      // 5 种占位符格式都尝试；短变量名（驼峰 + 短中文）都支持
      // [v10.5 关键修复] String.replace 不支持 regex 数组参数，必须逐个 replace；
      // 之前用数组方式传，v8 静默不替换——这就是为什么 Action 一直发原模板的根因之一。
      var patterns = [
        /\{\{([^{}]+)\}\}/g,
        /「([^」]+)」/g,
        /【([^】]+)】/g,
        /（([^（）]+)）/g,
        /\(([^()]+)\)/g
      ];
      for (var i = 0; i < patterns.length; i++) {
        patterns[i].lastIndex = 0;  // 复用前重置
        content = content.replace(patterns[i], function (_, k) {
          return getByKey(k.trim());
        });
      }
      return content;
    }

    var out = renderOne(content);
    // 二次渲染（占位符里嵌占位符的特殊情况）
    if (out !== content) {
      var prev;
      for (var i = 0; i < 3; i++) {
        prev = out;
        out = renderOne(out);
        if (out === prev) break;
      }
    }
    return out;
  }

  // ---------- renderContent：与原版兼容的同步渲染 ----------
  // [v10.5] 关键修复：在浏览器 / Action 调用前，先把 project 注入 n._project，
  // 这样 replaceVars 在 Node 环境（无 state 全局）也能正确取到项目字段。
  // 否则 Action 端 ReferenceError → catch 兜底发原模板（含 {{占位符}}）到群里。
  function renderContent(project, stage, n, ac) {
    if (!ac) return '';
    var aud = ac.audience || n.audience || 'student';
    var nWithProj = n;
    if (project && (!n._project || n._project !== project)) {
      // 浅拷贝避免污染调用方引用
      nWithProj = Object.assign({}, n, { _project: project });
    }
    return replaceVars(stage, nWithProj, aud, ac.content || '');
  }

  // ---------- 渲染 Markdown → 预览 HTML ----------
  function renderMdPreview(md) {
    if (!md) return '<span class="sub">（空）</span>';
    var html = esc(md);
    // ![alt](url) → <img>
    html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, function (m, alt, url) {
      return '<img src="' + esc(url) + '" alt="' + esc(alt) + '">';
    });
    // [text](url) → <a>
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, function (m, t, u) {
      return '<a href="' + esc(u) + '" target="_blank">' + esc(t) + '</a>';
    });
    // **text** → <strong>
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // 换行
    html = html.replace(/\n/g, '<br>');
    return html;
  }

  // ============================================================
  // v10.5 发送 payload 构建（news 单 article·图文混排真源）
  // ============================================================
  //
  // 契约（前端 cloudSend + Edge Function send-v10 + Action send-due 共用）：
  //   输入：renderedContent = 已替换占位符的最终文案（含可能的 ![alt](supabase-url) 语法）
  //   输出：{ msgtype: 'news', news: { articles: [article] } } 或
  //         { msgtype: 'markdown_v2', markdown_v2: { content } }（无图时）
  //
  // 关键约束（企微 API 硬限制）：
  //   - news articles 长度 ≤ 10
  //   - article.title ≤ 64 字
  //   - article.description ≤ 512 字（且 url 必须有，否则 40039 invalid url size）
  //   - article.picurl 必须是公网可访问的图片 URL
  //   - 唯一一张主图：第一张 supabase 图作为 picurl；其他图作为 description 里的可点击链接
  //   - 无图：降级为 markdown_v2（无内嵌图但纯文字够用）

  function extractImgs(text) {
    var arr = [];
    var re = /!\[([^\]]*)\]\(\s*([^)\s]+)\s*\)/g;
    var m;
    while ((m = re.exec(text)) !== null) {
      if (SUPABASE_HOST_RE.test(m[2])) arr.push({ alt: m[1] || '图片', url: m[2] });
    }
    return arr;
  }

  function stripImgs(text) {
    return String(text || '')
      .replace(/!\[([^\]]*)\]\(\s*[^)\s]+\s*\)/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  // 拆分纯文本为 title + description：
  //   title = 第一段非空内容（最多 64 字，截断补省略号）
  //   description = 剩余纯文本（最多 512 字；多图时把其他图作为可点击链接追加）
  function splitTitleDesc(cleaned) {
    var lines = cleaned.split(/\n+/);
    var titleRaw = (lines.shift() || '通知').trim() || '通知';
    var title = titleRaw.length > 64 ? titleRaw.slice(0, 63) + '…' : titleRaw;
    var descriptionRaw = lines.join('\n').trim();
    if (!descriptionRaw) descriptionRaw = cleaned.slice(0, 200).trim();
    return { title: title, description: descriptionRaw };
  }

  // 同步构建企微发送 payload（图文混排真源）
  // options:
  //   testMode:    是否测试模式（在首段加【测试】）
  //   articleUrl:  点击跳转 URL（必填，否则企微返回 40039）
  function buildNewsPayload(renderedContent, options) {
    options = options || {};
    var testMode = !!options.testMode;
    var articleUrl = options.articleUrl || 'https://work.weixin.qq.com/';

    var raw = renderedContent || '';
    if (testMode) raw = '【测试】' + raw;

    var imgs = extractImgs(raw);
    var cleaned = stripImgs(raw);

    // 无图：降级 markdown_v2（纯文字够清晰）
    if (imgs.length === 0) {
      return { msgtype: 'markdown_v2', markdown_v2: { content: raw } };
    }

    // 有图：news 单 article
    var split = splitTitleDesc(cleaned);
    var title = split.title;
    var description = split.description;

    // 第一张图 = 主图（picurl）
    var mainPic = imgs[0].url;

    // 其他图：作为 description 里的可点击链接追加（保留上下文"图文混排"的语义）
    if (imgs.length > 1) {
      var moreLinks = imgs.slice(1).map(function (im, i) {
        var alt = im.alt || ('图片' + (i + 2));
        return '[查看图片：' + alt + '](' + im.url + ')';
      }).join('\n');
      description = (description ? description + '\n\n' : '') + moreLinks;
    }

    // description 截断到 512 字
    if (description.length > 512) description = description.slice(0, 511) + '…';

    return {
      msgtype: 'news',
      news: {
        articles: [{
          title: title,
          description: description,
          url: articleUrl,
          picurl: mainPic
        }]
      }
    };
  }

  // 前端预览渲染：把 payload 渲染成企微 news 卡片样式的 HTML
  // 视觉上对齐企微实际呈现：大图占顶 + 标题 + 多行描述 + 跳转提示
  function renderNewsPreview(payload) {
    if (!payload) return '<span class="sub">（空）</span>';

    // markdown_v2 纯文字（无图）：走 markdown 预览
    if (payload.msgtype === 'markdown_v2') {
      return '<div class="news-card news-card-text"><div class="news-body">' +
        renderMdPreview(payload.markdown_v2 && payload.markdown_v2.content) +
        '</div></div>';
    }

    if (payload.msgtype === 'news' && payload.news && payload.news.articles && payload.news.articles.length) {
      var html = '';
      payload.news.articles.forEach(function (a) {
        html += '<div class="news-card">';
        if (a.picurl) {
          html += '<div class="news-card-image"><img src="' + esc(a.picurl) + '" alt=""></div>';
        }
        html += '<div class="news-card-title">' + esc(a.title || '通知') + '</div>';
        if (a.description) {
          html += '<div class="news-card-desc">' + renderMdPreview(a.description) + '</div>';
        }
        html += '</div>';
      });
      return html;
    }

    return '<span class="sub">（未知格式）</span>';
  }

  // ============================================================
  // 导出
  // ============================================================
  return {
    NBSP2: NBSP2,
    // 变量替换 + 渲染
    replaceVars: replaceVars,
    renderContent: renderContent,
    renderMdPreview: renderMdPreview,
    // v10.5 真源：news 单 article·图文混排
    buildNewsPayload: buildNewsPayload,
    renderNewsPreview: renderNewsPreview,
    // 内部工具（导出供测试 / Action 使用）
    extractImgs: extractImgs,
    stripImgs: stripImgs,
    splitTitleDesc: splitTitleDesc,
    // 工具
    esc: esc,
    linkifyUrl: linkifyUrl,
    fmtDateTime: fmtDateTime,
    fmtStageTime: fmtStageTime
  };
});