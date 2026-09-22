// render-core.js — 培训通知助手·渲染/构建真源（Node + 浏览器共用）
//
// 单一真源原则：所有发送路径必须共用同一套构建逻辑：
//   1) 前端 cloudSend（Edge Function 调用 / no-cors 降级）
//   2) Edge Function send-v10（云端转发企微）
//   3) GitHub Action send-due（定时调度）
// 三处 payload 必须字节级一致 → 群里实际收到的 = 预览看到的。
//
// 关键约束（企微 API · v10.7.1 共识，用户截图实证）：
//   - 企微 markdown_v2 原生支持 inline 图片：![alt](URL) 在 markdown 文本流里直接渲染为图片，
//     无需走 news 单 article 卡片（news 卡片会把首图当 picurl 提到顶端，无法表达"文字流里嵌 N 张图"）。
//   - 因此 buildNewsPayload 永远返回 markdown_v2（图文 = inline ![]() 内嵌，不是 news 卡片）。
//   - 任务列表里的图片附件同样用 ![alt](URL) 内嵌；链接附件用 [🔗 文字](URL)。
//   - v10.3 / v10.4 试过的 template_card / news 单 article 卡片均已被废弃（与"图文=inline 内嵌"共识不符）。

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

  // [v10.7.2] 日期/时间拼接：仅日期(date) + 可选时间(time) → "YYYY-MM-DD" 或 "YYYY-MM-DD HH:MM"
  //   时间允许为空：只填日期时不补时间（避免显示多余的 00:00 / 默认 08:00）。
  function joinDT(date, time) {
    if (!date) return '';
    return time ? (date + ' ' + time) : date;
  }

  function fmtDateTime(s) {
    if (!s) return '';
    var str = String(s).trim();
    // [v10.7.2] 仅日期（无时间部分，形如 2026-08-27）直接原样返回——
    // 否则 new Date('2026-08-27') 被解析为 UTC 0 点、+8 时区 getHours()=8，
    // 会错误补出 " 08:00"；而 v10.html 的 <input type="date"> 只允许填日期，
    // 故"具体时间点允许为空"时不应显示默认时间。
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
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
    var startT = stage.startTime || '';
    var endT = stage.endTime || '';
    if (start && end) return joinDT(start, startT) + ' ~ ' + joinDT(end, endT);
    return joinDT(start || end, startT || endT);
  }

  // ---------- 变量替换（占位符渲染） ----------
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

  // [v10.7] {{任务列表}} 占位符渲染：把"该通知已勾选"的学习任务展开为 markdown
  //   - 输入：stage（tasks[].{id,name,description,dueDate,attachments[].{id,type,name,url,linkText}}）
  //           ac.taskIds（勾选 id 列表）+ ac.taskOrder（排序）
  //   - 输出：markdown 文本，每任务一段
  //       1. 任务名，截止 2026-08-27
  //          说明：xxx
  //          📷 [附件名](URL)        ← 图片附件（企微不支持 inline 图片，markdown 链接形式呈现）
  //          🔗 [链接文字或URL](URL) ← 链接附件
  //   - 兜底：未勾选任何任务 → 返回空（避免泄露未关联任务 / 避免占位符残留）
  //   - 避坑：截止日期用全角逗号"，" 分隔（不用全角括号"（）"，避免被 patterns[3] 误吃）。
  //   - 二次 render 安全：markdown 链接 [text](url) 含半角括号，也不应再被 patterns[4] 误吃；
  //          所以"任务列表"最终值由 replaceVars 在所有占位符替换完成后，用临时占位符（__TASKLIST_PLACEHOLDER__），
  //          在最后一步 .replace() 注入，避免与 markdown 链接语法字符冲突。
  function renderTaskListMarkdown(stage, ac) {
    if (!stage || !Array.isArray(stage.tasks) || stage.tasks.length === 0) return '';
    var ac2 = ac || {};
    var order = (ac2.taskOrder && ac2.taskOrder.length) ? ac2.taskOrder : stage.tasks.map(function (t) { return t.id; });
    var picked = new Set(ac2.taskIds || []);
    if (picked.size === 0) return '';
    var lines = [];
    order.forEach(function (tid, idx) {
      var t = stage.tasks.find(function (x) { return x.id === tid; });
      if (!t || !picked.has(tid)) return;
      var num = (idx + 1) + '.';
      var name = (t.name || '').trim() || '未命名任务';
      var due = t.dueDate ? '，截止 ' + t.dueDate : '';
      var line = num + ' ' + name + due;
      if (t.description && String(t.description).trim()) {
        line += '\n   说明：' + String(t.description).trim();
      }
      if (Array.isArray(t.attachments)) {
        t.attachments.forEach(function (a) {
          if (!a || !a.url) return;
          var label = (a.name || '').trim() || (a.type === 'image' ? '图片' : '链接');
          if (a.type === 'image') {
            // [v10.7] 图片附件：用 markdown 图片语法 ![alt](url) 呈现——这样 buildNewsPayload 的 extractImgs
            //   会识别为图，整条通知走 news 单 article 模式（picurl = 第一张图）；不再是 markdown 模式下
            //   被降级为文字链接（用户反复反馈"图片应是图文形式，不是文字链接"）。
            line += '\n   ![附件图片：' + label + '](' + a.url + ')';
          } else {
            // 链接附件：保留 markdown 链接形式 [🔗 文字](url)，
            //   用全角方括号「」/【】以外的字符（半角方括号即可，因不在 patterns 里）。
            var icon = '🔗';
            line += '\n   ' + icon + ' [' + label + '](' + a.url + ')';
          }
        });
      }
      lines.push(line);
    });
    return lines.length ? lines.join('\n\n') : '';
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
      // [v10.7.1] v10.html 项目编辑表单字段语义是"整体培训安排"，字段名 overallArrangement（驼峰）。
      //         原 overallPlan 是早期遗留，已统一为 overallArrangement。
      整体安排: safeGet(project, 'overallArrangement', ''),
      项目开始: fmtDateTime(safeGet(project, 'startDate', '')),
      项目结束: fmtDateTime(safeGet(project, 'endDate', '')),
      // [v10.7.1] 负责人：v10.html data-k="owner"，之前 _p 漏注册 → {{负责人}} 渲染为空。
      负责人: safeGet(project, 'owner', ''),
      // [v10.7.1] 阶段字段补全：v10.html 第 2115 行早就有{{阶段开始时间}}{{阶段结束时间}}{{地点/链接}}三个变量，
      //   之前 _p 缺这三个，{{地点/链接}} 会渲染空白。原「阶段时间」拆为两个独立变量。
      阶段名: safeGet(stage, 'name', ''),
      // [v10.7.2] 阶段时间 = 日期 + 可选具体时间（startTime/endTime 允许为空）。
      //   v10.html 阶段信息块有 startDate/startTime/endDate/endTime 四字段，
      //   之前 _p 只用了 startDate/endDate，导致"具体时间"渲染不出来且默认补 08:00。
      阶段开始时间: joinDT(safeGet(stage, 'startDate', ''), safeGet(stage, 'startTime', '')),
      阶段结束时间: joinDT(safeGet(stage, 'endDate', ''), safeGet(stage, 'endTime', '')),
      // 地点/链接：纯 URL 时 v10.html 第 2613 行 wrapper 会自动包成 [链接](URL)；此处直接读字符串即可。
      '地点/链接': safeGet(stage, 'placeOrLink', ''),
      节点名: safeGet(n, 'label', ''),
      节点时间: fmtDateTime(safeGet(ac, 'notifyAt', '')),
      受众: audienceLabel,
      文案: safeGet(ac, 'content', ''),
      // [v10.7] 任务列表：用临时占位符占位，二次 render 全部跑完后由 replaceVars 末尾的
      //         .replace() 注入真实 markdown——避开 markdown 链接 [t](url) 的半角括号被
      //         patterns[4] /\(([^()]+)\)/g 误吃。
      任务列表: '__TASKLIST_PLACEHOLDER__'
    };

    function getByKey(k) {
      // [v10.7.3] 未知 key 保留原文（m），不替换为空字符串——
      //   1) 避免双重 render 时把渲染产物里的半角/全角括号误吃：
      //      如 `（{{节点时间}}）` 经 patterns[0] 替换成 `（2026-08-27 09:00）`，
      //      再被 patterns[3] 全角括号匹配，把"2026-08-27 09:00"当成未知 key → 整段变空。
      //   2) 用户写 `(文字注释)` 不是占位符，未知 key 保留括号原样更符合直觉。
      //   3) typo 占位符 `{{notExist}}` 在群里保留原样，便于运营人定位问题。
      if (_p.hasOwnProperty(k)) return _p[k];
      return '__TN_KEEP__';
    }

    // [v10.7.3 关键修复] 在 patterns 替换前先把 markdown 图片/链接语法用临时占位符
    //   保护起来，跑完 patterns 再恢复。否则 patterns[4] 半角括号正则 /\(([^()]+)\)/g
    //   会把 !\[alt\](url) 里的 url 当成"占位符 key"匹配出来 → URL 整段被删 → 变成 !\[alt\]
    //   → preview 显示 "[图片]"、企微渲染失败。任务列表附件 !\[\](URL) 能显示，
    //   是因为它通过 __TASKLIST_PLACEHOLDER__ 注入，跳过了 patterns。
    function protectMarkdownSyntax(text) {
      var IMG_PH = '\u0000TNPIMG\u0000';
      var LINK_PH = '\u0000TNPLNK\u0000';
      var imgStore = [];
      var linkStore = [];
      // 1) ![alt](url) — 优先匹配，避免被下面的 [text](url) 误吃
      text = text.replace(/!\[[^\]]*\]\(([^)\s]+)\)/g, function (m) {
        imgStore.push(m);
        return IMG_PH + (imgStore.length - 1) + '_';
      });
      // 2) [text](url) — 用 (?<!!) 否定回溯，避免吃掉 ![alt](url) 的 [] 部分
      text = text.replace(/(?<!!)\[[^\]]*\]\(([^)\s]+)\)/g, function (m) {
        linkStore.push(m);
        return LINK_PH + (linkStore.length - 1) + '_';
      });
      return { text: text, restore: function (t) {
        t = t.replace(new RegExp(IMG_PH + '(\\d+)_', 'g'), function (_, i) {
          return imgStore[parseInt(i, 10)] || '';
        });
        t = t.replace(new RegExp(LINK_PH + '(\\d+)_', 'g'), function (_, i) {
          return linkStore[parseInt(i, 10)] || '';
        });
        return t;
      }};
    }

    function renderOne(content) {
      // 5 种占位符格式都尝试；短变量名（驼峰 + 短中文）都支持
      // [v10.5 关键修复] String.replace 不支持 regex 数组参数，必须逐个 replace；
      // 之前用数组方式传，v8 静默不替换——这就是为什么 Action 一直发原模板的根因之一。
      // [v10.7.3 关键修复] 先保护 markdown 图片/链接语法，避免被 patterns[4] 半角括号正则误吃。
      var prot = protectMarkdownSyntax(content);
      var guarded = prot.text;
      var patterns = [
        /\{\{([^{}]+)\}\}/g,
        /「([^」]+)」/g,
        /【([^】]+)】/g,
        /（([^（）]+)）/g,
        /\(([^()]+)\)/g
      ];
      for (var i = 0; i < patterns.length; i++) {
        patterns[i].lastIndex = 0;  // 复用前重置
        guarded = guarded.replace(patterns[i], function (m, k) {
          var v = getByKey(k.trim());
          return v === '__TN_KEEP__' ? m : v;
        });
      }
      return prot.restore(guarded);
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
    // [v10.7] 任务列表：所有占位符替换跑完后，再把真实任务列表 markdown 注入
    // （避开 markdown 链接 [t](url) 与占位符 5 格式字符冲突）
    out = out.split('__TASKLIST_PLACEHOLDER__').join(renderTaskListMarkdown(stage, ac));
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

  // 清理无法被 news description 渲染的 markdown 语法：
  //   - ![alt](url) → 整体移除，图片提取由 extractImgs 独立完成（这里不参与判断）
  //   - ![alt]（无 url） → 整体移除
  //   - **bold** / *italic* → 去掉标记保留文本（news description 不渲染）
  //   - 多余空行合并
  // 注意：必须在 splitTitleDesc 之前调用，且对全图（含 supabase URL）做无差别剥离——
  //   之前的"非 supabase 才剥"会导致残留 `(url)` 字面在 description 中。
  function cleanMarkdownForNews(text) {
    if (!text) return '';
    var s = String(text);
    s = s.replace(/!\[[^\]]*\]\(\s*[^)\s]+\s*\)/g, '');  // 完整 ![alt](url)
    s = s.replace(/!\[[^\]]*\]/g, '');                    // 残余 ![alt]
    s = s.replace(/\*\*([^*]+)\*\*/g, '$1');               // **bold**
    s = s.replace(/(?<!\*)\*([^*\n]+)\*(?!\*)/g, '$1');    // *italic*
    s = s.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    return s;
  }

  function stripImgs(text) {
    return cleanMarkdownForNews(text);
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

    var raw = renderedContent || '';
    if (testMode) raw = '【测试】' + raw;

    // [v10.7.1] 图文模式 = markdown_v2 + inline ![]() 渲染，不走 news 卡片。
    //   之前 buildNewsPayload 见有 ![]() 就切 news 模式 → 第一张图被当 picurl 提到顶端，
    //   与真实企微行为不符（实际企微 markdown_v2 就支持 inline 图片，参考用户截图@image#3）。
    //   news 单 article 模式被废弃：title/description/picurl + url 强耦合，无法表达"文字流里嵌 N 张图"的版式。
    //   现在一律 markdown_v2：![]() 在 markdown 流里渲染为图片，[t](u) 渲染为可点击链接。
    return { msgtype: 'markdown_v2', markdown_v2: { content: raw } };
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
    cleanMarkdownForNews: cleanMarkdownForNews,
    stripImgs: stripImgs,
    splitTitleDesc: splitTitleDesc,
    // 工具
    esc: esc,
    linkifyUrl: linkifyUrl,
    fmtDateTime: fmtDateTime,
    fmtStageTime: fmtStageTime
  };
});