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
    esc: esc,
    linkifyUrl: linkifyUrl,
    fmtDateTime: fmtDateTime,
    fmtStageTime: fmtStageTime
  };
});
