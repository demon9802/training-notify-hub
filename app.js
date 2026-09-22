(function(){
  "use strict";
  const SERVER_MODE = location.protocol !== 'file:' && (location.port === '8788' || location.hostname === 'localhost' || location.hostname === '127.0.0.1');
  const GROUPS_LABEL = {student:'学员群', lecturer:'讲师群', manager:'管理群', test:'测试群'};
  const AUDIENCES = ['student','lecturer','manager'];
  const NODE_LABEL = {start:'启动通知', midway:'中程提醒', due:'截止提醒', post:'截止后通晒'};
  // ===== 轻量登录：共享密码 + 无状态 token =====
  const TN_AUTH_TOKEN_KEY = 'tn_v10_auth_token';
  function getAuthToken(){ return localStorage.getItem(TN_AUTH_TOKEN_KEY) || ''; }
  function setAuthToken(t){ if(t) localStorage.setItem(TN_AUTH_TOKEN_KEY, t); else localStorage.removeItem(TN_AUTH_TOKEN_KEY); }
  // 代理 window.fetch：自动注入 x-auth-token（受保护路由需登录，未配置密码则放行）
  (function patchFetch(){
    const _orig = window.fetch.bind(window);
    window.fetch = function(url, opts){
      opts = opts || {};
      const headers = new Headers(opts.headers || {});
      const tk = getAuthToken();
      if(tk) headers.set('x-auth-token', tk);
      return _orig(url, Object.assign({}, opts, {headers: headers}));
    };
  })();

  // ===== Supabase 直连（静态托管 / EdgeOne 版，与后端 dataStore.js 共用 tn_kv schema） =====
  // 关键约定：key=data 主键（项目=project:<id> / 模板=templates / 群=global_groups / 设置=app_settings），data=JSON，updated_at 时间戳。
  // _sb 为 null 时所有数据函数自动降级 localStorage —— 绝不丢数据。
  const SB_URL = 'https://qyxxchifknfmvvyjvoue.supabase.co';
  const SB_ANON = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InF5eHhjaGlma25mbXZ2eWp2b3VlIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODcwMzA5MjEsImV4cCI6MjEwMjYwNjkyMX0.Af81xF1lj4SvYVmn8Lxq1tepBiWgZlugB7QYyhI-ULc';
  let _sb = null;
  async function initSupabase(){
    if(SERVER_MODE) return;                       // 本地服务走后端，不直连
    if(_sb) return;
    try{
      if(typeof window.supabase === 'undefined'){ console.warn('[cloud] supabase-js 未加载，回退 localStorage'); return; }
      _sb = window.supabase.createClient(SB_URL, SB_ANON, { auth:{ persistSession:false } });
      // 轻量连通性探测：读一次 tn_kv，失败则 _sb 置空 → 自动降级 localStorage
      const { error } = await _sb.from('tn_kv').select('key').limit(1);
      if(error){ console.warn('[cloud] 云端不可达，回退 localStorage：', error.message); _sb=null; }
    }catch(e){ console.warn('[cloud] 初始化失败，回退 localStorage：', e.message); _sb=null; }
  }
  async function cloudGet(key){
    if(!_sb) return undefined;
    try{ const { data, error } = await _sb.from('tn_kv').select('data').eq('key',key).single();
      if(error) return undefined; return data ? data.data : undefined; }
    catch(e){ return undefined; }
  }
  async function cloudSet(key, val){
    if(!_sb) return false;
    try{ const { error } = await _sb.from('tn_kv').upsert({ key, data:val, updated_at:new Date().toISOString() });
      if(error){ console.error('[cloud] set', key, error.message); return false; } return true; }
    catch(e){ return false; }
  }
  // 字段权威性保护：合并内存 project 与 cloud 真源。
  // 问题：前端 silentSave 用内存 stale project 写云端时，会覆盖云端 Action 写入的 sentAt/sentAudiences/
  //       reminder1dSentAt/reminder2hSentAt 这类"不该被 UI 编辑回退"的字段。
  // 策略：以 cloud 为准保留这些字段，其他字段用本地内存（用户编辑的新值）。
  // [v10.7.2 关键修复] 改为**原地修改 local**（不再返回深拷贝副本）：
  //   旧版返回 out = 深拷贝(project) 后 silentSave 执行 `project = merged`，使 project 指向一个
  //   全新对象，而当前已渲染的 textarea/输入框的事件监听仍引用旧的 ac 对象 →
  //   用户在第一次自动保存之后的每次编辑都写入"孤儿"旧对象，下一轮自动保存读的是新 project（不含这些编辑），
  //   再下次 render() 用新 project 重建文本框时，这些编辑就凭空消失了（表现为"部分保存 / 页面刷新后新内容没了"）。
  //   原地修改 local 后，project 引用保持不变，DOM 绑定始终有效，编辑不会再丢。
  function mergeCloudAuthorityFields(local, cloud){
    if(!cloud || typeof cloud !== 'object' || Array.isArray(cloud)) return {local, dirty:false};
    if(!local || !local.stages) return {local, dirty:false};
    let dirty = false;
    const cloudStages = (cloud.stages||[]);
    local.stages.forEach((s)=>{
      const cs = cloudStages.find(x=>x && x.id && s && s.id && x.id===s.id);
      if(!cs || !s.notifications) return;
      s.notifications.forEach((n)=>{
        const cn = (cs.notifications||[]).find(x=>x && x.id && n && n.id && x.id===n.id);
        if(!cn) return;
        // [v10.7.12] 关键：云端显式重置（sentAt=null / sentAudiences=[] / status=null）时，
        //   本地内存必须跟随清空。否则本地陈旧的 sentAt 会在 silentSave 时反向写回云端，
        //   形成「管理员/改时间清空云端 → 浏览器下一秒又写回旧值 → 云端再次变脏」的死循环
        //   （用户 9-10 19:24/19:29/19:36 三次实证：PATCH 清空后 3 分钟内必被浏览器写回）。
        //   严格用 === null / length===0 判断，避免"云端字段不存在(undefined)"被误判为重置。
        if(cn.sentAt === null && n.sentAt){ n.sentAt = null; dirty = true; }
        if(Array.isArray(cn.sentAudiences) && cn.sentAudiences.length===0 && Array.isArray(n.sentAudiences) && n.sentAudiences.length>0){
          n.sentAudiences = []; dirty = true;
        }
        if(cn.status === null && n.status){ n.status = null; dirty = true; }
        // [v10.7.17] 同步 _resetAt：云端重置时间戳必须被本地继承。
        //   否则多标签页/刷新后 n._resetAt 丢失，旧 sentAt/sentAudiences 会被复活。
        if(cn._resetAt && (!n._resetAt || cn._resetAt > n._resetAt)){
          n._resetAt = cn._resetAt;
        }
        // [v10.7.18] notifyAt 兜底保护：真实发送后的 sentAt 必然 >= 对应受众 notifyAt；
        //   若云端 sentAt 早于当前 notifyAt 超过 1h，说明是旧记录（改时间后旧值残留）。
        //   此判断不依赖 _resetAt，可防止旧版本标签页把 _resetAt 覆盖掉后旧状态复活。
        const cnSentTs = cn.sentAt ? (new Date(cn.sentAt).getTime() || 0) : 0;
        const enabledNotifyAts = ['student','lecturer','manager']
          .map(aud => cn.audienceContent && cn.audienceContent[aud] && cn.audienceContent[aud].enabled ? cn.audienceContent[aud].notifyAt : null)
          .filter(Boolean);
        const minNotifyAtMs = enabledNotifyAts.length ? Math.min(...enabledNotifyAts.map(t => (new Date(t).getTime() || Infinity))) : 0;
        // [v10.7.18] 用 < 而非 <=：真实发送后的 sentAt 必然 >= notifyAt；
        //   只要云端 sentAt 早于当前 notifyAt，就视为旧记录并清空，避免改时间后旧状态复活。
        const isOldByNotifyAt = minNotifyAtMs > 0 && cnSentTs > 0 && cnSentTs < minNotifyAtMs;
        // [v10.7.14/17/18] _resetAt + notifyAt 双保护：用户刚改时间重置过，pollOverview/silentSave 拉云端时
        //   可能遇到旧 sentAt，必须拒绝复活；scheduler 真实发送后的新 sentAt 必然晚于 _resetAt / notifyAt，届时正常复活。
        const resetAt = n._resetAt || 0;
        const isOldCloudSent = isOldByNotifyAt || (resetAt > 0 && (
          (cnSentTs > 0 && cnSentTs <= resetAt)
          || (cnSentTs === 0 && Array.isArray(cn.sentAudiences) && cn.sentAudiences.length > 0)
          || (cnSentTs === 0 && cn.status === 'sent')
        ));
        if(isOldCloudSent){
          // [v10.7.17/18] 云端是旧记录，本地必须清空这些权威字段。
          //   否则多标签页/旧页面会保留旧状态并写回云端，导致推送概览显示错乱、临近节点消失。
          if(n.sentAt){ n.sentAt = null; dirty = true; }
          if(Array.isArray(n.sentAudiences) && n.sentAudiences.length>0){ n.sentAudiences = []; dirty = true; }
          if(n.status === 'sent'){ n.status = null; dirty = true; }
          if(n.reminder1dSentAt){ n.reminder1dSentAt = null; dirty = true; }
          if(n.reminder2hSentAt){ n.reminder2hSentAt = null; dirty = true; }
        } else {
          // [v10.7.11] 强化语义：仅在「本地字段 falsy」时用云端补；本地有值不覆盖
          //   （保留 v10.2 root-fix 的"避免本地刚清空就被云端旧值复活"语义）。
          if(cn.sentAt && !n.sentAt) n.sentAt = cn.sentAt;
          if(Array.isArray(cn.sentAudiences) && cn.sentAudiences.length && (!Array.isArray(n.sentAudiences) || n.sentAudiences.length===0)){
            n.sentAudiences = Array.from(new Set(cn.sentAudiences));
          }
          if(cn.reminder1dSentAt && !n.reminder1dSentAt) n.reminder1dSentAt = cn.reminder1dSentAt;
          if(cn.reminder2hSentAt && !n.reminder2hSentAt) n.reminder2hSentAt = cn.reminder2hSentAt;
          // status: 云端是 sent 且本地不是 sent 时覆盖（含 paused → sent 的恢复）
          if(cn.status === 'sent' && n.status !== 'sent'){
            n.status = 'sent';
          }
          // 新的真实发送已发生，清除重置标记
          if(resetAt > 0 && cnSentTs > resetAt){
            delete n._resetAt;
          }
        }
      });
    });
    return {local, dirty};
  }
  // silentSave 调用前的"取最新云端" — 以云端真源保护关键字段不丢
  async function fetchCloudMerge(local){
    if(!_sb || !currentProjectId) return {local, dirty:false};
    try{
      const cloud = await cloudGet('project:'+currentProjectId);
      return mergeCloudAuthorityFields(local, cloud);
    }catch(e){ return {local, dirty:false}; }
  }
  // 轻量 MD5 包装：复用 js-md5 全局（<script src="md5-lite.min.js"> 在 head 引入）。
  // 浏览器 SubtleCrypto 不支持 MD5，必须走这个。接受 string 或 Uint8Array，返回 hex。
  function md5Hex(input){
    var arr;
    if(input && typeof input==='object' && input.length!==undefined && (input.constructor===Uint8Array || Array.isArray(input))) {
      arr = Array.from(input);
    } else { arr = String(input); }
    return md5(arr);
  }
  async function cloudDelete(key){
    if(!_sb) return false;
    try{ const { error } = await _sb.from('tn_kv').delete().eq('key',key); if(error) return false; return true; }
    catch(e){ return false; }
  }
  async function cloudListProjects(){
    if(!_sb) return [];
    try{ const { data, error } = await _sb.from('tn_kv').select('key,data').like('key','project:%');
      if(error) return []; return (data||[]).map(r=>({id:String(r.key).replace(/^project:/,''), ...(r.data||{})})); }
    catch(e){ return []; }
  }
  async function cloudUpload(dataUrl){
    if(!_sb) return { success:false, error:'未连接云端' };
    try{
      const m = dataUrl.match(/^data:(image\/\w+);base64,(.+)$/); if(!m) return {success:false,error:'格式不支持'};
      const mime=m[1]; const bin=atob(m[2]); const len=bin.length; const bytes=new Uint8Array(len);
      for(let i=0;i<len;i++) bytes[i]=bin.charCodeAt(i);
      const ext=(mime.split('/')[1]||'png').replace('jpeg','jpg');
      const fileName=`${Date.now()}-${Math.random().toString(36).slice(2,8)}.${ext}`;
      const { error } = await _sb.storage.from('tn-images').upload(fileName, bytes, { contentType:mime, upsert:true });
      if(error) return {success:false, error:error.message};
      const { data:pub } = _sb.storage.from('tn-images').getPublicUrl(fileName);
      return { success:true, url:pub.publicUrl, mime };
    }catch(e){ return {success:false, error:e.message}; }
  }
  // [v10.5 图文混排真源] 发送路径：
  //   1) 优先走 Edge Function（send-v10，部署在 Supabase）—— 服务端转发企微 webhook，
  //      浏览器读得到真实回执（errcode/errmsg）；send-v10 内部也调用同一真源 buildNewsPayload，
  //      与前端/Action 发的 payload 字节级一致。
  //   2) 降级 no-cors 直发：浏览器 fetch(no-cors) 直发企微 webhook——picurl 是 supabase 公网 URL，
  //      企微服务器自己抓，无需前端下载/转 base64；浏览器无法读取响应（opaque），仅盲发。
  //   3) news 单 article 方案（大图 picurl + 多行 description + url 跳转）= 截图5 已确认的形态。
  // [v10.7.3 根因修复] 单一真源原则：前端 RenderCore 永远是 payload 构造真源。
  //   之前 cloudSend 调 _sb.functions.invoke('send-v10', ...) → send-v10 Edge Function 内联
  //   了一份 buildNewsPayload（双真源），如果云端版本与 RenderCore 不同步，preview 和群内
  //   就会不一致（用户截图：preview 是 markdown_v2 inline，群内却是 news 卡片 + ** 字面量）。
  //   现在 send-v10 退化为"无脑代理"：接收前端已构造的 payload，原样 POST webhook，
  //   不再参与 payload 构建；no-cors 降级也用同一 payload → 三条路径（send-v10 / 降级 / preview）
  //   永远字节级一致。
  async function cloudSend(items, testMode){
    async function postNoCors(webhookUrl, jsonBody){
      await fetch(webhookUrl, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body: JSON.stringify(jsonBody) });
    }

    // 1) 前端用 RenderCore 真源构造 payload（v10.7.1 起永远 markdown_v2 + inline ![]()）
    const enrichedItems = (items||[]).map(function(it){
      const articleUrl = it.articleUrl || (project && (project.viewUrl||project.url)) || 'https://work.weixin.qq.com/';
      const payload = RenderCore.buildNewsPayload(it.content, { testMode, articleUrl });
      return { webhookUrl: it.webhookUrl, groupName: it.groupName, payload: payload };
    });

    // 2) 优先调新版 send-v10 代理（接收 payload，直发 webhook，能读 errcode）
    if(_sb){
      try{
        const { data, error } = await _sb.functions.invoke('send-v10', { body:{ items: enrichedItems, testMode } });
        if(!error && data) return data;
      }catch(e){ /* send-v10 未部署 / 旧版 / 抛错 → 降级 no-cors 直发 */ }
    }

    // 3) 降级 no-cors 直发：用同一 enrichedItems 的 payload（仍由 RenderCore 构造）
    const results = [];
    for(const it of enrichedItems){
      if(!it.webhookUrl){ results.push({ groupName: it.groupName, success:false, error:'缺少 webhook' }); continue; }
      try{
        await postNoCors(it.webhookUrl, it.payload);
        results.push({
          groupName: it.groupName,
          success: true,
          error: null,
          fallback: 'no-cors',
          format: it.payload.msgtype
        });
      }catch(ee){
        results.push({ groupName: it.groupName, success:false, error: ee.message || String(ee) });
      }
    }
    return { success: results.every(r=>r.success), results, fallback:'no-cors' };
  }

  async function setupAuth(){
    const mask = document.getElementById('authMask');
    const pwd = document.getElementById('authPwd');
    const err = document.getElementById('authErr');
    const submit = document.getElementById('authSubmit');
    if(!mask) return true;

    // 非 SERVER_MODE（静态托管 / EdgeOne）：先初始化 Supabase 直连，
    // 成功则走云端数据层（数据真源与本地 8788 一致）；失败自动降级 localStorage（绝不丢数据）。
    if(!SERVER_MODE){
      await initSupabase();
      showReady();
      return true;
    }

    function showPending(msg, offline){
      document.body.classList.add('auth-pending');
      if(offline) document.body.classList.add('auth-offline'); else document.body.classList.remove('auth-offline');
      mask.classList.add('show'); mask.style.display='';
      if(msg){ err.textContent = msg; }
      pwd.focus();
    }
    function showReady(){
      document.body.classList.remove('auth-pending');
      document.body.classList.remove('auth-offline');
      mask.classList.remove('show'); mask.style.display='none';
    }

    // 等待登录成功的 Promise（init 据此阻塞业务初始化）
    let loginResolve;
    const loginPromise = new Promise(resolve=>{ loginResolve = resolve; });

    async function bootBusiness(){
      try{
        await loadGlobalGroups();
        await loadAppSettings();
        await loadTemplates();
        await seedDefaultTemplates();
        await loadProjectList();
        if(projects.length===0){
          const id = await createProject();
          if(id) await loadProjectList();
        }
        render();
      }catch(e){ toast('业务数据加载失败'); }
    }

    async function doLogin(){
      err.textContent = '';
      try{
        const r = await fetch('/api/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd.value})});
        if(!r.ok){
          err.textContent = '密码错误或服务端未启动';
          return;
        }
        const j = await r.json();
        if(j.success){
          setAuthToken(j.token);
          showReady();
          toast('登录成功');
          await bootBusiness();
          if(loginResolve) loginResolve(true);
        }
        else { err.textContent = j.error || '登录失败'; }
      }catch(e){
        err.textContent = '无法连接服务端。请打开 http://localhost:8788/v10 后再登录（不要直接 file:// 打开本文件）';
      }
    }
    submit.addEventListener('click', doLogin);
    pwd.addEventListener('keydown', e=>{ if(e.key==='Enter') doLogin(); });

    // 探测后端是否要求登录（未配密码则本地调试免登录，避免死锁）
    let required = true;
    let serverReachable = true;
    try{
      const r = await fetch('/api/auth-status');
      if(r.ok){ const j = await r.json(); required = !!j.required; }
      else { serverReachable = false; }
    }catch(e){ serverReachable = false; }

    if(!required){
      // 未配密码（本地调试免登录）
      showReady(); return true;
    }
    if(serverReachable && getAuthToken()){
      // 已经有 token（持久化在 localStorage）— 自动放行
      showReady(); return true;
    }
    if(!serverReachable){
      // 服务端不可达：明确提示
      document.body.classList.remove('auth-pending');
      document.body.classList.add('auth-offline');
      mask.classList.add('show'); mask.style.display='';
      err.textContent = '无法连接 http://localhost:8788 服务端。请确认服务已启动后用 http://localhost:8788/v10 打开（不要用 file:// 直开本文件）。';
      return false;
    }
    // required && serverReachable && !token：显示遮罩并等待登录
    showPending();
    return loginPromise;
  }
  // 文案模板（v10.2 起全局持久化，按 通知节点 + 群类别 组合）
  let TEMPLATES = [];
  async function loadTemplates(){
    if(SERVER_MODE){
      try{ const r=await fetch('/api/templates'); const j=await r.json(); TEMPLATES=j.templates||[]; }
      catch(e){ TEMPLATES=[]; }
    }else if(_sb){
      const v = await cloudGet('templates'); TEMPLATES = Array.isArray(v)? v : [];
    }else{
      TEMPLATES = JSON.parse(localStorage.getItem('tn_v10_templates')||'[]');
    }
  }
  async function saveTemplates(){
    if(SERVER_MODE){
      try{ await fetch('/api/templates',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({templates:TEMPLATES})}); }
      catch(e){ }
    }else if(_sb){
      await cloudSet('templates', TEMPLATES);
    }else{
      localStorage.setItem('tn_v10_templates', JSON.stringify(TEMPLATES));
    }
  }
  async function seedDefaultTemplates(){
    const defaultContent = `各位同学，大家好！\n\n**{{项目名}} · {{阶段名}}** 开始啦！\n\n**培训目的**\n{{培训目的}}\n\n**整体安排**\n{{整体安排}}\n\n**阶段安排**\n时间：{{阶段开始时间}} ~ {{阶段结束时间}}\n地点/链接：{{地点/链接}}\n\n**本阶段学习任务**\n{{任务列表}}\n\n过程中如有任何问题，可随时联系 {{负责人}}。`;
    // 仅在没有任何模板时创建系统默认模板；已有模板（包括用户修改过的默认模板）不再覆盖
    if(TEMPLATES.length===0){
      TEMPLATES = [{
        id: 'tpl-start-student-' + uid(),
        label: '学习阶段启动通知（学员群）',
        node: 'start',
        audience: 'student',
        content: defaultContent,
        updatedAt: new Date().toISOString()
      }];
      await saveTemplates();
    }
  }
  function getTemplates(node, audience){
    return TEMPLATES.filter(t => (!node || t.node===node) && (!audience || t.audience===audience));
  }
  function getTemplateById(id){ return TEMPLATES.find(t=>t.id===id); }
  function applyTemplateToAudience(n, aud, tpl){
    const ac = n.audienceContent[aud];
    ac.content = tpl.content;
    ac.enabled = true;
    ac.templateId = tpl.id;
    ac.templateAppliedAt = new Date().toISOString();
  }
  function applyNodeTemplates(n, onlyEmpty){
    AUDIENCES.forEach(a=>{
      const list = getTemplates(n.node, a);
      if(list.length===0) return;
      const ac = n.audienceContent[a];
      if(onlyEmpty && ac.content && ac.content.trim()) return;
      applyTemplateToAudience(n, a, list[0]);
    });
  }
  function isTemplateOutdated(ac){
    if(!ac || !ac.templateId || !ac.templateAppliedAt) return null;
    const t = getTemplateById(ac.templateId);
    if(!t || !t.updatedAt) return null;
    return new Date(t.updatedAt) > new Date(ac.templateAppliedAt) ? t : null;
  }

  let globalGroups = [];
  let appSettings = { reminderWebhook: '' };
  let projects = [];
  let project = null;
  let currentProjectId = null;
  let view = 'list';
  let homeSection = 'all'; // 'all' | 'overview' | category-name
  let editSection = 'meta'; // 'meta' | 'parse' | 'overview' | 'notifs'
  let saveTimer = null;
  let activeAud = {};
  let pendingTestNotification = null;
  let pendingTestAudience = null;
  let listSearch = '', listSort = 'startDesc', listYear = '';
  let overviewPage = 1; // 全局推送概览分页（兼容旧逻辑）
  // [v10.6] 三块独立分页：临近节点 5/页，待发送 10/页，已发送 5/页。
  //   防止通知增多后单页滚动过长难以定位。
  const UPCOMING_PAGE_SIZE = 5;
  const PENDING_PAGE_SIZE = 10;
  const SENT_PAGE_SIZE = 5;
  const DRAFT_PAGE_SIZE = 5;   // [v10.7.9] 原 EXPIRED_PAGE_SIZE 改名为草稿箱分页
  let upcomingPage = 1;
  let pendingPage = 1;
  let sentPage = 1;
  let draftPage = 1;          // [v10.7.9] 原 expiredPage 改名为草稿箱分页

  const $ = (s,el=document)=>el.querySelector(s);
  const $$ = (s,el=document)=>Array.from(el.querySelectorAll(s));
  const uid = ()=> 'id'+Date.now().toString(36)+Math.random().toString(36).slice(2,6);
  const esc = (s)=> (s||'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));

  // [v10.7.6 关键] 解析 notifyAt（前端 datetime-local 保存的无时区字符串）：
  //   JS Date 对 ISO 8601 "YYYY-MM-DDTHH:MM" 默认按 UTC 解析，但 UI 期望的是「本地时间（+08:00）」。
  //   无时区时强制按 +08:00 解析，与 send-due-scheduled 同步；带时区（Z/+HH:MM）按原样解析。
  function parseNotifyAtBeijing(s){
    if (!s) return NaN;
    const str = String(s).trim();
    if (/[Zz]$|[+\-]\d{2}:?\d{2}$/.test(str)) return new Date(str).getTime();
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return new Date(str + 'T00:00:00+08:00').getTime();
    return new Date(str + '+08:00').getTime();
  }

  // ---------- 数据 ----------
  function emptyProject(){
    return { projectName:'', startDate:'', endDate:'', purpose:'', owner:'', description:'', overallArrangement:'', category:'', associatedGroupIds:[], stages:[] };
  }
  function defaultAudienceConfig(){
    return { enabled:false, content:'', inputMode:'template', templateId:'', templateAppliedAt:'', notifyAt:'', targetGroups:[], taskIds:[], taskOrder:[], autoSend:true };
  }
  function defaultNotification(){
    return {
      id:uid(), name:'', node:'start',
      audienceContent:{ student:defaultAudienceConfig(), lecturer:defaultAudienceConfig(), manager:defaultAudienceConfig() },
      status:'draft', sentAt:null, sendAttempts:0, sentAudiences:[]
    };
  }
  function defaultTask(){ return { id:uid(), name:'', description:'', dueDate:'', attachments:[], collapsed:false }; }
  function defaultAttachment(){ return { id:uid(), type:'link', name:'', url:'', linkText:'' }; }
  function defaultStage(){ return { id:uid(), name:'', keywords:'', startDate:'', endDate:'', startTime:'', endTime:'', placeOrLink:'', tasks:[], notifications:[], collapsed:false }; }

  // ---------- 全局通讯录 ----------
  async function loadGlobalGroups(){
    if(SERVER_MODE){
      try{ const r=await fetch('/api/groups'); const j=await r.json(); globalGroups=j.groups||[]; }
      catch(e){ globalGroups=[]; }
    }else if(_sb){
      const v = await cloudGet('global_groups'); globalGroups = Array.isArray(v)? v : [];
    }else{
      globalGroups = JSON.parse(localStorage.getItem('tn_v10_groups')||'[]');
    }
  }
  async function saveGlobalGroups(){
    if(SERVER_MODE){
      try{ await fetch('/api/groups',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({groups:globalGroups})}); }
      catch(e){}
    }else if(_sb){
      await cloudSet('global_groups', globalGroups);
    }else{
      localStorage.setItem('tn_v10_groups', JSON.stringify(globalGroups));
    }
  }
  // ---------- 全局应用设置（提醒通道等） ----------
  async function loadAppSettings(){
    if(SERVER_MODE){
      try{ const r=await fetch('/api/settings'); const j=await r.json(); appSettings=j.settings||{}; }
      catch(e){ appSettings={}; }
    }else if(_sb){
      const v = await cloudGet('app_settings'); appSettings = (v && typeof v==='object')? v : {};
    }else{
      appSettings = JSON.parse(localStorage.getItem('tn_v10_settings')||'{}');
    }
  }
  async function saveAppSettings(){
    if(SERVER_MODE){
      try{ await fetch('/api/settings',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(appSettings)}); }
      catch(e){}
    }else if(_sb){
      await cloudSet('app_settings', appSettings);
    }else{
      localStorage.setItem('tn_v10_settings', JSON.stringify(appSettings));
    }
  }
  function migrateProjectGroups(){
    // 兼容旧数据：项目里的 groups 迁移到全局通讯录并关联；迁移后立即保存项目，避免每次打开都重复迁移
    if(!project) return;
    const legacy = (project.groups || []).filter(g=>g && g.id);
    if(legacy.length===0) return;
    const mapType = (cat)=>{
      if(!cat) return 'student';
      const c = String(cat);
      if(c.includes('学员')) return 'student';
      if(c.includes('讲师')) return 'lecturer';
      if(c.includes('管理') || c.includes('汇报')) return 'manager';
      if(c.includes('测试')) return 'test';
      return c;
    };
    const addedIds=[];
    for(const g of legacy){
      const exists = globalGroups.find(x=>x.id===g.id);
      const type = mapType(g.category || g.type) || 'student';
      if(!exists && g.name && g.webhookUrl){
        globalGroups.push({id:g.id, name:g.name, type:type, webhookUrl:g.webhookUrl, pinned:false});
        addedIds.push(g.id);
      }
      if(exists && !addedIds.includes(g.id)) addedIds.push(g.id);
    }
    project.associatedGroupIds = Array.from(new Set((project.associatedGroupIds||[]).concat(addedIds)));
    project.groups = [];
  }

  // ---------- 项目读写 ----------
  async function loadProjectList(){
    if(SERVER_MODE){
      try{ const r=await fetch('/api/projects'); const j=await r.json(); projects=j.projects||[]; }
      catch(e){ projects=[]; }
    }else if(_sb){
      projects = await cloudListProjects();
    }else{
      const list = JSON.parse(localStorage.getItem('tn_v10_projects')||'[]');
      projects = list.map(meta=>{
        try{ return JSON.parse(localStorage.getItem('tn_v10_'+meta.id)||'{}'); }
        catch(e){ return null; }
      }).filter(Boolean);
    }
  }
  async function loadProject(id){
    currentProjectId = id;
    if(SERVER_MODE){
      try{
        const r = await fetch('/api/project/'+id);
        const j = await r.json();
        project = j.project && Object.keys(j.project).length ? j.project : emptyProject();
      }catch(e){ project = emptyProject(); }
    }else if(_sb){
      const v = await cloudGet('project:'+id);
      project = (v && Object.keys(v).length) ? v : emptyProject();
    }else{
      try{ project = JSON.parse(localStorage.getItem('tn_v10_'+id)||'null') || emptyProject(); }
      catch(e){ project = emptyProject(); }
    }
    const hadLegacy = (project.groups||[]).length > 0;
    migrateProjectGroups();
    if(hadLegacy){
      await saveGlobalGroups();
      await silentSave();
    }
    ensureStructures();
  }
  function ensureStructures(){
    if(!project) return;
    if(!project.associatedGroupIds) project.associatedGroupIds=[];
    if(!project.stages) project.stages=[];
    project.stages.forEach(s=>{
      if(!s.tasks) s.tasks=[];
      if(!s.notifications) s.notifications=[];
      // 任务附件旧字段迁移：{url,title} -> {id,type,name,url,linkText}
      s.tasks.forEach(t=>{
        if(!t.attachments) t.attachments=[];
        t.attachments = t.attachments.map(a=>{
          if(a.type) return a;
          return { id:a.id||uid(), type:'link', name:a.title||'', url:a.url||'', linkText:'' };
        });
      });
      // 阶段旧字段迁移：trainingType/meetingLink/venue -> placeOrLink
      if(s.placeOrLink===undefined){
        if(s.trainingType==='online' && s.meetingLink) s.placeOrLink = s.meetingLink;
        else if(s.trainingType==='offline' && s.venue) s.placeOrLink = s.venue;
        else s.placeOrLink = '';
      }
      delete s.trainingType; delete s.meetingLink; delete s.venue;
      s.notifications.forEach(n=>{
        if(!n.audienceContent) n.audienceContent={ student:{enabled:false,content:'',templateId:'',templateAppliedAt:''}, lecturer:{enabled:false,content:'',templateId:'',templateAppliedAt:''}, manager:{enabled:false,content:'',templateId:'',templateAppliedAt:''} };
        AUDIENCES.forEach(a=>{
          if(!n.audienceContent[a]) n.audienceContent[a]={enabled:false,content:'',templateId:'',templateAppliedAt:''};
          const ac = n.audienceContent[a];
          if(ac.templateId===undefined) ac.templateId='';
          if(ac.templateAppliedAt===undefined) ac.templateAppliedAt='';
          if(ac.inputMode===undefined) ac.inputMode='template';
          if(ac.targetGroups===undefined) ac.targetGroups = (n.targetGroups && n.targetGroups[a]) ? n.targetGroups[a].slice() : [];
          if(ac.taskIds===undefined) ac.taskIds = n.taskIds ? n.taskIds.slice() : [];
          if(ac.taskOrder===undefined) ac.taskOrder = n.taskOrder ? n.taskOrder.slice() : [];
          if(ac.notifyAt===undefined) ac.notifyAt = n.notifyAt || '';
          if(ac.autoSend===undefined) ac.autoSend = n.autoSend !== undefined ? n.autoSend : true;
        });
        // 迁移后移除旧字段
        delete n.targetGroups;
        delete n.taskIds;
        delete n.taskOrder;
        delete n.notifyAt;
        delete n.autoSend;
        if(!n.sentAudiences) n.sentAudiences=[];
      });
    });
  }
  async function createProject(){
    const id = 'p'+Date.now();
    const p = emptyProject(); p.projectName='未命名项目'; p.createdAt = new Date().toISOString();
    if(SERVER_MODE){
      try{ await fetch('/api/project/'+id, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(p)}); }
      catch(e){ toast('创建失败'); return null; }
    }else if(_sb){
      await cloudSet('project:'+id, p);
    }else{
      localStorage.setItem('tn_v10_'+id, JSON.stringify(p));
      const list = JSON.parse(localStorage.getItem('tn_v10_projects')||'[]');
      list.push({id, name:p.projectName, updatedAt:p.createdAt, startDate:'', endDate:'', owner:'', category:'', totalStages:0});
      localStorage.setItem('tn_v10_projects', JSON.stringify(list));
    }
    await loadProjectList();
    return id;
  }
  async function deleteProject(id){
    if(!confirm('确认删除该项目？数据不可恢复。')) return;
    // 乐观删除：先从内存移除，立刻 render()，再后台 DELETE（云端/后端）
    projects = (projects || []).filter(p => p.id !== id);
    if(!SERVER_MODE && !_sb){
      try{ localStorage.removeItem('tn_v10_'+id); }catch(e){}
      try{
        const list = JSON.parse(localStorage.getItem('tn_v10_projects')||'[]').filter(x=>x.id!==id);
        localStorage.setItem('tn_v10_projects', JSON.stringify(list));
      }catch(e){}
    }
    render();
    if(SERVER_MODE){
      try{
        const r = await fetch('/api/project/'+id, {method:'DELETE'});
        if(!r.ok) throw new Error('HTTP '+r.status);
      }catch(e){
        toast('删除失败：'+e.message, {tone:'warn'});
        await loadProjectList(); render();
      }
    }else if(_sb){
      const ok = await cloudDelete('project:'+id);
      if(!ok){
        toast('删除失败', {tone:'warn'});
        await loadProjectList(); render();
      }
    }
  }
  // 焦点保护：当前焦点在可编辑表单（textarea / 文本类 input）内时返回 true。
  // 用于自动保存/轮询/定时发送等"后台任务"判断：用户正在打字就不重建 DOM、不触发发送，
  // 避免 12s 轮询刷新掉文本框、或自动保存/发送扫描打断输入（表现为"页面刷新/断点"）。
  function isEditingForm(){
    const ae = document.activeElement;
    return !!(ae && (
      ae.tagName === 'TEXTAREA'
      || (ae.tagName === 'INPUT' && !['button','submit','checkbox','radio','file','hidden'].includes(ae.type))
    ));
  }
  function scheduleAutoSave(){
    const tip = $('#saveTip');
    if(tip) tip.textContent = '编辑中…';
    if(saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(silentSave, 600);
  }
  // 输入元素失焦时立即保存（防止 1 秒 debounce 内切走焦点导致 silentSave 不跑）
  function flushAutoSave(){
    if(saveTimer){ clearTimeout(saveTimer); saveTimer = null; }
    return silentSave();
  }
  async function silentSave(){
    if(!project || !currentProjectId) return;
    project.updatedAt = new Date().toISOString();
    // 同步内存里 projects[] 数组（推送概览 buildOverviewRows 优先从这里取最新数据）——
    // 这样当前页面改完设置 → render() 即可看到新值，不用切页/刷新。
    const syncProjects = ()=>{
      if(!projects) projects = [];
      const idx = projects.findIndex(p=>p.id===currentProjectId);
      // 深拷贝（JSON.parse/stringify）防止 project 后续修改反向污染 projects[]
      const snapshot = JSON.parse(JSON.stringify(project));
      if(idx >= 0) projects[idx] = snapshot;
      else projects.push(snapshot);
    };
    // [v10.2 root-fix] silentSave 完成后追加一次即时 overview 刷新（不破坏 input 焦点）。
    // 由于 silentSave 的内存 projects[] 已与最新 merged 对齐，再触发一次 pollOverview
    // 即可让"推送概览"列（状态/实际发送）立刻更新，免等 12s 轮询。
    // 同时传 force:true 让 clientSendDue 立即扫一遍 30min 内的待发节点——
    // 用户改完时间 → silentSave → force 扫描 → 立即生效（如果通知距 now 在 30min 内）。
    const triggerInstantOverviewRefresh = ()=>{
      // 仅刷新「推送概览」展示数据（状态/实际发送列）。
      // 注意：绝不在此触发发送扫描。发送扫描属于「notifyAt change 事件」(见 1747 行) 与
      // 60s 定时器(send-due) 的职责；若放进自动保存，用户每敲一个字停顿 600ms 都会跑一次
      // DB 写/发送逻辑，既打断正在输入的文本框，又可能在用户还在写正文时就把通知发出去。
      queueMicrotask(()=>{
        try{
          if(typeof pollOverview==='function') pollOverview();
        }catch(e){}
      });
    };
    if(SERVER_MODE){
      try{
        // 写前先拉服务端权威字段（scheduler 也会写 sentAt/sentAudiences），merge 后再写
        let {local: merged, dirty} = {local: project, dirty: false};
        try{
          const rr = await fetch('/api/project/'+currentProjectId);
          if(rr.ok){
            const jj = await rr.json();
            if(jj.project) ({local: merged, dirty} = mergeCloudAuthorityFields(project, jj.project));
          }
        }catch(e){}
        await fetch('/api/project/'+currentProjectId, {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(merged)});
        project = merged;
        syncProjects();
        const tip=$('#saveTip'); if(tip) tip.textContent = '已自动保存 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
        // 保存成功后**不要立即重渲染**——会打断用户在 textarea / input 中输入（光标丢失）。
        // 仅当焦点不在表单元素上时才轻量 render，让"发送时间/状态"等列更新。
        const ae = document.activeElement;
        const inForm = ae && (
              ae.tagName === 'TEXTAREA'
              || (ae.tagName === 'INPUT' && !['button','submit','checkbox','radio','file'].includes(ae.type))
            );
        if(!inForm) render();
        triggerInstantOverviewRefresh();
      }catch(e){ const tip=$('#saveTip'); if(tip) tip.textContent = '保存失败：'+e.message; toast('保存失败，请检查登录态或服务端', {tone:'warn'}); }
    }else if(_sb){
      // 写云端前先拉一次最新 cloud，用 mergeCloudAuthorityFields 把 Action/scheduler 写的
      // sentAt/sentAudiences/reminder1dSentAt/reminder2hSentAt/sent 状态保留下来——避免前端
      // silentSave 把内存 stale project 写到云端、覆盖掉 scheduler/Action 的最新写入。
      let {local: merged, dirty} = {local: project, dirty: false};
      try{ ({local: merged, dirty} = await fetchCloudMerge(project)); }catch(e){}
      // [v10.7.18] 若 merge 识别出旧记录并清空本地，必须立即写回云端，防止旧版本标签页
      // 反复把旧状态污染到云端；否则 pollOverview 只能清空本地内存，云端仍脏，UI 会持续闪烁。
      if(dirty){
        merged.updatedAt = new Date().toISOString();
      }
      await cloudSet('project:'+currentProjectId, merged);
      // 把 merged 同步回内存，保证后续编辑/渲染不再丢失云端权威字段
      try{
        const idx = (projects||[]).findIndex(p=>p.id===currentProjectId);
        if(idx>=0) projects[idx] = JSON.parse(JSON.stringify(merged));
      }catch(e){}
      project = merged;
      syncProjects();
      const tip=$('#saveTip'); if(tip) tip.textContent = '已自动保存 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      const ae = document.activeElement;
      const inForm = ae && (
            ae.tagName === 'TEXTAREA'
            || (ae.tagName === 'INPUT' && !['button','submit','checkbox','radio','file'].includes(ae.type))
          );
      if(!inForm) render();
      triggerInstantOverviewRefresh();
    }else{
      localStorage.setItem('tn_v10_'+currentProjectId, JSON.stringify(project));
      let list = JSON.parse(localStorage.getItem('tn_v10_projects')||'[]');
      const idx = list.findIndex(x=>x.id===currentProjectId);
      const meta = {id:currentProjectId, name:project.projectName||'未命名项目', updatedAt:project.updatedAt, startDate:project.startDate, endDate:project.endDate, owner:project.owner, category:project.category, totalStages:project.stages.length};
      if(idx>=0) list[idx]=meta; else list.push(meta);
      localStorage.setItem('tn_v10_projects', JSON.stringify(list));
      syncProjects();
      const tip=$('#saveTip'); if(tip) tip.textContent = '已自动保存 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
      // 同上：仅焦点不在表单时 render
      const ae = document.activeElement;
      const inForm = ae && (
            ae.tagName === 'TEXTAREA'
            || (ae.tagName === 'INPUT' && !['button','submit','checkbox','radio','file'].includes(ae.type))
          );
      if(!inForm) render();
      triggerInstantOverviewRefresh();
    }
  }

  // ---------- 改时间重置 [v10.7.5] 共用辅助 ----------
  // 单条 notifyAt input change handler 与「批量改时间」弹窗 apply 都必须调用这两步：
  //   ① 清掉"已发送"权威字段（推送概览双校验 → 显示草稿/已暂停，不再伪装"已发送"）
  //   ② 清云端 tn_sends 旧 claim（避免旧 sendId 阻塞新窗口的 claim，定时主链路才能再发）
  // [v10.7.5 root-fix] 批量改时间弹窗直接 r.ac.notifyAt = v 后 scheduleAutoSave，从来不调
  //   原单条 notifyAt change handler 里的清理逻辑 → 云端 n.sentAt/sentAudiences 残留，
  //   推送概览显示"已发送 + 旧 sentAt"，云端定时发送判定 n.sentAudiences.includes(aud)
  //   永远命中→跳过，整条通知永远不会再被定时发出去（用户截图实证）。
  function resetSentStateOnNotifyChange(n, ac){
    if(!n || !ac) return false;
    // 当前必须有过"已发送"痕迹才需要重置（无则 skip，避免无意义 tn_sends 清理）
    const had = (Array.isArray(n.sentAudiences) && n.sentAudiences.length>0)
             || !!n.sentAt
             || !!n.reminder1dSentAt
             || !!n.reminder2hSentAt
             || n.status === 'sent';
    if(!had) return false;
    // 1) 清本地内存权威字段
    n.sentAudiences = [];
    n.sentAt = null;
    n.reminder1dSentAt = null;
    n.reminder2hSentAt = null;
    n.status = 'paused';
    // [v10.7.14 root-fix] 给通知打"重置时间戳"：
    //   mergeCloudAuthorityFields/pollOverview 会周期性把云端旧 sentAt 拉回内存，
    //   若用户刚改时间重置过，必须拒绝复活早于该时间戳的旧发送记录。
    //   当云端 scheduler 真实发送后，新的 sentAt 必然晚于 _resetAt，届时正常复活并清除标记。
    n._resetAt = Date.now();
    // 2) 清受众级（运营人提示）
    ac.sendAttempts = 0;
    ac.lastError = '';
    ac.status = 'paused';
    ac.autoSend = false;       // 安全默认：改时间后必须让人重新确认
    delete ac._lastTriggerSig;
    return true;
  }

  // 通知级别的 tn_sends 清理（按 pid:nid 一次性删 main/reminder1d/reminder2h 所有变体）
  // 返回清除的 (pid,nid,aud) 三元组集合，供调用方决定要不要做后续 cloudSet 覆盖
  async function cleanTnSendsForNotification(pid, nid, audList){
    const dirty = (Array.isArray(audList) && audList.length > 0) ? audList : ['student','lecturer','manager'];
    if(!_sb || !pid || !nid) return;
    for(const aud of dirty){
      try{
        const { error } = await _sb.from('tn_sends').delete().like('id', `${pid}:${nid}:${aud}:%`);
        if(error) console.warn('[cleanTnSends]', pid, nid, aud, error.message);
      }catch(e){ console.warn('[cleanTnSends] exception', pid, nid, aud, e.message); }
    }
  }

  // ---------- 视图切换 ----------
  function setView(v, pid){
    view = v;
    if(v==='edit'){ editSection='meta'; loadProject(pid).then(()=>{ render(); }); }
    else { homeSection='all'; loadProjectList().then(()=>{ render(); }); }
  }
  function setHomeSection(s){ homeSection=s; render(); }
  function setEditSection(s){ editSection=s; render(); }

  // ---------- 客户端 send-due 兜底 ----------
  // [v10.2 root-fix] GitHub Actions schedule 在新仓库（无 star / 无 watch）实际触发率不稳定，
  // 我们用纯客户端心跳兜底：每 60s 扫一遍 projects[]，对 "now 到 now+30min" 内的 autoSend=true
  // 且未发送过的节点，立即调 cloudSend()，再用 tn_sends 主键做幂等（与 Action 共用契约）。
  let clientSendDueInFlight = false;
  // [v10.2 root-fix] 客户端 send-due 兜底：
  //   GitHub Actions schedule 在零活动仓库（无 star / 无 watch）实测触发率极低——
  //   本仓库 3 次实测全是 workflow_dispatch，0 次 schedule。
  //   所以我们用 setInterval 60s 扫一遍 projects[]，把"now ±30min"内、autoSend=true 且未发的节点，
  //   立即调 cloudSend()。用 tn_sends 主键做 claim 幂等——Action/客户端不会重复发送。
  //
  //   options.force = true 用于 silentSave 后立即触发：跳过 30min 上限检查，
  //   让"刚改完时间 + 立即生效"成为默认行为（用户在编辑器里改时间 → silentSave →
  //   force 扫描 → 如果通知距 now 在 30min 内，立即发；否则等下一次 60s 周期）。
  async function clientSendDue(options){
    options = options || {};
    if(!_sb) return;
    if(clientSendDueInFlight) return;     // 防重入
    clientSendDueInFlight = true;
    try{
      // 焦点保护：用户正在编辑表单时不发送，避免"打字时通知被发出"的打断感。
      // 云端定时调度(send-due-scheduled)是主链路、不依赖浏览器，不受此限；浏览器兜底仅在空闲时发送。
      // ignoreFocus：notifyAt change 事件处显式传入，确保"改完时间立即生效"不被焦点保护误杀。
      if(!options.ignoreFocus && isEditingForm()) return;
      const now = Date.now();
      // 一次性拉已 sent 的 tn_sends 行，避免反复查
      let sentIds = new Set();
      try{
        const { data } = await _sb.from('tn_sends').select('id').eq('status','sent');
        sentIds = new Set((data||[]).map(x=>x.id));
      }catch(e){ /* 单条失败也继续走 */ }
      for(const p of (projects||[])){
        if(!p || !p.stages) continue;
        for(const s of p.stages){
          for(const n of (s.notifications||[])){
            for(const a of AUDIENCES){
              const ac = n.audienceContent && n.audienceContent[a];
              if(!ac || !ac.enabled || !ac.notifyAt) continue;
              if(ac.autoSend===false) continue;           // 用户显式暂停的不发
              const at = parseNotifyAtBeijing(ac.notifyAt);
              if(isNaN(at)) continue;
              const diffMs = now - at;
              // 窗口：60s 周期看 (now-30s, now+30min]；force 模式（silentSave 后立即）放宽到 (now-30min, now+30min]
              // 注意 force 仍受下限 -30min 保护，避免重复发送已过期 30min+ 的旧节点
              const lowerBound = options.force ? -30*60*1000 : -30*1000;
              const upperBound = 30*60*1000;
              if(diffMs < lowerBound || diffMs > upperBound) continue;
              // 已发送过（双重判定：内存 / 云端 tn_sends）
              if(Array.isArray(n.sentAudiences) && n.sentAudiences.includes(a) && n.sentAt) continue;
              const pid = p.id || currentProjectId || '';
              const sendId = `${pid}:${n.id}:${a}:main`;
              if(sentIds.has(sendId)) continue;
              try{
                const { data: existing } = await _sb.from('tn_sends').select('id').eq('id', sendId).single();
                if(existing){ sentIds.add(sendId); continue; }
              }catch(e){ /* 不阻断流程 */ }
              // claim：用 tn_sends 主键做幂等；如果 Action 也试图发，会因为 23505 失败跳过
              const { error: claimErr } = await _sb.from('tn_sends').insert({
                id: sendId, status:'claimed',
                claimed_by:'client-'+(window.__tn_client_id||'wb'),
                claimed_at:new Date().toISOString()
              });
              if(claimErr){
                if(claimErr.code==='23505'){ sentIds.add(sendId); continue; }
                console.warn('[clientSendDue] claim failed', sendId, claimErr.message);
                continue;
              }
              // 拼装 items（替换 ac 内容里的占位符；buildItemsForAudience 会套 globalGroups）
              const items = buildItemsForAudience(s, n, a);
              if(items.length===0){
                await _sb.from('tn_sends').update({
                  status:'failed', last_error:'无启用目标群',
                  updated_at:new Date().toISOString()
                }).eq('id', sendId);
                continue;
              }
              const j = await cloudSend(items, false);
              if(j && j.success){
                const sentAt = new Date().toISOString();
                await _sb.from('tn_sends').update({
                  status:'sent', sent_at:sentAt, updated_at:sentAt
                }).eq('id', sendId);
                sentIds.add(sendId);
                // 内存同步：n.sentAudiences + sentAt + status
                if(!Array.isArray(n.sentAudiences)) n.sentAudiences = [];
                if(!n.sentAudiences.includes(a)) n.sentAudiences.push(a);
                n.sentAt = sentAt;
                n.status = 'sent';
                console.log('[clientSendDue] OK', sendId);
                // 顺手触发一次轻量 UI 刷新（不破坏用户在编辑状态）
                if(typeof pollOverview==='function') pollOverview();
              } else {
                const err = (j && (j.error || (j.results||[]).map(x=>x.error).filter(Boolean).join('; '))) || '未知错误';
                await _sb.from('tn_sends').update({
                  status:'failed', last_error:err,
                  updated_at:new Date().toISOString()
                }).eq('id', sendId);
                console.warn('[clientSendDue] FAIL', sendId, err);
              }
            }
          }
        }
      }
    }catch(e){ console.warn('[clientSendDue] error:', e.message); }
    finally{ clientSendDueInFlight = false; }
  }

  // 推送概览实时轮询：服务端 scheduler 写入 sentAt/sentAudiences 后，前端内存里的
  // project/projects[] 是陈旧的——靠 silentSave 同步只在用户编辑时触发，没法覆盖 scheduler 发完通知的更新。
  // 这里 12s 拉一次 /api/projects，让"状态/实际发送"列自动跟上服务端真实值，避免"要强制刷新才更新"。
  let overviewPollTimer = null;
  let overviewPollInFlight = false;
  async function pollOverview(){
    if(SERVER_MODE){
      if(overviewPollInFlight) return;        // 防止上一次还没回来又触发
      overviewPollInFlight = true;
      try{
        const r = await fetch('/api/projects');
        if(!r.ok) return;
        const j = await r.json();
        const fresh = j.projects || [];
        if(view==='edit' && currentProjectId && project){
          const latest = fresh.find(p=>p.id===currentProjectId);
          // 编辑视图下不整把替换 project（会覆盖用户未保存的编辑），只 merge cloud 权威字段
          if(latest){
            const {local: merged, dirty} = mergeCloudAuthorityFields(project, latest);
            project = merged;
            // [v10.7.18] 把 merge 后的干净状态同步回 projects[]，
            //   否则 buildOverviewRows(true) 仍从 projects 数组取到旧 fresh 数据。
            const pidx = fresh.findIndex(p=>p.id===currentProjectId);
            if(pidx>=0) fresh[pidx] = merged;
            // [v10.7.18] 发现旧记录污染时立即写回云端，防止旧版本标签页反复覆盖
            if(dirty && typeof silentSave==='function') silentSave();
          }
        }
        projects = fresh;
        const isHomeOverview = view==='list' && homeSection==='overview';
        const isProjectOverview = view==='edit' && editSection==='overview';
        // 焦点保护：用户正在编辑表单（textarea/input）时不重建 DOM，
        // 否则 12s 轮询会刷新掉正在输入的文本框（用户感知的"自动保存打断输入/页面刷新"）。
        if(isEditingForm()) return;
        if(isHomeOverview){
          const sc = document.querySelector('#app');
          const st = sc ? sc.scrollTop : 0;
          renderHomeMain();
          if(sc) sc.scrollTop = st;
        } else if(isProjectOverview){
          renderProjectMain();
        }
      }catch(e){ /* 网络抖动忽略，下一轮再试 */ }
      finally{ overviewPollInFlight = false; }
    }else if(_sb){
      if(overviewPollInFlight) return;
      overviewPollInFlight = true;
      try{
        const fresh = await cloudListProjects();
        if(view==='edit' && currentProjectId && project){
          const latest = fresh.find(p=>p.id===currentProjectId);
          // 编辑视图下不整把替换 project（会覆盖用户未保存的编辑），只 merge cloud 权威字段
          if(latest){
            const {local: merged, dirty} = mergeCloudAuthorityFields(project, latest);
            project = merged;
            // [v10.7.18] 把 merge 后的干净状态同步回 projects[]，
            //   否则 buildOverviewRows(true) 仍从 projects 数组取到旧 fresh 数据。
            const pidx = fresh.findIndex(p=>p.id===currentProjectId);
            if(pidx>=0) fresh[pidx] = merged;
            // [v10.7.18] 发现旧记录污染时立即写回云端，防止旧版本标签页反复覆盖
            if(dirty && typeof silentSave==='function') silentSave();
          }
        }
        projects = fresh;
        const isHomeOverview = view==='list' && homeSection==='overview';
        const isProjectOverview = view==='edit' && editSection==='overview';
        // 焦点保护：用户正在编辑表单（textarea/input）时不重建 DOM，
        // 否则 12s 轮询会刷新掉正在输入的文本框（用户感知的"自动保存打断输入/页面刷新"）。
        if(isEditingForm()) return;
        if(isHomeOverview){
          const sc = document.querySelector('#app');
          const st = sc ? sc.scrollTop : 0;
          renderHomeMain();
          if(sc) sc.scrollTop = st;
        } else if(isProjectOverview){
          renderProjectMain();
        }
      }catch(e){ /* 网络抖动忽略，下一轮再试 */ }
      finally{ overviewPollInFlight = false; }
    }
  }

  // ---------- 渲染 ----------
  function render(){
    const headerActions = $('#headerActions');
    // 已登录标识：render() 每次都会清 headerActions.innerHTML，所以这里在末尾重建一份
    const renderAuthIndicator = ()=>{
      if(!headerActions) return;
      if(getAuthToken()){
        headerActions.innerHTML = '<span class="auth-indicator">● 已登录 <a href="#" id="authLogout" style="margin-left:6px;color:#2563eb;cursor:pointer">退出</a></span>';
        const lo = $('#authLogout');
        if(lo) lo.addEventListener('click', e=>{
          e.preventDefault();
          setAuthToken('');
          document.body.classList.add('auth-pending');
          const m = document.getElementById('authMask');
          if(m){ m.classList.add('show'); m.style.display=''; }
          renderAuthIndicator();
          // 重新刷新页面以彻底清掉内存中的项目数据
          location.reload();
        });
      } else {
        headerActions.innerHTML = '';
      }
    };
    if(view==='list'){
      $('#breadcrumb').textContent='项目列表';
      $('#saveTip').textContent='';
      headerActions.innerHTML='';
      renderHomeSidebar();
      renderHomeMain();
      renderAuthIndicator();
    }else{
      $('#breadcrumb').innerHTML = `<span class="sub">项目列表</span> / <b>${esc(project.projectName||'未命名项目')}</b> <button class="primary" id="btnBackToList">返回</button>`;
      $('#btnBackToList').addEventListener('click',()=>setView('list'));
      headerActions.innerHTML = '';
      renderProjectSidebar();
      renderProjectMain();
      renderAuthIndicator();
    }
    // 推送概览实时轮询的启停：
    // 1) 数据层（合并 cloud sentAt/sentAudiences/status）：只要 _sb 连上就常驻跑，setInterval 8s。
    //    关键修复：旧版只在 isOverviewView 才启动 timer，导致用户停在编辑视图时 cloud 更新看不到。
    // 2) DOM 渲染：仍只在 isOverviewView 触发 renderHomeMain / renderProjectMain，
    //    避免在用户编辑时强制重渲染造成光标跳动、编辑冲突。
    // [v10.2 root-fix] 客户端 send-due 兜底定时器：
    // GitHub Actions schedule 在新仓库（小流量、零 star、零 watch）的实际触发率不稳定。
    // 我们给客户端加一个 60s 心跳：在 now 到 now+30min 窗口内的"autoSend=true 且未发送"节点，立即用 cloudSend 直发。
    // 仍然复用 Action 一样的 tn_sends 主键做 claim 幂等，Action / 客户端不会重复发送。
    const _sbReady = !SERVER_MODE && !!_sb;
    if(_sbReady || SERVER_MODE){
      if(!overviewPollTimer){
        overviewPollTimer = setInterval(pollOverview, 8000);
        pollOverview();
      }
      if(typeof window.__tn_client_send_due_running==='undefined'){
        window.__tn_client_send_due_running = true;
        setInterval(clientSendDue, 60_000);
        setTimeout(clientSendDue, 5000);  // 首跑：5s 后先扫一遍，把过期未发的补上
      }
    }else{
      if(overviewPollTimer){ clearInterval(overviewPollTimer); overviewPollTimer = null; }
    }
    // 当浏览器标签页重新可见时也立即拉一次（避免运营人切回标签页还看到旧数据）
    if(typeof window.__tn_visibility_bound === 'undefined'){
      window.__tn_visibility_bound = true;
      document.addEventListener('visibilitychange', ()=>{
        const ov = (view==='list' && homeSection==='overview') || (view==='edit' && editSection==='overview');
        if(!document.hidden && ov && (SERVER_MODE || _sb)) pollOverview();
      });
      window.addEventListener('focus', ()=>{
        const ov = (view==='list' && homeSection==='overview') || (view==='edit' && editSection==='overview');
        if(ov && (SERVER_MODE || _sb)) pollOverview();
      });
    }
  }

  // ---------- 主页 ----------
  function renderHomeSidebar(){
    const sb = $('#sidebar'); sb.innerHTML='';
    const nav = (icon,text,active,click)=>{
      const d=document.createElement('div'); d.className='nav-item'+(active?' active':''); d.innerHTML=`${icon}<span>${text}</span>`; d.addEventListener('click',click); return d;
    };
    // 全局搜索
    const searchDiv = document.createElement('div'); searchDiv.className='home-search';
    searchDiv.innerHTML = `<div class="search-wrap"><span class="search-icon">🔍</span><input type="search" id="homeSearch" placeholder="搜索项目、负责人、内容…" value="${esc(listSearch)}"></div>`;
    sb.appendChild(searchDiv);
    $('#homeSearch', sb).addEventListener('input',e=>{ listSearch=e.target.value.toLowerCase(); renderHomeMain(); });

    sb.appendChild(nav('📋','推送概览',homeSection==='overview',()=>setHomeSection('overview')));
    sb.appendChild(nav('📁','全部项目',homeSection==='all',()=>setHomeSection('all')));

    // 分类目录
    const cats = getCategories();
    if(cats.length>0){
      sb.appendChild(document.createElement('div')).className='nav-sep'; sb.lastChild.textContent='分类目录';
      cats.forEach(c=>{
        sb.appendChild(nav('🏷️', c, homeSection===c, ()=>setHomeSection(c)));
      });
    }

    sb.appendChild(document.createElement('div')).className='nav-sep'; sb.lastChild.textContent='操作';
    sb.appendChild(nav('➕','新建项目',false,newProjectFlow));
    sb.appendChild(nav('👥','群通讯录',false,()=>{ renderGroups(); $('#groupsModal').classList.add('show'); }));
    sb.appendChild(nav('📝','文案模板',false,openTemplateManager));
  }

  function getCategories(){
    const set = new Set();
    projects.forEach(p=>{ if(p.category) set.add(p.category); });
    return Array.from(set).sort((a,b)=>a.localeCompare(b,'zh-CN'));
  }

  function renderHomeMain(){
    const app = $('#app'); app.innerHTML='';
    if(homeSection==='overview'){
      app.appendChild(buildOverviewPanel(false));
      return;
    }
    // 项目列表
    let list = projects.slice();
    const cat = homeSection==='all' ? null : homeSection;
    if(cat) list = list.filter(p=>p.category===cat);
    if(listSearch){
      list = list.filter(p=>{
        const hay = [(p.projectName||p.name), p.owner, p.category, p.purpose, p.description].join(' ').toLowerCase();
        return hay.includes(listSearch);
      });
    }
    list.sort((a,b)=>{
      if(listSort==='startAsc') return (a.startDate||'').localeCompare(b.startDate||'') || new Date(b.updatedAt||0)-new Date(a.updatedAt||0);
      if(listSort==='updateDesc') return new Date(b.updatedAt||0)-new Date(a.updatedAt||0);
      return (b.startDate||'').localeCompare(a.startDate||'') || new Date(b.updatedAt||0)-new Date(a.updatedAt||0);
    });

    // 顶部工具栏
    const years = Array.from(new Set(projects.map(p=>p.startDate?p.startDate.slice(0,4):''))).filter(Boolean).sort().reverse();
    const toolbar = document.createElement('div'); toolbar.className='home-topbar';
    toolbar.innerHTML = `
      <div class="field" style="max-width:150px"><label style="font-size:11px;color:var(--sub)">排序</label>
        <select id="listSort"><option value="startDesc" ${listSort==='startDesc'?'selected':''}>开始时间（新→旧）</option><option value="startAsc" ${listSort==='startAsc'?'selected':''}>开始时间（旧→新）</option><option value="updateDesc" ${listSort==='updateDesc'?'selected':''}>最近更新</option></select>
      </div>
      <div class="field" style="max-width:120px"><label style="font-size:11px;color:var(--sub)">年度</label>
        <select id="listYear"><option value="">全部年度</option>${years.map(y=>`<option value="${esc(y)}" ${listYear===y?'selected':''}>${esc(y)}</option>`).join('')}</select>
      </div>
      <div class="toolbar-right"><span class="sub">${list.length} 个项目</span></div>`;
    app.appendChild(toolbar);
    $('#listSort').addEventListener('change',e=>{listSort=e.target.value;renderHomeMain();});
    $('#listYear').addEventListener('change',e=>{listYear=e.target.value;renderHomeMain();});
    if(listYear) list = list.filter(p=>p.startDate && p.startDate.startsWith(listYear));

    if(list.length===0){
      app.appendChild(document.createElement('div')).className='section-empty';
      app.lastChild.textContent = cat ? '该分类下没有项目。' : '没有匹配的项目，点击左侧「新建项目」开始。';
      return;
    }
    list.forEach(p=>{
      const d=document.createElement('div'); d.className='proj-card';
      const pname = p.projectName || p.name || '未命名项目';
      const meta=[];
      if(p.startDate && p.endDate) meta.push(`${p.startDate} ~ ${p.endDate}`);
      else if(p.startDate) meta.push(`开始 ${p.startDate}`);
      if(p.owner) meta.push(`负责人：${esc(p.owner)}`);
      const stages = Array.isArray(p.stages) ? p.stages.length : (p.totalStages||0);
      const notifs = Array.isArray(p.stages) ? p.stages.reduce((a,s)=>a+(s.notifications||[]).length,0) : (p.totalNotifications||0);
      meta.push(`${stages} 阶段 · ${notifs} 通知`);
      const tags=[];
      if(p.category) tags.push(`<span class="tag brand">${esc(p.category)}</span>`);
      d.innerHTML = `<div class="title">${esc(pname)}</div>
        <div class="proj-meta">${esc(meta.join(' · '))}</div>
        <div>${tags.join('')}</div>
        <div class="actions" style="margin-top:10px">
          <button class="primary" data-id="${p.id}">编辑</button>
          <button class="ghost danger" data-del="${p.id}">删除</button>
        </div>`;
      d.querySelector('[data-id]').addEventListener('click',(e)=>{ e.stopPropagation(); setView('edit', p.id); });
      d.querySelector('[data-del]').addEventListener('click',(e)=>{ e.stopPropagation(); deleteProject(p.id); });
      app.appendChild(d);
    });
  }

  // ---------- 项目页 ----------
  function renderProjectSidebar(){
    const sb = $('#sidebar'); sb.innerHTML='';
    const nav = (icon,text,active,click)=>{
      const d=document.createElement('div'); d.className='nav-item'+(active?' active':''); d.innerHTML=`${icon}<span>${text}</span>`; d.addEventListener('click',click); return d;
    };
    sb.appendChild(nav('ℹ️','项目信息',editSection==='meta',()=>setEditSection('meta')));
    sb.appendChild(nav('✨','智能识别',editSection==='parse',()=>setEditSection('parse')));
    sb.appendChild(nav('📋','推送概览',editSection==='overview',()=>setEditSection('overview')));
    sb.appendChild(nav('📁','通知列表',editSection==='notifs',()=>setEditSection('notifs')));
    sb.appendChild(nav('🗓️','系列推送',editSection==='series',()=>setEditSection('series')));

    // 通知树：直接挂在「通知列表」下方
    const tree = document.createElement('div'); tree.className='nav-tree';
    if(project.stages.length===0){
      tree.innerHTML = '<p class="sub" style="padding:6px 8px;font-size:12px">暂无阶段</p>';
    }else{
      project.stages.forEach((s,si)=>{
        const totalNotif = s.notifications ? s.notifications.length : 0;
        const stageEl = document.createElement('div'); stageEl.className='nav-stage';
        stageEl.innerHTML = `<span>${s.collapsed?'▶':'▼'}</span><span>${esc(s.name||`阶段 ${si+1}`)}</span><small style="margin-left:auto;color:var(--sub)">${totalNotif}</small>`;
        stageEl.addEventListener('click',()=>{
          // 左侧导航只负责跳转定位，不改变阶段折叠状态
          setEditSection('notifs');
          render();
          setTimeout(()=>{
            const el=document.getElementById('stage-'+s.id);
            if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
          }, 50);
        });
        tree.appendChild(stageEl);
        if(!s.collapsed && s.notifications){
          s.notifications.forEach((n,ni)=>{
            const notifEl = document.createElement('div'); notifEl.className='nav-notif';
            notifEl.innerHTML = `<span class="dot" style="background:${n.status==='sent'?'var(--ok)':n.status==='failed'?'var(--err)':'var(--sub)'}" title="状态"></span><span>${esc(n.name||'通知')}</span>`;
            notifEl.addEventListener('click',()=>{
              // 点击通知时确保所属阶段和通知本身展开，便于定位查看
              s.collapsed = false;
              n.collapsed = false;
              setEditSection('notifs');
              render();
              setTimeout(()=>{
                const el=document.getElementById('notif-'+n.id);
                if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
              }, 50);
            });
            tree.appendChild(notifEl);
          });
        }
      });
    }
    sb.appendChild(tree);
    sb.appendChild(nav('➕','添加阶段',false,()=>{ project.stages.push(defaultStage()); setEditSection('notifs'); render(); scheduleAutoSave(); }));
  }

  function renderProjectMain(){
    const app = $('#app'); app.innerHTML='';
    if(editSection==='meta') app.appendChild(renderProjectMeta());
    else if(editSection==='parse') app.appendChild(renderSmartIdentifySection());
    else if(editSection==='overview') app.appendChild(buildOverviewPanel(true));
    else if(editSection==='series') app.appendChild(renderSeriesSection());
    else app.appendChild(renderNotificationsSection());
  }

  function renderProjectMeta(){
    const card = document.createElement('div'); card.className='card'; card.id='meta';
    const selectedIds = new Set(project.associatedGroupIds||[]);
    const selectedGroups = sortGroups(globalGroups.filter(g=>selectedIds.has(g.id)));
    const selectedPills = selectedGroups.length
      ? selectedGroups.map(g=>`<span class="pill ${g.type}">${GROUPS_LABEL[g.type]||g.type}</span> ${esc(g.name)}`).join(' · ')
      : '<span class="sub">尚未选择关联群，写通知时会显示全部通讯录。</span>';

    const categories = getCategories();
    const catOptions = categories.map(c=>`<option value="${esc(c)}" ${project.category===c?'selected':''}>${esc(c)}</option>`).join('');

    card.innerHTML = `<h3>项目信息</h3>
      <div class="meta-grid">
        <div class="field"><label>项目名称</label><input type="text" data-k="projectName" value="${esc(project.projectName||'')}" placeholder="如：A+经理人培训"></div>
        <div class="field"><label>项目开始</label><input type="date" data-k="startDate" value="${esc(project.startDate||'')}"></div>
        <div class="field"><label>项目结束</label><input type="date" data-k="endDate" value="${esc(project.endDate||'')}"></div>
        <div class="field"><label>负责人</label><input type="text" data-k="owner" value="${esc(project.owner||'')}" placeholder="培训运营负责人"></div>
        <div class="field" style="min-width:200px"><label>分类 <span class="sub">（非必填）</span></label>
          <div class="row" style="margin:0;gap:6px">
            <input list="categoryOptions" type="text" data-k="category" value="${esc(project.category||'')}" placeholder="选择或输入新分类" style="flex:1">
            <button class="ghost mini-btn" id="btnManageCat" type="button">管理</button>
          </div>
          <datalist id="categoryOptions">${catOptions}</datalist>
        </div>
        <div class="field" style="grid-column:1/-1"><label>培训目的</label><textarea data-k="purpose" placeholder="培训目标、背景说明">${esc(project.purpose||'')}</textarea></div>
        <div class="field" style="grid-column:1/-1"><label>项目描述 / 备注</label><textarea data-k="description" placeholder="其他项目级说明">${esc(project.description||'')}</textarea></div>
        <div class="field" style="grid-column:1/-1"><label>整体安排 <span class="sub">（非必填，可用于项目启动通知或任意节点；支持文字，图片功能待上线后统一调整）</span></label><textarea data-k="overallArrangement" placeholder="如：本次培训采用“线上测评 + 微课学习 + 线下授课 + 返岗实践”四位一体的 O2O 翻转学习模式…">${esc(project.overallArrangement||'')}</textarea></div>
      </div>
      <h4 style="margin-top:14px">项目关联群</h4>
      <p class="hint">设置关联群后，写通知时只显示这些群，避免在大量通讯录中反复查找。</p>
      <div class="assoc-bar ${selectedGroups.length?'':'empty'}">
        <div style="flex:1">${selectedPills}</div>
        <button class="ghost mini-btn" id="btnPickAssoc">${selectedGroups.length?'重新选择':'从通讯录选择'}</button>
      </div>`;
    $$('[data-k]',card).forEach(inp=>{
      const handler = ()=>{ project[inp.dataset.k]=inp.value; scheduleAutoSave(); };
      inp.addEventListener('input', handler);
      // 失焦/回车时立即落盘，避免 1 秒 debounce 期间切走导致 silentSave 不跑
      // （之前踩过的坑：用户改了项目名立刻切走 → server 文件 projectName 字段丢失 → 项目列表兜底显示"未命名项目"）
      inp.addEventListener('blur', flushAutoSave);
      if(inp.tagName==='INPUT' && inp.type==='text') inp.addEventListener('keydown', e=>{ if(e.key==='Enter') flushAutoSave(); });
    });
    $('#btnPickAssoc',card).addEventListener('click', openAssocPicker);
    $('#btnManageCat',card).addEventListener('click', openCategoryManager);
    return card;
  }

  function renderParseSection(){
    const wrap = document.createElement('div'); wrap.className='identify-block';
    const draft = project._parseDraft || {};
    wrap.innerHTML = `<div class="section-title" style="margin-top:18px"><h4>识别培训方案</h4></div>
      <p class="sub">粘贴培训方案/日程文本，自动提取阶段与学习任务（测试功能，提取后请人工核对）。</p>
      <textarea id="parseInput" style="min-height:160px" placeholder="例如：
阶段一：线上学习（8月1日-8月7日）
任务1：微课学习（截止8月5日）
任务2：填写调研问卷（截止8月7日）
阶段二：线下集训（8月10日-8月12日）
..."></textarea>
      <div class="actions" style="justify-content:flex-end;margin-top:10px">
        <button class="ghost" id="btnClearParse" type="button">清空</button>
        <button class="primary" id="btnDoParseInline">识别并预览</button>
      </div>
      <div id="parseResult"></div>`;
    const ta = $('#parseInput',wrap); ta.value = draft.text || '';
    const res = $('#parseResult',wrap);
    if(draft.results && draft.results.length) renderParsePreview(res, draft.results);
    $('#btnDoParseInline',wrap).addEventListener('click', doParse);
    $('#btnClearParse',wrap).addEventListener('click',()=>{ ta.value=''; res.innerHTML=''; delete project._parseDraft; scheduleAutoSave(); });
    return wrap;
  }
  function renderParsePreview(box, newStages){
    const taskCount = newStages.reduce((a,s)=>a+s.tasks.length,0);
    let html = `<div class="copyrec-table" style="margin-top:14px">`;
    newStages.forEach((s,i)=>{
      const tasks = s.tasks.map(t=>`${esc(t.name||'未命名任务')}${t.dueDate?'（截止 '+t.dueDate+'）':''}`).join('、') || '（无任务）';
      html += `<div class="copyrec-row" style="align-items:flex-start">
        <span class="cr-stage">${esc(s.name||'阶段 '+(i+1))}</span>
        <span class="cr-aud">${s.startDate||s.endDate?(s.startDate||'')+(s.endDate?' ~ '+s.endDate:''):'未识别时间'}</span>
        <span class="cr-preview">${esc(tasks)}</span>
      </div>`;
    });
    html += `</div>
    <div class="actions" style="margin-top:10px">
      <button class="ghost" id="btnCancelParse" type="button">取消</button>
      <button class="primary" id="btnConfirmParse">确认导入 ${newStages.length} 个阶段、${taskCount} 个任务</button>
    </div>`;
    box.innerHTML = html;
    $('#btnCancelParse',box).addEventListener('click',()=>{ box.innerHTML=''; delete project._parseDraft; scheduleAutoSave(); });
    $('#btnConfirmParse',box).addEventListener('click',()=>{
      project.stages = project.stages.concat(newStages);
      delete project._parseDraft;
      scheduleAutoSave();
      editSection = 'notifs';
      render();
      toast('已导入 '+newStages.length+' 个阶段、'+taskCount+' 个任务，请人工核对');
    });
  }
  function renderSmartIdentifySection(){
    const card = document.createElement('div'); card.className='card';
    card.innerHTML = `<h3>智能识别</h3>
      <p class="sub">将培训方案或通知文案批量粘贴进来，自动解析为结构化的阶段/任务或受众通知。提取结果请人工核对后再导入。</p>`;
    card.appendChild(renderParseSection());
    card.appendChild(renderCopyRecSection());
    return card;
  }

  function renderNotificationsSection(){
    const frag = document.createDocumentFragment();
    if(project.stages.length===0){
      const empty = document.createElement('div'); empty.className='section-empty';
      empty.textContent = '还没有阶段，点击左侧「添加阶段」开始。';
      frag.appendChild(empty);
      return frag;
    }
    project.stages.forEach((stage,si)=> frag.appendChild(renderStage(stage,si)));
    return frag;
  }

  // ---------- 阶段 / 任务 / 通知 ----------
  function renderStage(stage, si){
    const card = document.createElement('div'); card.className='stage'+(stage.collapsed?' collapsed':''); card.id='stage-'+stage.id;
    const datesText = (stage.startDate||stage.endDate) ? `${stage.startDate||''} ~ ${stage.endDate||''}` : '';
    card.innerHTML = `<div class="stage-head">
      <button class="fold-btn" data-act="foldStage">${stage.collapsed?'▶':'▼'}</button>
      <input type="text" data-k="name" value="${esc(stage.name)}" placeholder="阶段名称">
      <span class="dates">${esc(datesText)}</span>
      <button class="ghost danger mini-btn" data-act="delStage" style="margin-left:auto">删除</button>
    </div>
    <div class="stage-body">
      <div class="stage-info-block">
        <div class="section-title" style="margin-top:0"><h4>基础信息</h4></div>
        <div class="row" style="align-items:flex-end;margin-bottom:8px">
          <div class="field" style="max-width:170px"><label>阶段开始时间</label><input type="date" data-k="startDate" value="${esc(stage.startDate)}" placeholder="开始日期"></div>
          <div class="field" style="max-width:110px"><label>&nbsp;<span class="sub">（非必填）</span></label><input type="time" data-k="startTime" value="${esc(stage.startTime)}" placeholder="--:--"></div>
          <div class="field" style="max-width:170px"><label>阶段结束时间</label><input type="date" data-k="endDate" value="${esc(stage.endDate)}" placeholder="结束日期"></div>
          <div class="field" style="max-width:110px"><label>&nbsp;<span class="sub">（非必填）</span></label><input type="time" data-k="endTime" value="${esc(stage.endTime)}" placeholder="--:--"></div>
        </div>
        <div class="row" style="align-items:flex-end;margin-bottom:8px">
          <div class="field" style="flex:1;min-width:200px"><label>地点 / 会议链接 <span class="sub">（非必填）</span></label><input type="text" data-k="placeOrLink" value="${esc(stage.placeOrLink)}" placeholder="线上请填链接，线下请填场地"></div>
        </div>
        <div class="row" style="align-items:flex-end;margin-bottom:8px">
          <div class="field" style="flex:1;min-width:200px"><label>识别关键词 <span class="sub">（非必填，识别文案时自动归类用，逗号分隔，如：报名,开营,课前）</span></label><input type="text" data-k="keywords" value="${esc(stage.keywords)}" placeholder="如：报名,开营,课前"></div>
        </div>
        <div class="section-title" style="margin-top:16px"><h4>学习任务</h4><button class="ghost mini-btn" data-act="addTask">+ 添加任务</button></div>
        <div data-tasklist></div>
      </div>
      <div class="notif-settings-block">
        <div class="section-title" style="margin-top:0"><h4>通知设置</h4><button class="ghost mini-btn" data-act="addNotif">+ 添加通知</button></div>
        <div data-notiflist></div>
      </div>
    </div>`;
    const head = card.querySelector('.stage-head');
    head.querySelector('[data-act="foldStage"]').addEventListener('click',()=>{ stage.collapsed=!stage.collapsed; render(); });
    head.querySelector('[data-act="delStage"]').addEventListener('click',()=>{ if(confirm('确认删除该阶段及其下所有任务与通知？')){ project.stages.splice(si,1); render(); scheduleAutoSave(); }});
    $$('[data-k]',head).forEach(inp=> inp.addEventListener('input',()=>{ stage[inp.dataset.k]=inp.value; scheduleAutoSave(); renderProjectSidebar(); }));
    const pub = card.querySelector('.stage-info-block');
    const startDateInp = pub.querySelector('[data-k="startDate"]');
    const endDateInp = pub.querySelector('[data-k="endDate"]');
    function validateStageDates(){
      if(stage.startDate && stage.endDate && stage.startDate > stage.endDate){
        toast('开始日期不能晚于结束日期');
        return false;
      }
      return true;
    }
    $$('[data-k]',pub).forEach(inp=>{
      if(inp.dataset.k==='startDate' || inp.dataset.k==='endDate'){
        inp.addEventListener('change',()=>{
          const old = stage[inp.dataset.k];
          stage[inp.dataset.k]=inp.value;
          if(stage.startDate && stage.endDate && stage.startDate > stage.endDate){
            toast('开始日期不能晚于结束日期');
            stage[inp.dataset.k]=old;
            inp.value=old;
            return;
          }
          syncStageHeadDates();
          scheduleAutoSave();
        });
      }else{
        inp.addEventListener('input',()=>{
          stage[inp.dataset.k]=inp.value;
          scheduleAutoSave();
        });
      }
    });
    const dateSpan = head.querySelector('.dates');
    function syncStageHeadDates(){
      const dt = (stage.startDate||stage.endDate) ? `${stage.startDate||''} ~ ${stage.endDate||''}` : '';
      if(dateSpan) dateSpan.textContent = dt;
    }
    card.querySelector('[data-act="addTask"]').addEventListener('click',()=>{ stage.tasks.push(defaultTask()); render(); scheduleAutoSave(); });
    card.querySelector('[data-act="addNotif"]').addEventListener('click',()=>{ stage.notifications.push(defaultNotification()); render(); scheduleAutoSave(); });
    const tl = card.querySelector('[data-tasklist]');
    if(stage.tasks.length===0) tl.innerHTML='<p class="sub">暂无学习任务</p>';
    else stage.tasks.forEach((t,ti)=> tl.appendChild(renderTask(stage,t,ti)));
    const nl = card.querySelector('[data-notiflist]');
    if(stage.notifications.length===0) nl.innerHTML='<p class="sub">暂无通知</p>';
    else stage.notifications.forEach((n,ni)=> nl.appendChild(renderNotification(stage,n,ni)));
    return card;
  }

  function renderTask(stage, task, ti){
    const d = document.createElement('div'); d.className='task'+(task.collapsed?' collapsed':'');
    d.innerHTML = `<div class="task-head">
      <button class="fold-btn">${task.collapsed?'▶':'▼'}</button>
      <input type="text" data-k="name" value="${esc(task.name)}" placeholder="任务名称">
      <button class="ghost danger mini-btn" data-act="delTask">删除</button>
    </div>
    <div class="task-meta-row">
      <label>截止日期</label>
      <input type="date" data-k="dueDate" value="${esc(task.dueDate)}" placeholder="年/月/日">
    </div>
    <div class="task-body">
      <div class="field"><label>任务内容 / 说明</label><textarea data-k="description" placeholder="任务要求、操作步骤等">${esc(task.description)}</textarea></div>
      <h4 style="margin:8px 0 4px">附件</h4>
      <div data-attlist></div>
      <button class="ghost mini-btn" data-act="addAtt">+ 添加附件</button>
    </div>`;
    d.querySelector('.task-head').addEventListener('click',(e)=>{ if(e.target.closest('input')||e.target.closest('button')) return; task.collapsed=!task.collapsed; render(); });
    d.querySelector('.fold-btn').addEventListener('click',(e)=>{ e.stopPropagation(); task.collapsed=!task.collapsed; render(); });
    d.querySelector('[data-act="delTask"]').addEventListener('click',()=>{ stage.tasks.splice(ti,1); render(); scheduleAutoSave(); });
    d.querySelector('[data-act="addAtt"]').addEventListener('click',()=>{ task.attachments.push(defaultAttachment()); render(); scheduleAutoSave(); });
    $$('[data-k]',d).forEach(inp=>{
      inp.addEventListener('input',()=>{
        task[inp.dataset.k]=inp.value;
        if(inp.dataset.k==='name'||inp.dataset.k==='dueDate') syncTaskLabel(task);
        scheduleAutoSave();
      });
    });
    const al = d.querySelector('[data-attlist]');
    if(task.attachments.length===0) al.innerHTML='<p class="sub">暂无附件</p>';
    else task.attachments.forEach((a,ai)=> al.appendChild(renderAttachment(task,a,ai)));
    return d;
  }
  function syncTaskLabel(task){
    const text = (task.name||'未命名任务') + (task.dueDate?` (截止 ${task.dueDate})`:'') + (task.description?' · 有说明':'');
    document.querySelectorAll(`label[data-taskid="${task.id}"] .tntext`).forEach(span=> span.textContent = text);
  }
  function renderAttachment(task, att, ai){
    const d = document.createElement('div'); d.className='att-item';
    const isImage = att.type === 'image';
    d.innerHTML = `<div class="row">
        <div class="field" style="max-width:120px"><label>类型</label><select data-k="type"><option value="link" ${!isImage?'selected':''}>链接</option><option value="image" ${isImage?'selected':''}>图片</option></select></div>
        <div class="field"><label>附件名称</label><input type="text" data-k="name" value="${esc(att.name)}" placeholder="如：A+经理人日程表"></div>
        <div class="field" style="flex:1.5"><label>${isImage?'图片 URL':'链接地址'}</label><div style="display:flex;gap:4px;align-items:center"><input type="text" data-k="url" value="${esc(att.url)}" placeholder="https://..." style="flex:1">${isImage?'<button class="ghost mini-btn" data-act="attUpload" type="button" title="上传图片到图床，自动填入 URL">📷 上传</button><input type="file" accept="image/*" hidden data-att-img>':''}</div></div>
        <div class="field link-text-field" style="max-width:160px;${isImage?'display:none':''}"><label>链接显示文字</label><input type="text" data-k="linkText" value="${esc(att.linkText)}" placeholder="留空显示 URL"></div>
        <button class="ghost danger mini-btn" data-act="delAtt" style="margin-bottom:8px">删除</button>
      </div>`;
    $$('[data-k]',d).forEach(inp=>{
      if(inp.dataset.k==='type'){
        inp.addEventListener('change',()=>{
          att.type = inp.value;
          render(); scheduleAutoSave();
        });
      }else{
        inp.addEventListener('input',()=>{ att[inp.dataset.k]=inp.value; scheduleAutoSave(); });
      }
    });
    d.querySelector('[data-act="delAtt"]').addEventListener('click',()=>{ task.attachments.splice(ai,1); render(); scheduleAutoSave(); });
    // 📷 上传图片到图床并自动填入 URL
    const attUploadBtn = d.querySelector('[data-act="attUpload"]');
    const attFileInput = d.querySelector('[data-att-img]');
    if(attUploadBtn && attFileInput){
      attUploadBtn.addEventListener('click',()=> attFileInput.click());
      attFileInput.addEventListener('change', async ()=>{
        const rawFile = attFileInput.files[0]; if(!rawFile) return;
        if(rawFile.size > 5*1024*1024){ toast('图片超过 5MB，请压缩后再上传'); attFileInput.value=''; return; }
        // [v10.7.3] 浏览器端压缩：任务附件图最长边 480px，作为文字流里的缩略图
        // （企微 PC 端 inline 渲染会按消息区宽度放大图片，800px 在 PC 上会撑满，480px 更稳）
        const { file, compressed, w, h } = await compressImageFile(rawFile, 480);
        const urlInp = d.querySelector('input[data-k="url"]');
        const nameInp = d.querySelector('input[data-k="name"]');
        const reader = new FileReader();
        reader.onload = async ()=>{
          try{
            let j;
            if(SERVER_MODE){
              const r = await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:reader.result})});
              j = await r.json();
            }else if(_sb){
              j = await cloudUpload(reader.result);
            }else{
              toast('本地预览模式无法上传图片，请用本地服务'); attFileInput.value=''; return;
            }
            if(j && j.success){
              if(urlInp && !urlInp.value) urlInp.value = j.url;
              if(nameInp && !nameInp.value) nameInp.value = file.name.replace(/\.[^.]+$/, '');
              att.url = urlInp ? urlInp.value : j.url;
              att.name = nameInp ? nameInp.value : (file.name.replace(/\.[^.]+$/, ''));
              scheduleAutoSave();
              if(compressed){ toast(`附件图片已压缩至 ${w}×${h}`); }
              else { toast('附件图片已上传'); }
            } else { toast('上传失败：'+(j.error||'未知错误')); }
          }catch(e){ toast('上传异常：'+e.message); }
          attFileInput.value='';
        };
        reader.readAsDataURL(file);
      });
    }
    return d;
  }

    function renderNotification(stage, n, ni){
    if(!n.audienceContent) n.audienceContent={ student:defaultAudienceConfig(), lecturer:defaultAudienceConfig(), manager:defaultAudienceConfig() };
    AUDIENCES.forEach(a=>{ if(!n.audienceContent[a]) n.audienceContent[a]=defaultAudienceConfig(); });
    if(!(n.id in activeAud)) activeAud[n.id] = 'student';
    if(n.collapsed===undefined) n.collapsed = false;

    const d = document.createElement('div'); d.className='notif'+(n.collapsed?' collapsed':''); d.id='notif-'+n.id;
    const statusPill = n.status==='sent' ? '<span class="pill sent">已发送</span>' : (n.status==='failed'?'<span class="pill failed">失败</span>':'<span class="pill draft">草稿</span>');

    d.innerHTML = `<div class="notif-head">
      <button class="fold-btn">${n.collapsed?'&#9654;':'&#9660;'}</button>
      <input type="text" data-k="name" value="${esc(n.name)}" placeholder="建议按节点命名，如：学习阶段启动通知、中程提醒、截止前提醒">
      ${statusPill}
      <div class="notif-actions">
        <button class="ghost mini-btn" data-act="copyNotif" title="基于此通知复制一份：文案/任务勾选保留，目标群与发送时间会清空">复制</button>
        <button class="ghost danger mini-btn" data-act="delNotif">删除</button>
      </div>
    </div>
    <div class="notif-body">
      <div class="tabs" data-tabs></div>
      <div data-audpanel></div>
    </div>`;

    const head = d.querySelector('.notif-head');
    head.querySelector('.fold-btn').addEventListener('click',(e)=>{ e.stopPropagation(); n.collapsed=!n.collapsed; render(); });
    head.addEventListener('click',(e)=>{ if(e.target.closest('input')||e.target.closest('button')||e.target.closest('.pill')) return; n.collapsed=!n.collapsed; render(); });
    d.querySelector('[data-k="name"]').addEventListener('input',e=>{ n.name=e.target.value; scheduleAutoSave(); renderProjectSidebar(); });
    d.querySelector('[data-act="delNotif"]').addEventListener('click',()=>{ if(confirm('确认删除该通知？')){ stage.notifications.splice(ni,1); render(); scheduleAutoSave(); }});
    d.querySelector('[data-act="copyNotif"]').addEventListener('click',(e)=>{ e.stopPropagation(); openCopyNotifModal(stage, n); });

    const tabsWrap = d.querySelector('[data-tabs]');
    AUDIENCES.forEach(a=>{
      const ac = n.audienceContent[a];
      const t = document.createElement('div'); t.className='tab'+(activeAud[n.id]===a?' active':'');
      t.innerHTML = `${GROUPS_LABEL[a]}${ac.enabled?'<span class="dot"></span>':''}`;
      t.addEventListener('click',()=>{ activeAud[n.id]=a; render(); });
      tabsWrap.appendChild(t);
    });
    const panel = d.querySelector('[data-audpanel]');
    panel.appendChild(renderAudience(stage,n,activeAud[n.id]));
    return d;
  }

  // === 复制通知助手 ===
  // 复制一份 ac，targetGroups/notifyAt/enabled 全部清空避免意外触发
  function copyAudienceContent(src){
    return {
      content: src.content || '',
      taskIds: Array.isArray(src.taskIds) ? src.taskIds.slice() : [],
      taskOrder: Array.isArray(src.taskOrder) ? src.taskOrder.slice() : [],
      notifyAt: '',
      enabled: false,
      targetGroups: [],
      useTemplate: src.useTemplate || false,
      _templateId: src._templateId || '',
      _templateSnapshot: src._templateSnapshot || '',
      templateOutdated: src.templateOutdated || false,
      inputMode: src.inputMode || '',
      remarks: src.remarks || '',
    };
  }
  function buildCopiedNotification(src){
    const copy = {
      id: uid(),
      name: (src.name || '未命名通知') + '（副本）',
      node: src.node || 'start',
      audienceContent: {
        student: copyAudienceContent(src.audienceContent.student || {}),
        lecturer: copyAudienceContent(src.audienceContent.lecturer || {}),
        manager: copyAudienceContent(src.audienceContent.manager || {}),
      },
      status: 'draft',
      sentAt: null,
      sendAttempts: 0,
      sentAudiences: [],
      collapsed: false,
    };
    copy.audienceContent.student._copiedFrom = src.id;
    copy.audienceContent.lecturer._copiedFrom = src.id;
    copy.audienceContent.manager._copiedFrom = src.id;
    return copy;
  }
  // 复制到指定阶段，弹浮层模态让用户选阶段 + 命名
  function openCopyNotifModal(srcStage, srcNotif){
    const old = document.getElementById('copyNotifModal');
    if(old) old.remove();
    const mask = document.createElement('div');
    mask.className = 'modal-mask show';
    mask.id = 'copyNotifModal';
    const d = document.createElement('div');
    d.className = 'modal';
    d.style.maxWidth = '520px';
    const stageOptions = (project.stages||[]).map((s,i)=>{
      const lbl = `${i+1}. ${s.name||'阶段 '+(i+1)}` + (s.id===srcStage.id?'（本阶段）':'');
      return `<option value="${esc(s.id)}" ${s.id===srcStage.id?'selected':''}>${esc(lbl)}</option>`;
    }).join('');
    d.innerHTML = `
      <h3>复制通知</h3>
      <p class="sub">原通知：${esc(srcNotif.name||'未命名')}</p>
      <div style="margin: 14px 0 8px"><label>新通知名称</label><input type="text" id="copyNotifName" value="${esc((srcNotif.name||'未命名通知')+'（副本）')}" style="width:100%;padding:6px;margin-top:4px"></div>
      <div style="margin: 14px 0 8px"><label>复制到阶段</label><select id="copyNotifStage" style="width:100%;padding:6px;margin-top:4px">${stageOptions}</select></div>
      <div style="background:#fef9c3;border:1px solid #fde68a;border-radius:4px;padding:10px;margin:14px 0 4px;font-size:13px;color:#713f12">
        <strong>复制规则</strong>
        <ul style="margin:6px 0 0 16px;padding:0">
          <li>文案内容、任务勾选、附件链接 完整复制</li>
          <li><strong>目标群、发送时间 会清空</strong>（避免无意触发）</li>
          <li>三个受众默认停用（启用开关关闭），需打开后才真发</li>
          <li><code>{{阶段名}}</code> <code>{{阶段时间}}</code> <code>{{任务列表}}</code> 等变量按所选目标阶段实时读取</li>
        </ul>
      </div>
      <div style="display:flex;gap:8px;justify-content:flex-end;margin-top:18px">
        <button class="ghost" id="copyNotifCancel">取消</button>
        <button class="primary" id="copyNotifConfirm">复制</button>
      </div>
    `;
    mask.appendChild(d);
    document.body.appendChild(mask);
    $('#copyNotifCancel', mask).addEventListener('click',()=>{ mask.remove(); });
    mask.addEventListener('click',(e)=>{ if(e.target===mask) mask.remove(); });
    $('#copyNotifConfirm', mask).addEventListener('click',()=>{
      const name = $('#copyNotifName', mask).value.trim() || '（副本）';
      const targetStageId = $('#copyNotifStage', mask).value;
      const targetStage = (project.stages||[]).find(s=>s.id===targetStageId);
      if(!targetStage){ toast('目标阶段不存在'); return; }
      const newNotif = buildCopiedNotification(srcNotif);
      newNotif.name = name;
      targetStage.notifications.push(newNotif);
      scheduleAutoSave();
      mask.remove();
      render();
      const tab = editSection; // 切到 notifs 区域让用户看到新通知
      setEditSection('notifs');
      toast(`已复制到「${targetStage.name||'未命名阶段'}」`);
    });
  }

    function renderAudience(stage, n, aud){
    const ac = n.audienceContent[aud];
    const groups = getAudienceGroups(aud);
    const pick = groups.length ? groups.map(g=>`<label class="chk"><input type="checkbox" class="gpick" value="${g.id}" ${(ac.targetGroups||[]).includes(g.id)?'checked':''}> ${esc(g.name)}${g.type!==aud?` <span class="sub">（${g.type==='test'?'测试':g.type==='student'?'学员':g.type==='lecturer'?'讲师':'管理'}）</span>`:''}</label>`).join('') : '<span class="sub">通讯录中暂无任何群，请到「群通讯录」添加。</span>';
    const outdatedTpl = isTemplateOutdated(ac);

    const baseIds = stage.tasks.map(t=>t.id);
    let orderedIds = (ac.taskOrder && ac.taskOrder.length) ? ac.taskOrder.slice() : baseIds.slice();
    baseIds.forEach(id=>{ if(!orderedIds.includes(id)) orderedIds.push(id); });
    const taskOpts = orderedIds.map(id=>{
      const t = stage.tasks.find(x=>x.id===id);
      if(!t) return '';
      const text = (t.name||'未命名任务') + (t.dueDate?` (截止 ${t.dueDate})`:'' ) + (t.description?' · 有说明':'');
      return `<label class="chk" data-taskid="${t.id}" draggable="true" style="cursor:move" title="拖拽可调整该通知中的任务顺序"><input type="checkbox" class="taskpick" value="${t.id}" ${(ac.taskIds||[]).includes(t.id)?'checked':''}><span class="tntext">${esc(text)}</span></label>`;
    }).filter(Boolean).join('') || '<span class="sub">该阶段暂无任务，请先添加任务</span>';

    const fieldGroups = [
      {label:'项目信息', fields:[{v:'{{项目名}}',l:'项目名'},{v:'{{负责人}}',l:'负责人'},{v:'{{培训目的}}',l:'培训目的'},{v:'{{整体安排}}',l:'整体安排'},{v:'{{项目开始}}',l:'项目开始'},{v:'{{项目结束}}',l:'项目结束'}]},
      {label:'阶段信息', fields:[{v:'{{阶段名}}',l:'阶段名'},{v:'{{阶段开始时间}}',l:'阶段开始时间'},{v:'{{阶段结束时间}}',l:'阶段结束时间'},{v:'{{地点/链接}}',l:'地点/链接'}]},
      {label:'任务信息', fields:[{v:'{{任务列表}}',l:'任务列表'}]}
    ];

    const d = document.createElement('div'); d.className='aud-panel';
    const isPaste = ac.inputMode==='paste';
    d.innerHTML = `
      <div class="section-title" style="margin-top:0"><h4>发送目标群 · ${GROUPS_LABEL[aud]}</h4></div>
      <div class="group-pick">${pick}</div>
      <div class="row" style="align-items:center;margin:10px 0 14px;gap:10px">
        <label class="chk" style="margin:0"><input type="checkbox" id="ena-${n.id}-${aud}"> 启用并发送给以上目标群</label>
      </div>
      <div class="section-title"><h4>发送时间</h4></div>
      <div class="row" style="align-items:flex-end;margin-bottom:14px">
        <div class="field" style="max-width:220px"><input type="datetime-local" data-k="notifyAt" value="${esc(ac.notifyAt)}"></div>
        <label class="chk" style="margin-bottom:8px"><input type="checkbox" data-k="autoSend"> 自动发送</label>
      </div>
      ${(ac.autoSend===false && ac.notifyAt) ? `<div class="auto-paused-chip" data-auto-paused-chip style="background:#fff3e0;border:1px solid #f59e0b;border-radius:6px;padding:8px 12px;margin-bottom:14px;font-size:12px;color:#9a4f00;display:flex;align-items:center;gap:6px"><span style="font-size:14px">⚠</span><span>自动发送已暂停——确认所有信息（文案/受众群/任务）后再勾选「自动发送」</span></div>` : ''}
      <div data-template-only ${isPaste?'hidden':''}>
        <div class="section-title"><h4>关联学习任务</h4></div>
        <div class="group-pick" data-taskwrap>${taskOpts}</div>
      </div>
      <div class="section-title" style="margin-top:14px"><h4>通知文案</h4></div>
      <div class="seg-wrap" style="margin:8px 0 10px">
        <span class="seg-label">录入方式</span>
        <div class="seg" data-seg="inputMode">
          <button type="button" data-mode="template" class="${!isPaste?'active':''}">模板配置</button>
          <button type="button" data-mode="paste" class="${isPaste?'active':''}">直接粘贴</button>
        </div>
      </div>
      <div class="hint" style="margin:0 0 8px;line-height:1.7">
        ${isPaste
          ? '直接粘贴模式：文案框内容将原样发送。支持 <code>**文字**</code> 加粗、<code>[标题](链接)</code> 链接、<code>![说明](URL)</code> inline 图片。'
          : '支持 markdown_v2 语法：<code>**[文字]**</code> 加粗、<code>[标题](链接)</code> 链接、<code>![说明](URL)</code> inline 图片。点击「插入字段」选择动态变量；手动修改文案与字段按钮不会反向改动模板内容。'}
      </div>
      <div class="row" style="display:flex;gap:6px;margin:6px 0;align-items:center;flex-wrap:wrap" data-template-only ${isPaste?'hidden':''}>
        <button class="ghost mini-btn" data-act="applyTemplate" type="button">选择模板</button>
        <div class="field-dropdown" data-field-dropdown>
          <button class="ghost mini-btn" type="button">插入字段 ▼</button>
          <div class="menu">
            ${fieldGroups.map(g=>`<div class="menu-group">${esc(g.label)}</div>`+g.fields.map(f=>`<div class="menu-item" data-var="${esc(f.v)}">${esc(f.l)} <code style="color:var(--sub)">${esc(f.v)}</code></div>`).join('')).join('')}
          </div>
        </div>
        <button class="ghost mini-btn" data-act="uploadImg" type="button" title="上传图片到图床并插入通知正文">上传图片</button>
        <input type="file" accept="image/*" hidden data-img-input>
      </div>
      ${outdatedTpl ? `<div class="tpl-warn" data-template-only ${isPaste?'hidden':''} style="background:#fffbe8;border:1px solid #ffe7a3;border-radius:6px;padding:8px 10px;margin:8px 0;font-size:12px;color:#8c6a00;display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
        <span>&#9888; 该文案使用的模板「${esc(outdatedTpl.label)}」已更新，是否使用最新版本？</span>
        <span style="display:flex;gap:6px">
          <button class="ghost mini-btn" data-act="keepOldTpl">保留当前文案</button>
          <button class="primary mini-btn" data-act="useNewTpl" data-tplid="${esc(outdatedTpl.id)}">使用新版</button>
        </span>
      </div>` : ''}
      <textarea class="aud-content" data-aud="${aud}" placeholder="在此编写${GROUPS_LABEL[aud]}版文案">${esc(ac.content)}</textarea>
      <div class="actions">
        <button class="ghost" data-act="previewAll">预览全部</button>
        <span class="btn-split" data-test-split>
          <button class="ghost" data-act="testSendCurrent" type="button">发送至测试群</button>
          <button class="ghost" data-toggle="testSendMenu" type="button">▼</button>
          <div class="dropdown-menu" data-menu="testSendMenu">
            <div class="dropdown-item" data-act="testSendCurrent">仅 ${esc(GROUPS_LABEL[aud])}</div>
            <div class="dropdown-item" data-act="testSendAll">此通知全部启用受众</div>
          </div>
        </span>
        <span class="btn-split" data-send-split>
          <button class="primary" data-act="sendCurrent" type="button">立即发送</button>
          <button class="primary" data-toggle="sendMenu" type="button">▼</button>
          <div class="dropdown-menu" data-menu="sendMenu">
            <div class="dropdown-item" data-act="sendCurrent">仅 ${esc(GROUPS_LABEL[aud])}</div>
            <div class="dropdown-item" data-act="sendAll">此通知全部启用受众</div>
          </div>
        </span>
      </div>`;

    d.querySelector('[data-k="notifyAt"]').addEventListener('change', async e => {
      const oldAt = ac.notifyAt;
      const newAt = e.target.value;
      ac.notifyAt = newAt;
      // [v10.7.5] 改时间默认「取消勾选自动发送」——共用 resetSentStateOnNotifyChange：
      //   ① 清本地权威字段（推送概览不再"已发送"）
      //   ② await 删除云端 tn_sends（旧 sendId 阻塞新窗口的 claim 会让云端永远跳过）
      // [v10.7.12 root-fix] 任何时间变更（含首次从空设为新时间）都必须重置发送状态。
      //   旧条件 `oldAt && newAt` 导致首次设时间时跳过重置，旧 sentAudiences 残留 → 云端永远跳过。
      if(oldAt !== newAt){
        const hadSent = resetSentStateOnNotifyChange(n, ac);
        // [v10.2 root-fix] 立即改 DOM checkbox state（不依赖 render 重建）：
        //   Edge 浏览器对 innerHTML 重建 checkbox 时 prop/attr 偶发错位——
        //   先直接改 prop.checked = false，render() 再用 renderAudience 末尾的 prop 同步做兜底。
        const _as = e.target.closest('.aud-panel').querySelector('[data-k="autoSend"]');
        if(_as) _as.checked = false;
        // 1) 立即同步内存 projects[]（buildOverviewRows 优先从这里取）
        if(projects){
          const _idx = projects.findIndex(p=>p.id===currentProjectId);
          if(_idx>=0) projects[_idx] = JSON.parse(JSON.stringify(project));
        }
        // 2) 立即 render（不等 silentSave）
        render();
        // 3) [v10.7.5] await 清云端 tn_sends：必须等结果后再 cloudSet，否则 silentSave 抢先写云端项目，
        //   mergeCloudAuthorityFields 又把云端 sentAt 写回，改时间失效。
        if(hadSent && _sb && currentProjectId && n.id){
          await cleanTnSendsForNotification(currentProjectId, n.id, [aud]);
        }
        // 4) [v10.2 root-fix] 写云端项目：【不走 fetchCloudMerge】，直接 cloudSet 覆盖——
        //   关键！如果走 fetchCloudMerge，云端旧 sentAt 会被 mergeCloudAuthorityFields 写回本地。
        //   改时间场景的语义是「用户主动重置发送状态」，云端旧 sentAt 必须被覆盖。
        if(_sb && currentProjectId){
          try{
            await cloudSet('project:'+currentProjectId, project);
            const tip = $('#saveTip');
            if(tip) tip.textContent = '已自动保存 '+new Date().toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',second:'2-digit'});
          }catch(e){
            toast('保存失败：'+e.message, {tone:'warn'});
          }
        } else {
          // localStorage 模式：仍然异步保存即可
          scheduleAutoSave();
        }
        // 5) 单行 warn 提示，不换行
        toast('已修改发送时间，自动发送已暂停；确认信息无误后请勾选「自动发送」', {tone:'warn'});
        // 6) 立即触发一次 overview 刷新 + 客户端 send-due 兜底（不等 12s 轮询）
        queueMicrotask(()=>{
          try{
            if(typeof pollOverview==='function') pollOverview();
            if(typeof clientSendDue==='function') clientSendDue({force:true, ignoreFocus:true});
          }catch(e){}
        });
        return;
      }
      scheduleAutoSave();
    });
    d.querySelector('[data-k="autoSend"]').addEventListener('change',e=>{ ac.autoSend=e.target.checked; scheduleAutoSave(); });
    const ena = d.querySelector('#ena-'+n.id+'-'+aud);
    ena.addEventListener('change',e=>{ ac.enabled=e.target.checked; scheduleAutoSave(); render(); });
    // 录入方式切换
    const seg = d.querySelector('[data-seg="inputMode"]');
    seg.querySelectorAll('button').forEach(btn=>{
      btn.addEventListener('click',()=>{
        ac.inputMode = btn.dataset.mode;
        scheduleAutoSave();
        render();
      });
    });
    const ta = d.querySelector('.aud-content');
    ta.addEventListener('input',()=>{ ac.content=ta.value; scheduleAutoSave(); });
    ta.addEventListener('paste', e=> handlePaste(e, ta, ac));
    // 上传图片（点选文件 → Supabase Storage → 插入正文）
    const uploadBtn = d.querySelector('[data-act="uploadImg"]');
    const fileInput = d.querySelector('[data-img-input]');
    if(uploadBtn && fileInput){
      uploadBtn.addEventListener('click', ()=> fileInput.click());
      fileInput.addEventListener('change', async ()=>{
        const rawFile = fileInput.files[0]; if(!rawFile) return;
        if(rawFile.size > 5*1024*1024){ toast('图片超过 5MB，请压缩后再上传'); fileInput.value=''; return; }
        // [v10.7.3] 浏览器端压缩：通知正文图片最长边 800px（独立段落，保留视觉冲击）
        const { file, compressed, w, h } = await compressImageFile(rawFile, 800);
        const reader = new FileReader();
        reader.onload = async ()=>{
          try{
            let j;
            if(SERVER_MODE){
              const r = await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:reader.result})});
              j = await r.json();
            }else if(_sb){
              j = await cloudUpload(reader.result);
            }else{
              toast('本地预览模式无法上传图片，请用本地服务'); fileInput.value=''; return;
            }
            if(j && j.success){
              const alt = prompt('图片说明（显示在图片下方，可留空）','')||'图片';
              insertAtCursor(ta, `\n![${alt}](${j.url})\n`);
              ac.content = ta.value; scheduleAutoSave();
              const sizeKb = file ? Math.round(file.size/1024) : 0;
              const tip = compressed ? `图片已压缩到 ${w}×${h}（${sizeKb}KB）` : `图片已插入（${sizeKb}KB）`;
              toast(tip);
            } else { toast('上传失败：'+(j.error||'未知错误')); }
          }catch(e){ toast('上传异常：'+e.message); }
          fileInput.value='';
        };
        reader.readAsDataURL(file);
      });
    }
    // 字段下拉
    const fieldDropdown = d.querySelector('[data-field-dropdown]');
    if(fieldDropdown){
      const fieldMenu = fieldDropdown.querySelector('.menu');
      fieldDropdown.querySelector('button').addEventListener('click',(e)=>{ e.stopPropagation(); fieldMenu.classList.toggle('show'); });
      fieldMenu.querySelectorAll('.menu-item').forEach(item=> item.addEventListener('click',()=>{ insertAtCursor(ta, item.dataset.var); ac.content=ta.value; scheduleAutoSave(); fieldMenu.classList.remove('show'); }));
      document.addEventListener('click',(e)=>{ if(!fieldDropdown.contains(e.target)) fieldMenu.classList.remove('show'); });
    }
    $$('.gpick',d).forEach(cb=> cb.addEventListener('change',()=>{ ac.targetGroups = $$('.gpick:checked',d).map(x=>x.value); scheduleAutoSave(); }));
    $$('.taskpick',d).forEach(cb=> cb.addEventListener('change',()=>{ ac.taskIds = $$('.taskpick:checked',d).map(x=>x.value); scheduleAutoSave(); }));
    const applyTplBtn = d.querySelector('[data-act="applyTemplate"]');
    if(applyTplBtn) applyTplBtn.addEventListener('click',()=> openTemplatePicker(stage,n,aud));
    if(outdatedTpl){
      d.querySelector('[data-act="keepOldTpl"]').addEventListener('click',()=>{ ac.templateAppliedAt = new Date().toISOString(); scheduleAutoSave(); render(); });
      d.querySelector('[data-act="useNewTpl"]').addEventListener('click',()=>{ const t=getTemplateById(outdatedTpl.id); if(t){ applyTemplateToAudience(n,aud,t); scheduleAutoSave(); render(); } });
    }
    d.querySelector('[data-act="previewAll"]').addEventListener('click',()=> openPreviewAll(stage,n));
    bindSplitButton(d.querySelector('[data-test-split]'), (act)=>{ if(act==='testSendCurrent') openTestSend(n,aud); else doTestSendAll(n); });
    bindSplitButton(d.querySelector('[data-send-split]'), (act)=>{ if(act==='sendCurrent') sendNotification(stage,n,aud,false); else sendAllEnabledAudiences(stage,n,false); });

    const taskWrap = d.querySelector('[data-taskwrap]');
    let dragSrcId = null;
    if(taskWrap){
      $$('[data-taskid]', taskWrap).forEach(lbl=>{
        lbl.addEventListener('dragstart', e=>{
          dragSrcId = lbl.dataset.taskid;
          e.dataTransfer.effectAllowed = 'move';
          lbl.style.opacity = '0.5';
        });
        lbl.addEventListener('dragend', e=>{
          lbl.style.opacity = '';
          $$('[data-taskid]', taskWrap).forEach(x=> x.classList.remove('drag-over'));
        });
        lbl.addEventListener('dragover', e=>{
          e.preventDefault();
          e.dataTransfer.dropEffect = 'move';
          const target = e.target.closest('[data-taskid]');
          $$('[data-taskid]', taskWrap).forEach(x=> x.classList.remove('drag-over'));
          if(target && target.dataset.taskid !== dragSrcId) target.classList.add('drag-over');
        });
        lbl.addEventListener('dragleave', e=>{
          const target = e.target.closest('[data-taskid]');
          if(target) target.classList.remove('drag-over');
        });
        lbl.addEventListener('drop', e=>{
          e.preventDefault();
          const target = e.target.closest('[data-taskid]');
          $$('[data-taskid]', taskWrap).forEach(x=> x.classList.remove('drag-over'));
          if(!target || target.dataset.taskid === dragSrcId) return;
          const currentIds = $$('[data-taskid]', taskWrap).map(x=>x.dataset.taskid);
          const srcIdx = currentIds.indexOf(dragSrcId);
          const tgtIdx = currentIds.indexOf(target.dataset.taskid);
          if(srcIdx<0 || tgtIdx<0) return;
          const newIds = currentIds.slice();
          newIds.splice(srcIdx,1);
          newIds.splice(tgtIdx,0,dragSrcId);
          ac.taskOrder = newIds;
          ac.taskIds = newIds.filter(id=> ac.taskIds.includes(id));
          scheduleAutoSave();
          render();
        });
      });
    }
    // [v10.2 root-fix] 显式 prop 设置 checkbox 状态：
    // innerHTML 模板里用 ${cond?'checked':''} 偶尔会被 Edge 浏览器把 prop/attr 错位，
    // 导致 ac.autoSend=false 后 checkbox 仍显示 checked。这里用 JS 显式同步一次。
    const _enaInput = d.querySelector('#ena-'+n.id+'-'+aud);
    if(_enaInput) _enaInput.checked = !!ac.enabled;
    const _autoSendInput = d.querySelector('[data-k="autoSend"]');
    if(_autoSendInput) _autoSendInput.checked = ac.autoSend !== false;
    return d;
  }
  function bindSplitButton(wrap, callback){
    if(!wrap) return;
    const menu = wrap.querySelector('[data-menu]');
    wrap.querySelectorAll('[data-toggle]').forEach(btn=> btn.addEventListener('click',(e)=>{ e.stopPropagation(); menu.classList.toggle('show'); }));
    wrap.querySelectorAll('.dropdown-item').forEach(item=> item.addEventListener('click',(e)=>{ e.stopPropagation(); menu.classList.remove('show'); callback(item.dataset.act); }));
    wrap.querySelector('button:not([data-toggle])').addEventListener('click',(e)=>{ e.stopPropagation(); menu.classList.remove('show'); callback(wrap.querySelector('button:not([data-toggle])').dataset.act); });
    document.addEventListener('click',(e)=>{ if(!wrap.contains(e.target)) menu.classList.remove('show'); });
  }
  // ---------- 文案模板管理 ----------
  function openTemplatePicker(stage, n, aud){
    const nodeSel = $('#tplPickNode');
    const audSel = $('#tplPickAud');
    nodeSel.value = n.node || 'start';
    audSel.value = aud || 'student';

    function renderPickerList(){
      const node = nodeSel.value;
      const pickAud = audSel.value;
      const list = getTemplates(node, pickAud);
      const wrap = $('#templatePickerList'); wrap.innerHTML='';
      if(list.length===0){
        wrap.innerHTML = '<p class="sub">该节点和群类别下暂无模板，可切换筛选或到「文案模板」管理中新增。</p>';
        return;
      }
      list.forEach(t=>{
        const row = document.createElement('div'); row.className='picker-row';
        // 提取模板使用的占位符（{{xxx}} 形式）— 用于展示模板结构
        const varMatches = Array.from(new Set((t.content.match(/\{\{[^}]+\}\}/g) || [])));
        const varChips = varMatches.length
          ? `<div class="tpl-vars" style="margin-top:4px">${varMatches.map(v=>`<span class="tpl-chip">${esc(v)}</span>`).join('')}</div>`
          : `<div class="sub" style="font-size:11px;margin-top:4px">无动态字段</div>`;
        const previewId = 'tplPreview-' + t.id;
        row.innerHTML = `<div style="flex:1;min-width:0">
          <div style="font-weight:500">${esc(t.label)}</div>
          <div class="sub" style="font-size:11px;margin-top:2px">${esc(NODE_LABEL[t.node]||t.node)} · ${esc(GROUPS_LABEL[t.audience]||t.audience)} · 更新于 ${fmtDate(t.updatedAt)} · 字段 ${varMatches.length} 个</div>
          <div class="sub" style="font-size:11px;margin-top:2px;white-space:pre-wrap" data-preview="${previewId}">${esc(t.content.slice(0,80))}${t.content.length>80?'…':''}</div>
          <div id="${previewId}" style="display:none;margin-top:6px">
            <div class="tpl-preview-box">${esc(t.content)}</div>
            <div style="margin-top:6px">${varChips}</div>
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:6px;align-items:flex-end">
          ${t.content.length>80 ? `<button class="ghost mini-btn" data-toggle-preview="${previewId}">展开</button>` : ''}
          <button class="primary mini-btn" data-act="apply">应用</button>
        </div>`;
        // 展开/收起全文
        const tg = row.querySelector(`[data-toggle-preview="${previewId}"]`);
        if(tg){
          tg.addEventListener('click',(e)=>{
            e.stopPropagation();
            const box = row.querySelector('#'+previewId);
            const shown = box.style.display !== 'none';
            box.style.display = shown ? 'none' : 'block';
            tg.textContent = shown ? '展开' : '收起';
          });
        }
        row.querySelector('[data-act="apply"]').addEventListener('click',(e)=>{
          e.stopPropagation();
          if(acHasContent(n.audienceContent[aud]) && !confirm('应用模板会覆盖当前文案，是否继续？')) return;
          n.node = t.node;
          applyTemplateToAudience(n, aud, t);
          scheduleAutoSave();
          $('#templatePickerModal').classList.remove('show');
          render();
          toast('已应用模板：'+t.label);
        });
        wrap.appendChild(row);
      });
    }

    nodeSel.onchange = renderPickerList;
    audSel.onchange = renderPickerList;
    renderPickerList();
    $('#templatePickerModal').classList.add('show');
  }
  function acHasContent(ac){ return !!(ac && ac.content && ac.content.trim()); }

  let editingTemplateId = null;
  function openTemplateManager(){
    editingTemplateId = null;
    $('#templateModal').classList.add('show');
    $('#tplEditor').style.display='none';
    $('#tplFilterNode').value=''; $('#tplFilterAud').value=''; $('#tplSearch').value='';
    renderTemplateList();
    bindTemplateEditorEvents();
  }
  function bindTemplateEditorEvents(){
    const once = (id,evt,fn)=>{ const el=$(id); if(el && !el._bound){ el.addEventListener(evt,fn); el._bound=true; } };
    once('#btnNewTemplate','click',()=>{ editingTemplateId=null; showTemplateEditor(null); });
    once('#btnTplCancel','click',()=>{ $('#tplEditor').style.display='none'; });
    once('#btnTplSave','click',saveTemplateFromEditor);
    once('#btnTplPreview','click',previewTemplateFromEditor);
    once('#tplFilterNode','change',renderTemplateList);
    once('#tplFilterAud','change',renderTemplateList);
    once('#tplSearch','input',renderTemplateList);
    // 模板字段下拉
    const tplFieldDropdown = $('#tplFieldDropdown');
    const tplFieldMenu = $('#tplFieldMenu');
    if(tplFieldDropdown && !tplFieldDropdown._bound){
      tplFieldDropdown.querySelector('button').addEventListener('click',(e)=>{ e.stopPropagation(); tplFieldMenu.classList.toggle('show'); });
      tplFieldMenu.querySelectorAll('.tpl-var').forEach(item=> item.addEventListener('click',()=>{ const ta=$('#tplContent'); insertAtCursor(ta, item.dataset.var); tplFieldMenu.classList.remove('show'); }));
      document.addEventListener('click',(e)=>{ if(!tplFieldDropdown.contains(e.target)) tplFieldMenu.classList.remove('show'); });
      tplFieldDropdown._bound=true;
    }
  }
  function showTemplateEditor(t){
    editingTemplateId = t ? t.id : null;
    $('#tplEditorTitle').textContent = t ? '编辑模板' : '新建模板';
    $('#tplLabel').value = t ? t.label : '';
    $('#tplNode').value = t ? t.node : 'start';
    $('#tplAudience').value = t ? t.audience : 'student';
    $('#tplContent').value = t ? t.content : '';
    $('#tplEditor').style.display='block';
  }
  function saveTemplateFromEditor(){
    const label = $('#tplLabel').value.trim();
    const node = $('#tplNode').value;
    const audience = $('#tplAudience').value;
    const content = $('#tplContent').value;
    if(!label){ toast('请填写模板名称'); return; }
    if(!content.trim()){ toast('请填写模板内容'); return; }
    const now = new Date().toISOString();
    if(editingTemplateId){
      const idx = TEMPLATES.findIndex(t=>t.id===editingTemplateId);
      if(idx>=0) TEMPLATES[idx] = { ...TEMPLATES[idx], label, node, audience, content, updatedAt:now };
    }else{
      TEMPLATES.push({ id:'tpl-'+Date.now()+'-'+Math.random().toString(36).slice(2,6), label, node, audience, content, updatedAt:now });
    }
    saveTemplates();
    $('#tplEditor').style.display='none';
    renderTemplateList();
    render(); // 刷新通知编辑区模板更新提醒
    toast('模板已保存');
  }
  function previewTemplateFromEditor(){
    const content = $('#tplContent').value;
    if(!content.trim()){ toast('模板内容为空'); return; }
    $('#previewTitle').textContent = '模板预览';
    $('#previewBody').innerHTML = '<div class="wx-msg"><div class="wx-name">企业微信群 · 目标群</div><div class="wx-body">'+renderMdPreview(content)+'</div></div>';
    $('#previewModal').classList.add('show');
  }
  function deleteTemplate(id){
    if(!confirm('确认删除该模板？已应用此模板的通知将不再收到模板更新提醒。')) return;
    TEMPLATES = TEMPLATES.filter(t=>t.id!==id);
    saveTemplates();
    renderTemplateList();
    render();
    toast('模板已删除');
  }
  function renderTemplateList(){
    const nodeFilter = $('#tplFilterNode').value;
    const audFilter = $('#tplFilterAud').value;
    const kw = ($('#tplSearch').value||'').trim().toLowerCase();
    const wrap = $('#templateList'); wrap.innerHTML='';
    const list = TEMPLATES.filter(t=>{
      if(nodeFilter && t.node!==nodeFilter) return false;
      if(audFilter && t.audience!==audFilter) return false;
      if(kw && !(t.label||'').toLowerCase().includes(kw) && !(t.content||'').toLowerCase().includes(kw)) return false;
      return true;
    }).sort((a,b)=> new Date(b.updatedAt)-new Date(a.updatedAt));
    if(list.length===0){ wrap.innerHTML='<div class="empty">暂无符合条件的模板</div>'; return; }
    list.forEach(t=>{
      const row = document.createElement('div'); row.className='group-row';
      row.innerHTML = `<div class="name"><span class="pill ${t.audience}">${esc(GROUPS_LABEL[t.audience]||t.audience)}</span> ${esc(t.label)}<br><span class="sub">${esc(NODE_LABEL[t.node]||t.node)} · 更新于 ${fmtDate(t.updatedAt)}</span></div>
        <div class="url" style="white-space:pre-wrap">${esc(t.content.slice(0,180))}${t.content.length>180?'...':''}</div>
        <div style="display:flex;gap:6px;flex-shrink:0">
          <button class="ghost mini-btn" data-act="editTpl">编辑</button>
          <button class="ghost danger mini-btn" data-act="delTpl">删除</button>
        </div>`;
      row.querySelector('[data-act="editTpl"]').addEventListener('click',()=> showTemplateEditor(t));
      row.querySelector('[data-act="delTpl"]').addEventListener('click',()=> deleteTemplate(t.id));
      wrap.appendChild(row);
    });
  }
  function fmtDate(iso){ if(!iso) return '-'; try{ return new Date(iso).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'}); }catch(e){ return iso; } }

  function getProjectGroups(type){
    const associated = (project.associatedGroupIds||[]).map(id=>globalGroups.find(g=>g.id===id)).filter(Boolean);
    const list = associated.length ? associated : globalGroups;
    return type ? list.filter(g=>g.type===type) : list;
  }
  // 受众场景下的可选群：项目关联群（如未关联则用全部），同类别置顶，其他类别其后
  // 例如学员通知下也能选测试群，只是学员群排在前面
  function getAudienceGroups(aud){
    const associated = (project.associatedGroupIds||[]).map(id=>globalGroups.find(g=>g.id===id)).filter(Boolean);
    const list = associated.length ? associated : globalGroups;
    const same = list.filter(g=>g.type===aud);
    const others = list.filter(g=>g.type!==aud);
    return [...same, ...others];
  }
  function sortGroups(groups){
    return groups.slice().sort((a,b)=>{
      if(a.pinned && !b.pinned) return -1;
      if(!a.pinned && b.pinned) return 1;
      return (a.name||'').localeCompare(b.name||'', 'zh-CN');
    });
  }

  // ---------- 图片粘贴上传 ----------
  async function handlePaste(e, ta, ac){
    const items = e.clipboardData && e.clipboardData.items;
    if(!items) return;
    for(const it of items){
      if(it.type && it.type.startsWith('image/')){
        e.preventDefault();
        const blob = it.getAsFile();
        const reader = new FileReader();
        reader.onload = async ()=>{
          let url = reader.result;
          if(SERVER_MODE){
            try{
              const r = await fetch('/api/upload',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dataUrl:reader.result, filename:'paste.png'})});
              const j = await r.json();
              if(j.success) url = j.url;
            }catch(err){ }
          }else if(_sb){
            const j = await cloudUpload(reader.result);
            if(j.success) url = j.url;
          }else{
            // 本地预览：保留 dataUrl（仅本机可见），不做云端上传
          }
          const alt = prompt('图片说明文字（将显示在图片下方，可留空）','')||'图片';
          const token = `![${alt}](${url})`;
          insertAtCursor(ta, token);
          ac.content = ta.value; scheduleAutoSave();
        };
        reader.readAsDataURL(blob);
        return;
      }
    }
  }
  function insertAtCursor(ta, text){
    const s=ta.selectionStart, e=ta.selectionEnd;
    ta.value = ta.value.slice(0,s)+text+ta.value.slice(e);
    ta.selectionStart=ta.selectionEnd=s+text.length; ta.focus();
  }

  // 若地点/链接字段为纯 URL，自动转为 markdown 可点击链接
  function linkifyUrl(text){
    if(!text) return text;
    const t = text.trim();
    if(/^https?:\/\/[^\s\[\]()]+$/i.test(t)) return `[${t}](${t})`;
    return text;
  }

  // ---------- 文案变量替换 ----------
  // [v10.7] 把 project 显式注入 n._project（而不是第 5 个参数）—— RenderCore.replaceVars
  //   签名只接受 4 个参数 (stage, n, aud, content)，第 5 个参数会被静默忽略。
  //   内部从 n._project 兜底取 project；如果不注入，所有项目级字段（项目名/培训目的/负责人/整体安排/项目开始/项目结束）
  //   都会渲染为空字符串（用户截图：{{培训目的}} 渲染为空白）。send-due-scheduled 因为直接调用 RenderCore.renderContent
  //   传入 project，所以云端定时链路不受影响——只影响前端 cloudSend / 预览路径。
  function replaceVars(stage, n, aud, content, proj){
    const p = proj || project;
    const nWithProj = (p && (!n._project || n._project !== p)) ? Object.assign({}, n, { _project: p }) : n;
    return RenderCore.replaceVars(stage, nWithProj, aud, content);
  }

  // ---------- 发送 / 预览 ----------
  function buildItemsForAudience(stage, n, aud){
    const ac = n.audienceContent[aud];
    if(!ac || !ac.enabled) return [];
    const content = replaceVars(stage, n, aud, ac.content);
    const items=[];
    (ac.targetGroups||[]).forEach(gid=>{
      const g = globalGroups.find(x=>x.id===gid);
      if(g && g.webhookUrl){
        // [v10.2 root-fix] news articles 需要 url 字段（点击跳转链接），缺则企微返回 40039 invalid url size
        // 优先级：该项目 stage.viewUrl > stage.url > project.viewUrl > 占位
        const articleUrl = (stage && (stage.viewUrl||stage.url)) || (project && (project.viewUrl||project.url)) || 'https://work.weixin.qq.com/';
        items.push({webhookUrl:g.webhookUrl, content:content, groupName:g.name, articleUrl});
      }
    });
    return items;
  }
  async function sendNotification(stage, n, aud, testMode){
    const items = buildItemsForAudience(stage, n, aud);
    if(items.length===0){ toast('该版本未启用或未选择目标群'); return; }
    if(n.status==='sent' && !confirm('该通知已发送过，确认再次发送 '+GROUPS_LABEL[aud]+'版？')) return;
    await doSendItems(items, testMode, GROUPS_LABEL[aud]+'版');
    if(!testMode){
      n.status='sent';
      n.sentAt = new Date().toISOString();
      if(!n.sentAudiences) n.sentAudiences=[];
      if(!n.sentAudiences.includes(aud)) n.sentAudiences.push(aud);
      scheduleAutoSave();
      render();
    }
  }
  async function sendAllEnabledAudiences(stage, n, testMode){
    const enabledAuds = AUDIENCES.filter(a=>n.audienceContent[a] && n.audienceContent[a].enabled);
    if(enabledAuds.length===0){ toast('该通知没有启用任何受众版本'); return; }
    if(n.status==='sent' && !confirm('该通知已发送过，确认再次发送全部启用受众？')) return;
    let allItems=[];
    enabledAuds.forEach(a=>{ allItems = allItems.concat(buildItemsForAudience(stage, n, a)); });
    if(allItems.length===0){ toast('已启用版本均未选择目标群'); return; }
    await doSendItems(allItems, testMode, '全部受众');
    if(!testMode){
      n.status='sent';
      n.sentAt = new Date().toISOString();
      n.sentAudiences = enabledAuds.slice();
      scheduleAutoSave();
      render();
    }
  }
  async function doSendItems(items, testMode, label){
    if(SERVER_MODE){
      try{
        const r = await fetch('/api/send-v10',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({items, testMode})});
        const j = await r.json();
        if(j.success){ toast('发送成功：'+items.map(i=>i.groupName).join('、')); }
        else { toast('部分失败：'+(j.results||[]).filter(x=>!x.success).map(x=>x.groupName+':'+x.error).join('；')); }
      }catch(e){ toast('发送异常：'+e.message); }
    }else if(_sb){
      const j = await cloudSend(items, testMode);
      if(j && j.success){
        const groups = items.map(i=>i.groupName).join('、');
        // [v10.2 root-fix] 不再使用"未部署 Edge Function"这种带贬义的提示。
        // 现实：no-cors 直发请求**已送达**企微服务器，前端无法读回执是浏览器限制（不是产品缺陷）。
        // 用户需到群里确认是否真收到——这是诚实的提示，不是告警。
        if(j.fallback==='no-cors' || j.fallback==='no-cors-news'){
          toast('已发送到 '+ groups +'（请求已送达企微服务器，请到群里确认是否收到）');
        } else {
          toast('发送成功：'+ groups);
        }
      }
      else { toast('发送失败：'+((j&&j.error)||'未知错误')); }
    }else{
      toast('本地预览模式无法发送，请在本地服务(http://localhost:8788/v10)中使用'); return;
    }
  }
  function openPreview(stage, n, aud){
    const ac = n.audienceContent[aud];
    let content;
    try {
      content = replaceVars(stage, n, aud, ac?ac.content:'');
    } catch(e){
      content = (ac && ac.content) || '';
      console.warn('[openPreview] replaceVars 失败:', e);
    }
    const _tgMatch = globalGroups.find(g=> ac && ac.targetGroups && ac.targetGroups.includes(g.id));
    const _tgName = (_tgMatch && _tgMatch.name) || '目标群';
    // [v10.5 图文混排] 预览 = 实际发送：调 render-core.buildNewsPayload 构建 news payload，
    // 再用 renderNewsPreview 渲染——与 Edge Function / Action 真实发送路径共用同一真源
    const articleUrl = (stage && (stage.viewUrl||stage.url)) || (project && (project.viewUrl||project.url)) || 'https://work.weixin.qq.com/';
    const payload = RenderCore.buildNewsPayload(content, { articleUrl });
    $('#previewTitle').textContent = '预览 · '+GROUPS_LABEL[aud]+'版';
    $('#previewBody').innerHTML = '<div class="wx-msg"><div class="wx-name">企业微信群 · '+esc(_tgName)+'</div><div class="wx-body">'+RenderCore.renderNewsPreview(payload)+'</div></div>';
    $('#previewModal').classList.add('show');
  }
  function openPreviewAll(stage, n){
    // [v10.6 修复] articleUrl 必须在 forEach 外计算一次，避免每轮回调都重复跑条件链；
    //   同时这是上一个版本遗失的局部变量——点击「预览全部」会 ReferenceError，整个弹窗无内容。
    const articleUrl = (stage && (stage.viewUrl||stage.url)) || (project && (project.viewUrl||project.url)) || 'https://work.weixin.qq.com/';
    $('#previewTitle').textContent = '预览 · 全部受众版本';
    let html = '';
    AUDIENCES.forEach(a=>{
      const ac = n.audienceContent[a];
      let content;
      try {
        content = replaceVars(stage, n, a, ac?ac.content:'');
      } catch(e){
        content = (ac && ac.content) || '';
        console.warn('[openPreviewAll] replaceVars 失败 ('+a+'):', e);
      }
      const status = ac.enabled ? '' : ' <span class="sub">(未启用)</span>';
      const payload = RenderCore.buildNewsPayload(content, { articleUrl });
      html += `<div class="wx-msg" style="margin-bottom:12px"><div class="wx-name">${esc(GROUPS_LABEL[a])}${status}</div><div class="wx-body">${RenderCore.renderNewsPreview(payload)}</div></div>`;
    });
    $('#previewBody').innerHTML = html || '<span class="sub">（无）</span>';
    $('#previewModal').classList.add('show');
  }
  function renderMdPreview(md){ return RenderCore.renderMdPreview(md); }

  // [v10.7.3] 浏览器端图片压缩：企微 markdown_v2 inline ![](URL) 按原图尺寸渲染，
  //   原图过大（PNG 原图常 1080+）会撑大消息区、下方留白。markdown 文本无法控制
  //   渲染尺寸——只能在上传时就压缩：最长边 ≤ 800px，输出 PNG（保留透明背景）。
  //   仅压缩 >200KB 的图（小图免压）；压缩失败则原样上传真图（兜底）。
  // [v10.7.3] 浏览器端压缩图片，最长边 ≤ maxSide
  //   - 通知正文 maxSide=800（独立段落，保留视觉冲击）
  //   - 任务附件 maxSide=480（文字流里的辅助材料，缩略图大小，避免企微 PC 端撑大消息区）
  async function compressImageFile(file, maxSide){
    try{
      if(!file || !file.type || !file.type.startsWith('image/')) return { file, compressed:false };
      const max = maxSide || 800;
      const dataUrl = await new Promise((resolve, reject)=>{
        const r = new FileReader();
        r.onload = ()=> resolve(r.result);
        r.onerror = reject;
        r.readAsDataURL(file);
      });
      const img = new Image();
      img.src = dataUrl;
      await new Promise((resolve, reject)=>{ img.onload = resolve; img.onerror = reject; });
      if(file.size <= 200*1024 && Math.max(img.width, img.height) <= max){
        return { file, compressed:false, w:img.width, h:img.height };  // 小图免压
      }
      const ratio = Math.min(1, max / Math.max(img.width, img.height));
      const w = Math.round(img.width * ratio), h = Math.round(img.height * ratio);
      const cvs = document.createElement('canvas');
      cvs.width = w; cvs.height = h;
      const ctx = cvs.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      const blob = await new Promise(resolve => cvs.toBlob(resolve, 'image/png'));
      if(!blob) return { file, compressed:false, w:img.width, h:img.height };
      return {
        file: new File([blob], file.name.replace(/\.[^.]+$/, '.png'), { type: 'image/png' }),
        compressed: true,
        w, h
      };
    }catch(e){
      console.warn('[compressImageFile] failed, fallback to original:', e);
      return { file, compressed:false };
    }
  }

  // ---------- 测试发送 ----------
  function openTestSend(n, aud){
    pendingTestNotification = n;
    pendingTestAudience = aud;
    renderTestSendModal('发送至测试群 · '+GROUPS_LABEL[aud]+'版');
  }
  function openTestSendAll(n){
    pendingTestNotification = n;
    pendingTestAudience = null;
    renderTestSendModal('发送至测试群 · 全部启用受众');
  }
  function renderTestSendModal(title){
    const testGroups = globalGroups.filter(g=>g.type==='test');
    const wrap = $('#testGroupList'); wrap.innerHTML='';
    $('#testSendModalTitle').textContent = title;
    if(testGroups.length===0){
      wrap.innerHTML = '<p class="sub">通讯录中暂无测试群，请到「群通讯录」添加类型为「测试群」的群。</p>';
      $('#btnDoTestSend').style.display='none';
    }else{
      $('#btnDoTestSend').style.display='inline-block';
      testGroups.forEach(g=>{
        const lbl = document.createElement('label'); lbl.className='chk';
        lbl.innerHTML = `<input type="checkbox" class="testpick" value="${g.id}" checked> ${esc(g.name)}`;
        wrap.appendChild(lbl);
      });
    }
    $('#testSendModal').classList.add('show');
  }
  async function doTestSend(){
    if(!pendingTestNotification) return;
    const ids = $$('.testpick:checked').map(x=>x.value);
    if(ids.length===0){ toast('请选择测试群'); return; }
    const groups = globalGroups.filter(g=>ids.includes(g.id));
    const stage = project.stages.find(s=>s.notifications.includes(pendingTestNotification));
    const items=[];
    if(pendingTestAudience){
      const aud = pendingTestAudience;
      const ac = pendingTestNotification.audienceContent[aud];
      if(!ac || !ac.enabled){ toast('该受众版本未启用'); return; }
      const content = replaceVars(stage, pendingTestNotification, aud, ac.content);
      groups.forEach(g=> items.push({webhookUrl:g.webhookUrl, content: GROUPS_LABEL[aud]+'版\n\n'+content, groupName:g.name}));
    }else{
      const enabledAuds = AUDIENCES.filter(a=>pendingTestNotification.audienceContent[a] && pendingTestNotification.audienceContent[a].enabled);
      if(enabledAuds.length===0){ toast('该通知没有启用任何受众版本'); return; }
      enabledAuds.forEach(a=>{
        const content = replaceVars(stage, pendingTestNotification, a, pendingTestNotification.audienceContent[a].content);
        groups.forEach(g=> items.push({webhookUrl:g.webhookUrl, content: GROUPS_LABEL[a]+'版\n\n'+content, groupName:g.name}));
      });
    }
    await doSendItems(items, true, '测试');
    $('#testSendModal').classList.remove('show');
    pendingTestNotification = null;
    pendingTestAudience = null;
  }

  // ---------- 群通讯录 ----------
  function renderGroups(){
    const list = sortGroups(filterGroups(globalGroups));
    const wrap = $('#groupsList'); wrap.innerHTML='';
    // 提醒通道回填与状态
    const rwh = $('#reminderWebhook'); if(rwh) rwh.value = appSettings.reminderWebhook||'';
    const rstat = $('#reminderStatus');
    if(rstat) rstat.textContent = (appSettings.reminderWebhook||'').trim() ? '当前已配置提醒通道，到点将推送企微消息。' : '当前未配置提醒通道，节点提醒仅页面「推送概览 → 临近节点」看板生效。';
    const rbtn = $('#btnSaveReminder');
    if(rbtn) rbtn.onclick = async ()=>{
      appSettings.reminderWebhook = ($('#reminderWebhook').value||'').trim();
      await saveAppSettings();
      if(rstat) rstat.textContent = appSettings.reminderWebhook ? '已保存提醒通道。' : '已清空，节点提醒将仅走页面看板。';
      toast('提醒通道已保存');
    };
    if(list.length===0){ wrap.innerHTML='<p class="sub">没有匹配的群。</p>'; return; }
    list.forEach((g,i)=>{
      const d=document.createElement('div'); d.className='group-row'+(g.pinned?' pinned':'');
      d.innerHTML=`<button class="ghost mini-btn" data-pin="${g.id}" title="置顶">${g.pinned?'★':'☆'}</button>
        <span class="pill ${g.type}">${GROUPS_LABEL[g.type]||g.type}</span>
        <span class="name">${esc(g.name)}</span>
        <span class="url"><a href="${esc(g.webhookUrl)}" target="_blank" rel="noopener noreferrer" title="新窗口打开 webhook（用于查看企业微信群机器人配置）">${esc(g.webhookUrl)}</a></span>
        <button class="ghost mini-btn" data-copy="${g.id}" title="复制完整 Webhook URL（含 key）">复制链接</button>
        <button class="ghost mini-btn" data-test="${g.id}" title="向该群发送一条「测试」文本，立即验证 webhook 是否可达">测试</button>
        <button class="ghost mini-btn" data-edit="${g.id}" title="编辑群名称、类型、URL">编辑</button>
        <button class="ghost danger mini-btn" data-del="${g.id}">删除</button>`;
      d.querySelector('[data-pin]').addEventListener('click',()=>{ g.pinned=!g.pinned; saveGlobalGroups(); renderGroups(); if(view==='edit') render(); });
      d.querySelector('[data-del]').addEventListener('click',()=>{ globalGroups=globalGroups.filter(x=>x.id!==g.id); saveGlobalGroups(); renderGroups(); if(view==='edit') render(); });
      d.querySelector('[data-copy]').addEventListener('click',async ()=>{
        try{
          await navigator.clipboard.writeText(g.webhookUrl||'');
          toast(`已复制「${esc(g.name)}」Webhook`);
        }catch(e){
          const ta=document.createElement('textarea'); ta.value=g.webhookUrl||''; document.body.appendChild(ta); ta.select();
          try{ document.execCommand('copy'); toast(`已复制「${esc(g.name)}」Webhook`); }catch(_){ toast('复制失败，请手动选择 URL', {tone:'warn'}); }
          document.body.removeChild(ta);
        }
      });
      d.querySelector('[data-test]').addEventListener('click', async ()=>{
        const ts = new Date().toLocaleString('zh-CN',{hour12:false});
        const payload = { msgtype:'text', text:{ content: `【Webhook 测试】群机器人「${g.name}」${ts} 收到本条说明 webhook 有效。` }};
        // 优先 Edge Function（拿到真 errcode）；失败降级 no-cors
        let realErr = null;
        if(_sb){
          try{
            const { data, error } = await _sb.functions.invoke('send-v10', { body:{ items:[{...g, content: payload.text.content}], testMode:true } });
            if(!error && data && data.results && data.results[0]){
              realErr = data.results[0].error;
            }
          }catch(_){ /* 降级 */ }
        }
        if(realErr){
          toast(`「${esc(g.name)}」发送失败：${realErr}（请到「群机器人」配置页确认 key 仍然有效）`, {tone:'warn', duration: 8000});
          console.warn('[group-test]', g.name, realErr);
        } else {
          // no-cors fallback：浏览器看不到响应，提示用户去群里确认
          await fetch(g.webhookUrl, { method:'POST', mode:'no-cors', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
          toast(`「${esc(g.name)}」测试已发出，请到该群确认是否收到（EdgeOne 静态版无法读回执，仅云端返回可见）`);
        }
      });
      d.querySelector('[data-edit]').addEventListener('click',()=>{ openEditGroupModal(g.id); });
      wrap.appendChild(d);
    });
  }

  // 编辑群：把当前 g 的 name/type/webhookUrl 回填到弹窗，支持改错码、保存后实时刷新关联项目
  let _editingGroupId = null;
  let _editGroupBindingsDone = false;
  function setupEditGroupBindings(){
    if(_editGroupBindingsDone) return;
    _editGroupBindingsDone = true;
    const copyBtn = document.getElementById('egCopy');
    if(copyBtn){
      copyBtn.addEventListener('click', async ()=>{
        const v = document.getElementById('egUrl').value || '';
        try{ await navigator.clipboard.writeText(v); toast('已复制 Webhook'); }
        catch(_){
          const ta=document.createElement('textarea'); ta.value=v; document.body.appendChild(ta); ta.select();
          try{ document.execCommand('copy'); toast('已复制 Webhook'); }catch(__){ toast('复制失败，请手动选择', {tone:'warn'}); }
          document.body.removeChild(ta);
        }
      });
    }
    const saveBtn = document.getElementById('btnSaveEditGroup');
    if(saveBtn){
      saveBtn.addEventListener('click', async ()=>{
        if(!_editingGroupId){ return; }
        const g = (globalGroups||[]).find(x=>x.id===_editingGroupId);
        if(!g){ toast('群已不存在', {tone:'warn'}); return; }
        const newName = ($('#egName').value||'').trim() || g.name;
        const newType = $('#egType').value || g.type || 'student';
        const newUrl = ($('#egUrl').value||'').trim();
        if(!newUrl){ toast('Webhook URL 不能为空', {tone:'warn'}); return; }
        if(!/^https?:\/\/qyapi\.weixin\.qq\.com\/cgi-bin\/webhook\/send\?key=.+/i.test(newUrl)){
          toast('URL 必须是企业微信群机器人 Webhook（…/webhook/send?key=…）', {tone:'warn'}); return;
        }
        const oldUrl = g.webhookUrl;
        g.name = newName;
        g.type = newType;
        g.webhookUrl = newUrl;
        await saveGlobalGroups();
        if(oldUrl && oldUrl !== newUrl){
          toast(`已保存「${esc(g.name)}」— Webhook 已更新`);
        } else {
          toast(`已保存「${esc(g.name)}」`);
        }
        $('#editGroupModal').classList.remove('show');
        renderGroups();
        if(view==='edit') render();
      });
    }
  }
  function openEditGroupModal(gid){
    setupEditGroupBindings();   // idempotent，首次弹时绑定一次
    const g = (globalGroups||[]).find(x=>x.id===gid);
    if(!g){ toast('找不到该群', {tone:'warn'}); return; }
    _editingGroupId = gid;
    $('#egName').value = g.name || '';
    $('#egType').value = g.type || 'student';
    $('#egUrl').value = g.webhookUrl || '';
    $('#editGroupModal').classList.add('show');
  }
  function filterGroups(groups){
    const q = ($('#gSearch').value||'').toLowerCase();
    const t = $('#gFilter').value;
    return groups.filter(g=>{
      if(t && g.type!==t) return false;
      if(!q) return true;
      return (g.name||'').toLowerCase().includes(q) || (g.webhookUrl||'').toLowerCase().includes(q);
    });
  }

  // ---------- 关联群选择 ----------
  let tempAssocIds = [];
  function openAssocPicker(){
    tempAssocIds = (project.associatedGroupIds||[]).slice();
    renderAssocPicker();
    $('#assocPickerModal').classList.add('show');
  }
  function renderAssocPicker(){
    const q = ($('#assocPickerSearch').value||'').toLowerCase();
    const t = $('#assocPickerFilter').value;
    const list = sortGroups(globalGroups.filter(g=>{
      if(t && g.type!==t) return false;
      if(!q) return true;
      return (g.name||'').toLowerCase().includes(q);
    }));
    const wrap = $('#assocPickerList'); wrap.innerHTML='';
    if(list.length===0){ wrap.innerHTML='<p class="sub">通讯录为空或没有匹配的群。</p>'; return; }
    list.forEach(g=>{
      const selected = tempAssocIds.includes(g.id);
      const row = document.createElement('div'); row.className='picker-row'+(selected?' selected':'');
      row.innerHTML = `<input type="checkbox" ${selected?'checked':''}> <span class="pill ${g.type}">${GROUPS_LABEL[g.type]||g.type}</span> <span style="flex:1">${esc(g.name)}</span> <span class="sub">${esc(g.webhookUrl)}</span>`;
      row.addEventListener('click',(e)=>{
        if(e.target.tagName==='INPUT') return;
        const cb = row.querySelector('input'); cb.checked = !cb.checked;
        toggleAssocId(g.id, cb.checked);
      });
      row.querySelector('input').addEventListener('change',(e)=> toggleAssocId(g.id, e.target.checked));
      wrap.appendChild(row);
    });
  }
  function toggleAssocId(id, checked){
    if(checked && !tempAssocIds.includes(id)) tempAssocIds.push(id);
    if(!checked) tempAssocIds = tempAssocIds.filter(x=>x!==id);
    renderAssocPicker();
  }
  function confirmAssocPicker(){
    project.associatedGroupIds = tempAssocIds.slice();
    render(); scheduleAutoSave();
    $('#assocPickerModal').classList.remove('show');
  }

  // ---------- 推送概览 ----------
  // ---------- 推送概览（v10.7.9） ----------
  // 行级状态 4 字段：group + status + sentAt + reason
  //   group:   pending (待发送) | draft (草稿箱) | sent (已发送)
  //   status:  pending | draft | success | failed     （UI 仅显示这 4 种简单标签）
  //   reason:  失败时的详细文案（与 send-due-scheduled 的 diag.why 一一对应）
  //   sentAt:  真实发送时刻（ISO），仅 status==='success' 有值
  // 输入：通知 n + 受众 aud；输出：4 字段
  function computeRowStatus(n, aud){
    const ac = n.audienceContent && n.audienceContent[aud];
    if(!ac) return { group:'draft', status:'draft', sentAt:'', reason:'未配置该受众' };
    // 真正已发送：双校验 n.sentAudiences 含 aud + n.sentAt 非空
    if(Array.isArray(n.sentAudiences) && n.sentAudiences.includes(aud) && n.sentAt){
      return { group:'sent', status:'success', sentAt:n.sentAt, reason:'' };
    }
    const at = ac.notifyAt;
    // -------- 草稿箱：通知时间未设置（用户原话"草稿箱=没完成设置的"） --------
    if(!at){
      let reason = '';
      if(!ac.content) reason = '文案为空';
      else if(!(ac.targetGroups||[]).length) reason = '未配置目标群';
      else if(ac.autoSend===false) reason = '未启用自动发送';
      return { group:'draft', status:'draft', sentAt:'', reason };
    }
    const t = parseNotifyAtBeijing(at);
    if(isNaN(t)){
      return { group:'draft', status:'draft', sentAt:'', reason:'通知时间格式无法解析：'+String(at) };
    }
    const nowMs = Date.now();
    const diff = nowMs - t;       // 已过多少 ms（>0）
    const diffMin = Math.floor(diff/60000);
    // -------- 待发送：通知时间在未来 --------
    if(diff < 0){
      // 即便 autoSend=false 也在待发送（用户原话"设置了发送时间"=待发送），但显示状态为"草稿"+ reason
      if(ac.autoSend===false){
        return { group:'pending', status:'draft', sentAt:'', reason:'已设发送时间但未启用自动发送（需勾选自动发送才会触发）' };
      }
      return { group:'pending', status:'pending', sentAt:'', reason:'' };
    }
    // -------- 已发送：通知时间已过（不论是否真发，都进已发送组；按用户原话"被跳过本身也是发送失败的一种"） --------
    if(ac.autoSend===false){
      return { group:'sent', status:'failed', sentAt:'',
        reason:`自动发送已暂停：用户在发送时间前取消勾选「自动发送」。请重新进入通知设置启用后并设置新时间触发。` };
    }
    if(!(ac.targetGroups||[]).length){
      return { group:'sent', status:'failed', sentAt:'',
        reason:`未配置目标群：send-due-scheduled 不会发送无目标群的通知。请进入通知设置添加目标群。` };
    }
    if(diff > 24*3600*1000){
      return { group:'sent', status:'failed', sentAt:'',
        reason:`错过 24h 主动发送窗口：notifyAt=${at}（已过 ${diffMin} 分钟，>24h），scheduler 不会再主动补发。请重新设置新的发送时间，或使用「立即发送」先发。` };
    }
    if(diff > 6*3600*1000){
      return { group:'sent', status:'failed', sentAt:'',
        reason:`超出主动发送窗口（0-6h）：notifyAt=${at}（已过 ${diffMin} 分钟，主动窗口已过），scheduler 不会重发。建议：重新设置新的发送时间，或排查 pg_cron 状态。` };
    }
    // 0..6h 内仍未发：可能 scheduler 暂未到达 / claim 阻塞 / 函数未部署 / 网络
    return { group:'sent', status:'failed', sentAt:'',
      reason:`通知时间已过 ${diffMin} 分钟但尚未发送：scheduler 可能尚未到达（pg_cron 每 5 分钟一次）或 send-due-scheduled 函数执行失败。点页头「诊断最近定时调度」按钮可实时调一次函数并返回每条 why。` };
  }

  // 失败原因精简：截前 50 字避免列宽爆炸；完整文案进 tooltip
  function shortReason(r){
    if(!r || !r.reason) return '';
    if(r.reason.length <= 60) return r.reason;
    return r.reason.slice(0, 58) + '…';
  }

  // [v10.7.9] 辅助：把 ISO 时间戳渲染成 HH:MM:SS（用于"状态"列内嵌真实发送时刻）
  function fmtHHMMSS(iso){
    if(!iso) return '';
    const d = new Date(iso);
    if(isNaN(d.getTime())) return '';
    const h = String(d.getHours()).padStart(2,'0');
    const m = String(d.getMinutes()).padStart(2,'0');
    const s = String(d.getSeconds()).padStart(2,'0');
    return `${h}:${m}:${s}`;
  }

  // [v10.7.11] 调 send-due-scheduled Edge Function 实时返回 diag 数组，弹出诊断面板
  //   用于排查"定时发送依旧没有发出"的根因：每条 (pid/nid/aud) 显示 why，与后端 diag.why 一一对应
  //   [v10.7.11] 改用原生 fetch（不依赖 _sb.functions.invoke）：
  //     Supabase JS v2 的 functions.invoke 在 EdgeOne CDN 缓存路径下偶发
  //     "Failed to send a request to the Edge Function"（fetch 抛 TypeError），
  //     但服务端函数实际是好的——cURL 直测返回 ok:true。原 fetch 直接打到 /functions/v1/，
  //     自带 apikey/Authorization，行为一致但绕开 SDK 内部 try/catch 黑盒。
  async function callSendDueDiag(btn){
    if(btn) { btn.disabled = true; btn.textContent = '诊断中…'; }
    let result = null;
    try{
      const url = SB_URL + '/functions/v1/send-due-scheduled';
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'apikey': SB_ANON, 'Authorization': 'Bearer ' + SB_ANON, 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      });
      const text = await r.text();
      if(!r.ok){
        result = { ok:false, error:'HTTP '+r.status+'：'+text.slice(0,300) };
      } else {
        try{ result = JSON.parse(text); }
        catch(e){ result = { ok:false, error:'响应非 JSON：'+text.slice(0,300) }; }
      }
    }catch(e){
      result = { ok:false, error:'网络失败：'+e.message };
    }
    showSendDueDiagModal(result);
    if(btn){ btn.disabled = false; btn.textContent = '诊断最近定时调度'; }
  }
  // [v10.7.9] 弹窗：显示 runId + 概要 + diag 表 + 修复建议
  function showSendDueDiagModal(result){
    const old = document.getElementById('ovDiagMask'); if(old) old.remove();
    const diag = Array.isArray(result?.diag) ? result.diag : [];
    const summary = `
      <div class="kv"><span>ok</span><b style="color:${result?.ok?'#00b42a':'#f53f3f'}">${esc(String(result?.ok))}</b></div>
      <div class="kv"><span>runId</span><b>${esc(result?.runId||'')}</b></div>
      <div class="kv"><span>scanned</span><b>${esc(String(result?.scanned??''))}</b></div>
      <div class="kv"><span>实际发出</span><b>${esc(String((result?.sent||[]).length))}</b></div>
      <div class="kv"><span>主动跳过</span><b>${esc(String((result?.skipped||[]).length))}</b></div>
      <div class="kv"><span>错误</span><b>${esc(String((result?.errors||[]).length))}</b></div>
      <div class="kv"><span>now</span><b>${esc(result?.now||'')}</b></div>
      ${result?.error ? `<div class="kv" style="background:#fff5f5;border-radius:6px;padding:6px 8px"><span>error</span><b style="color:#f53f3f">${esc(result.error)}</b></div>`:''}
    `;
    // 修复建议：按 diag.why 出现次数排序，给出可执行的诊断
    const WHY_TIPS = {
      'disabled-or-no-ac':   '检查通知设置：受众是否启用 / audienceContent 是否存在',
      'no-notifyAt':         '通知未设置发送时间，请进入通知设置填写',
      'bad-notifyAt':        '通知时间格式异常，请检查 datetime-local 输入',
      'future':              '未到通知时间（正常），调度将在 5 分钟内下次到达',
      'past-24h':            '通知时间已超过 24h 主动窗口，scheduler 不会再发；请设置新发送时间或立即发送',
      'no-target-groups':    '通知未配置目标群，请进入通知设置添加目标群',
      'already-in-sentAudiences':'本地 n.sentAudiences 已含该受众（被前端或上一次发送标记），忽略；如要重发，请清除该受众的发送标记',
      'already-sent':        'tn_sends 表已存在该受众的成功发送记录（真实发送过），无需重发',
      'no-network-call':     '（保留）本函数为主动发送路径，正常不会触发此项',
      'webhook-err':         '企微 webhook 业务错误：检查 errcode+errmsg；常见 40039=url 缺失/40xxx=鉴权/无权限'
    };
    const tipCount = new Map();
    diag.forEach(d=>{ const k = d.why||'(unknown)'; tipCount.set(k, (tipCount.get(k)||0)+1); });
    const tipLines = Array.from(tipCount.entries()).sort((a,b)=>b[1]-a[1]).map(([k,c])=>{
      const tip = WHY_TIPS[k] || '（无内置建议）';
      return `<div class="kv"><span style="font-family:monospace;font-size:12px">${esc(k)} ×${c}</span><b>${esc(tip)}</b></div>`;
    }).join('');
    const tbl = diag.length===0
      ? '<p class="sub">diag 为空（暂无触达任何 (pid/nid/aud) 路径）</p>'
      : `<table style="font-size:12px;margin-top:8px">
          <tr><th>pid</th><th>nid</th><th>aud</th><th>why</th><th>notifyAt</th></tr>
          ${diag.map(d=>`<tr>
            <td>${esc(d.pid||'')}</td><td>${esc(d.nid||'')}</td><td>${esc(d.aud||'')}</td>
            <td style="font-family:monospace;color:${d.why==='past-24h'||d.why==='no-target-groups'?'#f53f3f':'#646a73'}">${esc(d.why||'')}</td>
            <td>${esc(d.notifyAt||'')}</td>
          </tr>`).join('')}
        </table>`;
    const mask = document.createElement('div'); mask.className='modal-mask show'; mask.id='ovDiagMask';
    mask.innerHTML = `<div class="modal" style="max-width:780px;max-height:80vh;overflow:auto">
      <h3>诊断最近定时调度 <span class="sub" style="font-weight:normal;font-size:12px;margin-left:8px">（实时调用 send-due-scheduled）</span></h3>
      ${summary}
      <h4 style="margin:14px 0 4px;font-size:13px">诊断明细（每条 (pid/nid/aud) 路径）</h4>
      ${tbl}
      <h4 style="margin:14px 0 4px;font-size:13px">修复建议（按出现次数排序）</h4>
      ${tipLines || '<p class="sub">无</p>'}
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
        <button class="ghost" id="ovDiagClose">关闭</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click',(e)=>{ if(e.target===mask) mask.remove(); });
    mask.querySelector('#ovDiagClose').addEventListener('click',()=> mask.remove());
  }

  // 辅助：取通知下启用受众的最早发送时间（数据模型中 notifyAt 在 audienceContent 内）
  function getNotificationNotifyAt(n){
    const times = ['student','lecturer','manager']
      .map(a => n.audienceContent && n.audienceContent[a] && n.audienceContent[a].enabled ? n.audienceContent[a].notifyAt : null)
      .filter(Boolean);
    return times.sort()[0] || null;
  }
  // 辅助：构建推送概览表格行（按受众展开）；输出对象携带 [v10.7.9] group+status 双字段
  function buildOverviewRows(singleProject){
    const rows=[];
    let source;
    if(singleProject){
      // 优先从 projects[] 取最新副本（避免 project 全局变量陈旧导致两处视图不一致）
      source = (projects||[]).filter(p=>p.id===currentProjectId);
      if(source.length===0 && project) source = [project];
    } else {
      source = (projects||[]).map(p=>p);
    }
    source.forEach(p=>{
      (p.stages||[]).forEach(s=>{
        (s.notifications||[]).forEach(n=>{
          AUDIENCES.forEach(a=>{
            const ac = n.audienceContent && n.audienceContent[a];
            // 停用项（ac.enabled=false）不展开为概览行：避免把"不会真发"的项混进"推送概览"
            if(ac && ac.enabled){
              const r = computeRowStatus(n, a);
              rows.push({
                key:`${p.id||''}::${s.id}::${n.id}::${a}`, pid:p.id||'', sid:s.id, nid:n.id, aud:a,
                proj:(p.projectName||p.name)||'未命名项目',
                stage:s.name||'阶段', notif:n.name||'通知', audLabel:GROUPS_LABEL[a],
                enabled:!!ac.enabled, content:(ac.content||''), time:ac.notifyAt||'',
                // [v10.7.9] 4 字段语义
                group:r.group, status:r.status, sentAt:r.sentAt, reason:r.reason,
                targets:(ac.targetGroups||[]).map(id=>(globalGroups.find(g=>g.id===id)||{}).name).filter(Boolean).join('、')
              });
            }
          });
        });
      });
    });
    rows.sort(compareOverviewRows);
    return rows;
  }
  // [v10.7.9] 按 group + 组内时间排序
  //   pending:  notifyAt 正序（最早到期的在前）
  //   sent:     notifyAt 倒序（最近过期的在前）
  //   draft:    notifyAt 倒序兜底（未设置的放最后）
  // 跨组：在 buildOverviewRows 处已经按 group 拆好数组分别 sort，此函数负责组内 + 横跨的兜底
  function compareOverviewRows(a, b){
    if(a.group !== b.group){
      const order = { pending:1, sent:2, draft:3 };
      return order[a.group] - order[b.group];
    }
    if(a.group === 'pending') return (a.time||'').localeCompare(b.time||'');   // 正序
    return (b.time||'').localeCompare(a.time||'');                              // 倒序
  }
  // 辅助：构建临近节点（未来7天及近7天已过期未发送），按临近程度升序
  // 修复：移除"已发送则跳过"逻辑——已发但仍在今日/明日的节点应保留显示并打"已发"标识，
  //       否则 Action 9:46 跑完 9:44 通知后 status=sent，节点直接消失给用户"被吞"的错觉。
  function buildUpcomingNodes(singleProject){
    const WINDOW = 7*24*60*60*1000;
    const upcoming=[];
    let source;
    if(singleProject){
      source = (projects||[]).filter(p=>p.id===currentProjectId);
      if(source.length===0 && project) source = [project];
    } else {
      source = (projects||[]).map(p=>p);
    }
    const now = new Date();
    source.forEach(p=>{
      (p.stages||[]).forEach(s=>{
        (s.notifications||[]).forEach(n=>{
          // 不再因为 n.status==='sent' 直接 return；已发但仍在今日/明日窗口的仍显示
          const notifyAt = getNotificationNotifyAt(n);
          if(!notifyAt) return;
          const nt = parseNotifyAtBeijing(notifyAt);     // [v10.7.6] nt 为 number（毫秒）；比较 now 走 Date.valueOf()
          if(isNaN(nt)) return;
          const nowMs = now.getTime();
          const diff = nt - nowMs;
          if(diff < -WINDOW) return;        // 超过过去 7 天未发 才隐藏
          const t1 = nt - 24*60*60*1000;    // reminder1d 窗口起点（ms）
          const t2 = nt - 2*60*60*1000;     // reminder2h 窗口起点（ms）
          const auds=['student','lecturer','manager'].filter(a=>n.audienceContent&&n.audienceContent[a]&&n.audienceContent[a].enabled).map(a=>GROUPS_LABEL[a]||a).join('、')||'（未设置受众）';
          const r1 = n.reminder1dSentAt ? 'done' : (nowMs>=t1 && nowMs<nt ? 'due' : 'wait');
          const r2 = n.reminder2hSentAt ? 'done' : (nowMs>=t2 && nowMs<nt ? 'due' : 'wait');
          // 是否所有启用受众都已发送
          const enabledAuds = ['student','lecturer','manager'].filter(a=>n.audienceContent&&n.audienceContent[a]&&n.audienceContent[a].enabled);
          const sentAuds = Array.isArray(n.sentAudiences) ? n.sentAudiences : [];
          const allSent = enabledAuds.length>0 && enabledAuds.every(a=>sentAuds.includes(a));
          // [v10.2] 临近节点是「待发送提示」：已发的不再混入，已发状态归推送概览展示
          if(allSent) return;
          upcoming.push({proj:(p.projectName||p.name)||'未命名项目', stage:s.name||'阶段', notif:n.name||'通知', time:notifyAt, diff, auds, r1, r2, pid:p.id||'', nid:n.id, sid:s.id, allSent, sentAt:n.sentAt||''});
        });
      });
    });
    upcoming.sort((a,b)=>a.diff-b.diff);
    return upcoming;
  }

  // 辅助：渲染临近节点卡片（支持空状态 + 5/页独立分页）
  function renderUpcomingCard(upcoming, singleProject){
    const uc = document.createElement('div'); uc.className='card ov-upcoming';
    uc.innerHTML = `<h3>临近节点（未来 7 天）</h3>`;
    if(upcoming.length===0){
      uc.innerHTML += '<p class="sub">暂无临近节点（未来 7 天内无待发送通知）。</p>';
      return uc;
    }
    // [v10.6] 临近节点独立分页
    const totalRows = upcoming.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / UPCOMING_PAGE_SIZE));
    if(upcomingPage > totalPages) upcomingPage = totalPages;
    if(upcomingPage < 1) upcomingPage = 1;
    const startIdx = (upcomingPage - 1) * UPCOMING_PAGE_SIZE;
    const paged = upcoming.slice(startIdx, startIdx + UPCOMING_PAGE_SIZE);
    const fmtCountdown=(ms)=>{
      if(ms<=0) return '已到期';
      const tot=Math.floor(ms/60000); const d=Math.floor(tot/1440); const h=Math.floor((tot%1440)/60); const m=tot%60;
      if(d>0) return `剩 ${d}天${h}小时`;
      if(h>0) return `剩 ${h}小时${m}分`;
      return `剩 ${m}分`;
    };
    const rPill=(st)=> st==='done'?'<span class="pill sent">已提醒</span>':st==='due'?'<span class="pill soon">待发</span>':'<span class="pill draft">未到</span>';
    // 已发节点：把"倒计时"列换成"已发"标识，避免显示负数倒计时；同时显示实际发送时间（取 HH:MM）
    const fmtSentTime = (iso) => {
      if(!iso) return '';
      const d = new Date(iso);
      if(isNaN(d.getTime())) return '';
      return d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    };
    const sentBadge = (u) => {
      if(!u.allSent) return '';
      const t = fmtSentTime(u.sentAt);
      return `<span class="pill sent">${t ? t + ' 已发' : '已发'}</span>`;
    };
    const ut=document.createElement('table');
    const uh = singleProject
      ? '<tr><th>状态</th><th>阶段</th><th>通知</th><th>发送时间</th><th>受众</th><th>提前1天</th><th>提前2小时</th></tr>'
      : '<tr><th>状态</th><th>项目</th><th>阶段</th><th>通知</th><th>发送时间</th><th>受众</th><th>提前1天</th><th>提前2小时</th></tr>';
    ut.innerHTML = uh + paged.map(u=>{
      const timeCell = `<span>${esc(u.time)}</span>`;
      const statusCell = u.allSent ? sentBadge(u) : `<span class="countdown ${u.diff<=2*3600*1000?'urgent':''}">${fmtCountdown(u.diff)}</span>`;
      if(singleProject){
        return `<tr class="upcoming-row" data-pid="${esc(u.pid)}" data-nid="${esc(u.nid)}" style="cursor:pointer"><td>${statusCell}</td><td>${esc(u.stage)}</td><td>${esc(u.notif)}</td><td>${timeCell}</td><td>${esc(u.auds)}</td><td>${rPill(u.r1)}</td><td>${rPill(u.r2)}</td></tr>`;
      }
      return `<tr class="upcoming-row" data-pid="${esc(u.pid)}" data-nid="${esc(u.nid)}" style="cursor:pointer"><td>${statusCell}</td><td>${esc(u.proj)}</td><td>${esc(u.stage)}</td><td>${esc(u.notif)}</td><td>${timeCell}</td><td>${esc(u.auds)}</td><td>${rPill(u.r1)}</td><td>${rPill(u.r2)}</td></tr>`;
    }).join('');
    uc.appendChild(ut);
    // 分页条
    if(totalPages > 1){
      const pager = document.createElement('div'); pager.className='ov-pager';
      pager.innerHTML = `<span>共 ${totalRows} 条，第 ${upcomingPage}/${totalPages} 页</span>
        <button class="ghost" data-uc-prev ${upcomingPage<=1?'disabled':''}>上一页</button>
        <button class="ghost" data-uc-next ${upcomingPage>=totalPages?'disabled':''}>下一页</button>`;
      uc.appendChild(pager);
      pager.querySelector('[data-uc-prev]').addEventListener('click',()=>{ if(upcomingPage>1){ upcomingPage--; render(); } });
      pager.querySelector('[data-uc-next]').addEventListener('click',()=>{ if(upcomingPage<totalPages){ upcomingPage++; render(); } });
    }
    return uc;
  }

  // 主入口：按 singleProject 分派到两个独立视图，避免互相影响
  function buildOverviewPanel(singleProject){
    return singleProject ? buildProjectOverviewPanel() : buildGlobalOverviewPanel();
  }

  // 通用：渲染一组概览行（带分组标题、分页条、可点击行）
  // 用于全局与项目内两个面板共享
  //   rows: 当前组（pending / sent）的全量行
  //   sectionKey: 'pending' | 'sent'，决定 group class 与分页状态
  //   sectionTitle: 分组标题（如「待发送」「已发送」）
  //   renderRow: (row, group) => '<tr>...</tr>' 字符串
  //   columnsHeader: '<th>...</th>' 字符串
  //   allRows: 全量行（用于点击查找）
  //   pageSize / getPage / setPage: 分页状态
  function buildOverviewSection(card, opts){
    const { rows, sectionKey, sectionTitle, renderRow, columnsHeader, allRows, pageSize, getPage, setPage, totalLabel, emptyHint } = opts;
    const totalRows = rows.length;
    if(totalRows === 0){
      if(emptyHint){
        const empty = document.createElement('div');
        empty.className = 'ov-empty';
        empty.innerHTML = `<p class="sub">${emptyHint}</p>`;
        card.appendChild(empty);
      }
      return;
    }
    // 分组标题行
    const groupHeader = `<tr class="ov-group-header group-${sectionKey}"><td colspan="${columnsHeader.match(/<th/g)?.length || 9}">${esc(sectionTitle)}（${totalRows}）</td></tr>`;
    // 分页
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));
    let curPage = getPage();
    if(curPage > totalPages) { setPage(totalPages); curPage = totalPages; }
    if(curPage < 1) { setPage(1); curPage = 1; }
    const startIdx = (curPage - 1) * pageSize;
    const paged = rows.slice(startIdx, startIdx + pageSize);
    // 拼装表格
    const table = document.createElement('table');
    table.innerHTML = columnsHeader + groupHeader + paged.map(r=>renderRow(r, sectionKey)).join('');
    card.appendChild(table);
    // 分页条（多页时）
    if(totalPages > 1){
      const pager = document.createElement('div'); pager.className='ov-pager';
      pager.innerHTML = `<span>${totalLabel || ''} 共 ${totalRows} 条，第 ${curPage}/${totalPages} 页</span>
        <button class="ghost" data-ov-prev ${curPage<=1?'disabled':''}>上一页</button>
        <button class="ghost" data-ov-next ${curPage>=totalPages?'disabled':''}>下一页</button>`;
      card.appendChild(pager);
      pager.querySelector('[data-ov-prev]').addEventListener('click',()=>{ if(getPage()>1){ setPage(getPage()-1); render(); } });
      pager.querySelector('[data-ov-next]').addEventListener('click',()=>{ if(getPage()<totalPages){ setPage(getPage()+1); render(); } });
    }
    // 行点击
    $$('.ov-row', table).forEach(tr=> tr.addEventListener('click',(e)=>{
      // 项目内视图：复选框列点击不触发弹窗
      if(e.target.closest('.ov-row-check')) return;
      const r = allRows.find(x=>x.key===tr.dataset.key);
      if(r) openOverviewPopup(r);
    }));
  }

  // 全局推送概览（主界面）：[v10.7.9] 三块独立分页 = 待发送 / 草稿箱 / 已发送
  //   状态字段 4 种统一：草稿 / 待发送 / 发送成功 / 发送失败
  //   "实际发送时间" 嵌入"状态"列右侧（仅成功）；移除"实际发送"独立列，腾位给"目标群"
  //   "失败原因" 列：仅发送失败行展示详细原因，其他行 "—"
  //   新增 "诊断最近定时调度" 按钮到主卡片 h3 旁，调 send-due-scheduled
  function buildGlobalOverviewPanel(){
    const rows = buildOverviewRows(false);
    // [v10.7.9] 按 group 拆分：3 组 = pending / draft / sent
    const pendingRows = rows.filter(r => r.group === 'pending');
    const draftRows   = rows.filter(r => r.group === 'draft');
    const sentRows    = rows.filter(r => r.group === 'sent');
    const todayIso = new Date().toISOString().slice(0,10);
    const tomorrowIso = new Date(Date.now()+24*60*60*1000).toISOString().slice(0,10);
    // 状态 4 字段渲染：草稿 / 待发送 / 发送成功 / 发送失败
    const STATUS_PILL = (st, sentAt)=>{
      switch(st){
        case 'pending': return '<span class="pill pending">待发送</span>';
        case 'success': return `<span class="pill sent">发送成功</span> ${sentAt ? `<span class="sub" style="margin-left:6px">${esc(fmtHHMMSS(sentAt))}</span>` : ''}`;
        case 'failed':  return '<span class="pill failed">发送失败</span>';
        default:        return '<span class="pill draft">草稿</span>';
      }
    };
    const fmtRow = (r, group) => {
      // 今天/明天小标签（仅待发送 / 草稿箱行；已发送不在此显示）
      let mark = '';
      if(r.time && r.group !== 'sent'){
        const d = r.time.slice(0,10);
        if(d===todayIso) mark = '<span class="pill today">今天</span>';
        else if(d===tomorrowIso) mark = '<span class="pill soon">明天</span>';
      }
      const timeCell = r.time ? `${esc(r.time)} ${mark}` : '<span class="sub">未设定</span>';
      const target = r.enabled ? esc(r.targets||'(未选群)') : '<span class="sub">已停用</span>';
      const statusCell = STATUS_PILL(r.status, r.sentAt);
      const reasonCell = r.status==='failed' && r.reason
        ? `<span class="sub ov-reason" title="${esc(r.reason)}">${esc(shortReason(r))}</span>`
        : '<span class="sub">—</span>';
      return `<tr class="ov-row group-${group}" data-key="${esc(r.key)}" data-pid="${esc(r.pid)}" data-sid="${esc(r.sid)}" data-nid="${esc(r.nid)}" data-aud="${esc(r.aud)}" style="cursor:pointer"><td>${esc(r.proj)}</td><td>${esc(r.stage)}</td><td>${esc(r.notif)}</td><td>${esc(r.audLabel)}</td><td>${timeCell}</td><td>${target}</td><td>${statusCell}</td><td>${reasonCell}</td></tr>`;
    };
    // [v10.7.9] 8 列：项目/阶段/通知/受众/发送时间/目标群/状态/失败原因
    const COLS_GLOBAL = '<tr><th>项目</th><th>阶段</th><th>通知</th><th>受众</th><th>发送时间</th><th>目标群</th><th>状态</th><th>失败原因</th></tr>';

    const frag = document.createDocumentFragment();
    const upcoming = buildUpcomingNodes(false);

    // 1) 临近节点置顶（带 5/页分页）
    frag.appendChild(renderUpcomingCard(upcoming, false));

    // 2) 主卡片：标题右侧加 "诊断最近定时调度" 按钮
    const card = document.createElement('div'); card.className='card ov-main';
    card.innerHTML = `<h3>推送概览 <button class="ghost" id="ovDiagBtn" style="margin-left:auto;font-weight:normal;font-size:12px;padding:3px 10px" title="立即调用 send-due-scheduled Edge Function，返回每条通知的 why（适合排查"定时发送依旧没有发出"的根因）">诊断最近定时调度</button></h3>`;
    if(rows.length===0){ card.innerHTML += '<p class="sub">暂无通知。</p>'; }
    else {
      const note = document.createElement('p'); note.className='sub'; note.style.margin='4px 0 12px';
      note.textContent = '全局视图：跨项目的批量操作请在对应项目内执行，点击项目名可进入项目。三类：①待发送（按时间正序）②草稿箱（按时间倒序）③已发送（按时间倒序，含失败）。';
      card.appendChild(note);
    }
    // [v10.7.9] 第 1 组：待发送
    buildOverviewSection(card, {
      rows: pendingRows,
      sectionKey: 'pending',
      sectionTitle: '① 待发送',
      renderRow: fmtRow,
      columnsHeader: COLS_GLOBAL,
      allRows: rows,
      pageSize: PENDING_PAGE_SIZE,
      getPage: ()=> pendingPage,
      setPage: (p)=>{ pendingPage = p; },
      totalLabel: '待发送',
      emptyHint: pendingRows.length === 0 && draftRows.length === 0 && sentRows.length > 0 ? '暂无待发送通知。' : null
    });
    // [v10.7.9] 第 2 组：草稿箱
    buildOverviewSection(card, {
      rows: draftRows,
      sectionKey: 'draft',
      sectionTitle: '② 草稿箱',
      renderRow: fmtRow,
      columnsHeader: COLS_GLOBAL,
      allRows: rows,
      pageSize: DRAFT_PAGE_SIZE,
      getPage: ()=> draftPage,
      setPage: (p)=>{ draftPage = p; },
      totalLabel: '草稿箱',
      emptyHint: null
    });
    // [v10.7.9] 第 3 组：已发送（含发送成功的真实发送时间 + 失败的失败原因）
    buildOverviewSection(card, {
      rows: sentRows,
      sectionKey: 'sent',
      sectionTitle: '③ 已发送（含发送失败）',
      renderRow: fmtRow,
      columnsHeader: COLS_GLOBAL,
      allRows: rows,
      pageSize: SENT_PAGE_SIZE,
      getPage: ()=> sentPage,
      setPage: (p)=>{ sentPage = p; },
      totalLabel: '已发送',
      emptyHint: pendingRows.length === 0 && draftRows.length === 0 && sentRows.length === 0 ? '暂无已发送通知。' : null
    });
    frag.appendChild(card);

    // "诊断最近定时调度" 按钮：调 send-due-scheduled，返回 diag 数组可视化
    const diagBtn = card.querySelector('#ovDiagBtn');
    if(diagBtn){
      diagBtn.addEventListener('click',()=> callSendDueDiag(diagBtn));
    }

    // 临近节点行点击
    if(upcoming.length>0){
      $$('.upcoming-row', frag).forEach(tr=> tr.addEventListener('click',()=>{
        const pid=tr.dataset.pid, nid=tr.dataset.nid;
        const u=upcoming.find(x=>x.pid===pid&&x.nid===nid);
        if(u) openUpcomingPopup(u);
      }));
    }
    return frag;
  }

  // 项目内推送概览：[v10.7.9] 临近节点置顶 + 批量操作 + 三块独立分页（与全局对称）
  function buildProjectOverviewPanel(){
    const rows = buildOverviewRows(true);
    // [v10.7.9] 按 group 拆分（与全局对称：pending / draft / sent）
    const pendingRows = rows.filter(r => r.group === 'pending');
    const draftRows   = rows.filter(r => r.group === 'draft');
    const sentRows    = rows.filter(r => r.group === 'sent');
    const now = new Date();
    const todayIso = now.toISOString().slice(0,10);
    const tomorrowIso = new Date(now.getTime()+24*60*60*1000).toISOString().slice(0,10);

    const STATUS_PILL = (st, sentAt)=>{
      switch(st){
        case 'pending': return '<span class="pill pending">待发送</span>';
        case 'success': return `<span class="pill sent">发送成功</span> ${sentAt ? `<span class="sub" style="margin-left:6px">${esc(fmtHHMMSS(sentAt))}</span>` : ''}`;
        case 'failed':  return '<span class="pill failed">发送失败</span>';
        default:        return '<span class="pill draft">草稿</span>';
      }
    };
    const fmtRow = (r, group) => {
      let mark = '';
      if(r.time && r.group !== 'sent'){
        const d = r.time.slice(0,10);
        if(d===todayIso) mark = '<span class="pill today">今天</span>';
        else if(d===tomorrowIso) mark = '<span class="pill soon">明天</span>';
      }
      const timeCell = r.time ? `${esc(r.time)} ${mark}` : '<span class="sub">未设定</span>';
      const target = r.enabled ? esc(r.targets||'(未选群)') : '<span class="sub">已停用</span>';
      const statusCell = STATUS_PILL(r.status, r.sentAt);
      const reasonCell = r.status==='failed' && r.reason
        ? `<span class="sub ov-reason" title="${esc(r.reason)}">${esc(shortReason(r))}</span>`
        : '<span class="sub">—</span>';
      const chk = `<td><input type="checkbox" class="ov-checkbox ov-row-check" data-key="${esc(r.key)}" data-pid="${esc(r.pid)}" data-sid="${esc(r.sid)}" data-nid="${esc(r.nid)}" data-aud="${esc(r.aud)}"></td>`;
      return `<tr class="ov-row group-${group}" data-key="${esc(r.key)}" data-pid="${esc(r.pid)}" data-sid="${esc(r.sid)}" data-nid="${esc(r.nid)}" data-aud="${esc(r.aud)}" style="cursor:pointer">${chk}<td>${esc(r.stage)}</td><td>${esc(r.notif)}</td><td>${esc(r.audLabel)}</td><td>${timeCell}</td><td>${target}</td><td>${statusCell}</td><td>${reasonCell}</td></tr>`;
    };
    // [v10.7.9] 8 列（去掉"实际发送"独立列，状态内嵌时刻）
    const COLS_PROJ_PENDING = `<tr><th style="width:30px"><input type="checkbox" id="ovHeadCheck" class="ov-checkbox" title="全选"></th><th>阶段</th><th>通知</th><th>受众</th><th>发送时间</th><th>目标群</th><th>状态</th><th>失败原因</th></tr>`;
    const COLS_PROJ_DEFAULT = `<tr><th style="width:30px"></th><th>阶段</th><th>通知</th><th>受众</th><th>发送时间</th><th>目标群</th><th>状态</th><th>失败原因</th></tr>`;

    const frag = document.createDocumentFragment();
    const upcoming = buildUpcomingNodes(true);

    // 临近节点置顶（带 5/页分页）
    frag.appendChild(renderUpcomingCard(upcoming, true));

    // 主卡片：[v10.7.9] 标题右侧加"诊断"按钮
    const card = document.createElement('div'); card.className='card ov-main';
    card.innerHTML = `<h3>推送概览 <button class="ghost" id="ovDiagBtn" style="margin-left:auto;font-weight:normal;font-size:12px;padding:3px 10px" title="立即调用 send-due-scheduled Edge Function，返回每条通知的 why（适合排查"定时发送依旧没有发出"的根因）">诊断最近定时调度</button></h3>`;
    if(rows.length===0){ card.innerHTML += '<p class="sub">暂无通知。</p>'; }
    else {
      const bulkbar = document.createElement('div'); bulkbar.className='bulkbar';
      bulkbar.innerHTML = `<input type="checkbox" id="ovSelectAll" class="ov-checkbox" title="全选">
        <span class="bulkcount">已选 0 项</span>
        <button class="ghost" id="ovBulkEnable" disabled>启用</button>
        <button class="ghost" id="ovBulkDisable" disabled>停用</button>
        <button class="ghost" id="ovBulkTime" disabled>改时间</button>
        <button class="ghost danger" id="ovBulkDelete" disabled>删除</button>
        <button class="primary" id="ovBulkGenerate">批量生成通知</button>`;
      card.appendChild(bulkbar);
    }
    // [v10.7.9] 第 1 组：待发送（含批量操作 UI）
    buildOverviewSection(card, {
      rows: pendingRows,
      sectionKey: 'pending',
      sectionTitle: '① 待发送',
      renderRow: fmtRow,
      columnsHeader: COLS_PROJ_PENDING,
      allRows: rows,
      pageSize: PENDING_PAGE_SIZE,
      getPage: ()=> pendingPage,
      setPage: (p)=>{ pendingPage = p; },
      totalLabel: '待发送',
      emptyHint: pendingRows.length === 0 && draftRows.length === 0 && sentRows.length > 0 ? '暂无待发送通知。' : null
    });
    // [v10.7.9] 第 2 组：草稿箱
    buildOverviewSection(card, {
      rows: draftRows,
      sectionKey: 'draft',
      sectionTitle: '② 草稿箱',
      renderRow: fmtRow,
      columnsHeader: COLS_PROJ_DEFAULT,
      allRows: rows,
      pageSize: DRAFT_PAGE_SIZE,
      getPage: ()=> draftPage,
      setPage: (p)=>{ draftPage = p; },
      totalLabel: '草稿箱',
      emptyHint: null
    });
    // [v10.7.9] 第 3 组：已发送（含发送失败的详细原因）
    buildOverviewSection(card, {
      rows: sentRows,
      sectionKey: 'sent',
      sectionTitle: '③ 已发送（含发送失败）',
      renderRow: fmtRow,
      columnsHeader: COLS_PROJ_DEFAULT,
      allRows: rows,
      pageSize: SENT_PAGE_SIZE,
      getPage: ()=> sentPage,
      setPage: (p)=>{ sentPage = p; },
      totalLabel: '已发送',
      emptyHint: pendingRows.length === 0 && draftRows.length === 0 && sentRows.length === 0 ? '暂无已发送通知。' : null
    });
    frag.appendChild(card);

    // [v10.7.9] "诊断最近定时调度" 按钮
    const diagBtn = card.querySelector('#ovDiagBtn');
    if(diagBtn){
      diagBtn.addEventListener('click',()=> callSendDueDiag(diagBtn));
    }

    // 批量操作事件绑定（项目内）
    if(rows.length>0){
      const updateCount = ()=>{
        const checked = $$('.ov-row-check:checked', card);
        const count = checked.length;
        $('.bulkcount', card).textContent = `已选 ${count} 项`;
        $('#ovBulkEnable', card).disabled = count===0;
        $('#ovBulkDisable', card).disabled = count===0;
        $('#ovBulkTime', card).disabled = count===0;
        $('#ovBulkDelete', card).disabled = count===0;
        $$('.ov-row', card).forEach(tr=> tr.classList.remove('selected'));
        checked.forEach(cb=> cb.closest('tr').classList.add('selected'));
      };
      const toggleAll = (checked)=>{
        $$('.ov-row-check', card).forEach(cb=> cb.checked=checked);
        updateCount();
      };
      const headCheck = $('#ovHeadCheck', card);
      const selectAll = $('#ovSelectAll', card);
      if(headCheck) headCheck.addEventListener('change',()=> toggleAll(headCheck.checked));
      if(selectAll) selectAll.addEventListener('change',()=> toggleAll(selectAll.checked));
      card.addEventListener('change',(e)=>{ if(e.target.classList.contains('ov-row-check')) updateCount(); });
      const be = $('#ovBulkEnable', card); if(be) be.addEventListener('click',()=> bulkEnable(true));
      const bd = $('#ovBulkDisable', card); if(bd) bd.addEventListener('click',()=> bulkEnable(false));
      const bdt = $('#ovBulkDelete', card); if(bdt) bdt.addEventListener('click', bulkDelete);
      const bt = $('#ovBulkTime', card); if(bt) bt.addEventListener('click', openBulkTimeModal);
      const bg = $('#ovBulkGenerate', card); if(bg) bg.addEventListener('click', openBulkGenerateModal);
    }
    if(upcoming.length>0){
      $$('.upcoming-row', frag).forEach(tr=> tr.addEventListener('click',()=>{
        const pid=tr.dataset.pid, nid=tr.dataset.nid;
        const u=upcoming.find(x=>x.pid===pid&&x.nid===nid);
        if(u) openUpcomingPopup(u);
      }));
    }
    return frag;
  }

  function getSelectedOverviewRows(){
    const table = $('#overviewTable');
    if(!table) return [];
    return $$('.ov-row-check:checked', table).map(cb=>({pid:cb.dataset.pid, sid:cb.dataset.sid, nid:cb.dataset.nid, aud:cb.dataset.aud, key:cb.dataset.key}));
  }
  function findAudienceConfig(sel){
    const p = (sel.pid ? projects.find(x=>x.id===sel.pid) : project);
    if(!p) return null;
    const s = (p.stages||[]).find(x=>x.id===sel.sid);
    if(!s) return null;
    const n = (s.notifications||[]).find(x=>x.id===sel.nid);
    if(!n || !n.audienceContent) return null;
    return {p, s, n, ac:n.audienceContent[sel.aud]};
  }
  // 弹窗：显示通知/临近节点详情，可跳转设置
  function showDetailModal(title, bodyHtml, onOpen){
    const old = document.getElementById('ovDetailMask'); if(old) old.remove();
    const mask = document.createElement('div'); mask.className='modal-mask show'; mask.id='ovDetailMask';
    mask.innerHTML = `<div class="modal" style="max-width:560px">
      <h3>${title}</h3>
      <div class="ov-detail-body">${bodyHtml}</div>
      <div style="display:flex;gap:10px;justify-content:flex-end;margin-top:14px">
        <button class="ghost" id="ovDetailClose">关闭</button>
        <button class="primary" id="ovDetailOpen">打开设置</button>
      </div>
    </div>`;
    document.body.appendChild(mask);
    mask.addEventListener('click',(e)=>{ if(e.target===mask) mask.remove(); });
    mask.querySelector('#ovDetailClose').addEventListener('click',()=> mask.remove());
    mask.querySelector('#ovDetailOpen').addEventListener('click',()=>{ mask.remove(); if(onOpen) onOpen(); });
  }
  // 跳转并定位到某通知的设置（编辑视图-通知列表）
  function jumpToNotification(pid, nid){
    const doScroll = ()=>{
      const p = (projects.find(x=>x.id===pid)) || project;
      if(p){ (p.stages||[]).forEach(s=>{ (s.notifications||[]).forEach(n=>{ if(n.id===nid){ s.collapsed=false; n.collapsed=false; } }); }); }
      const el = document.getElementById('notif-'+nid);
      if(el) el.scrollIntoView({behavior:'smooth',block:'start'});
    };
    if(view!=='edit' || (project && project.id!==pid)){
      setView('edit', pid);
      editSection='notifs';
      setTimeout(doScroll, 250);
    } else {
      setEditSection('notifs');
      setTimeout(doScroll, 90);
    }
  }
  function openOverviewPopup(r){
    // [v10.7.9] 4 状态统一标签：草稿 / 待发送 / 发送成功 / 发送失败
    const STATUS_LABEL = { pending:'待发送', draft:'草稿', success:'发送成功', failed:'发送失败' };
    const statusTxt = STATUS_LABEL[r.status] || r.status || '草稿';
    const enabledTxt = r.enabled ? '启用' : '已停用';
    const found = findAudienceConfig(r);
    let previewHtml = '<span style="color:#8a8f99">（无文案）</span>';
    if(found && found.ac && found.ac.content){
      try {
        // 关键：详情弹窗里可能跨项目预览，必须把对应 p 传进 replaceVars，
        // 否则「项目名/负责人/培训目的/项目描述/整体安排/项目开始/项目结束」会取到当前编辑项目的值，导致显示「《未命名项目》」之类。
        const replaced = replaceVars(found.s, found.n, r.aud, found.ac.content, found.p);
        previewHtml = renderMdPreview(replaced);
      } catch(e){
        previewHtml = esc(found.ac.content); // 渲染异常时回退为原文
      }
    }
    const body = `
      <div class="kv"><span>项目</span><b>${esc(r.proj)}</b></div>
      <div class="kv"><span>阶段</span><b>${esc(r.stage)}</b></div>
      <div class="kv"><span>通知</span><b>${esc(r.notif)}</b></div>
      <div class="kv"><span>受众</span><b>${esc(r.audLabel)}（${enabledTxt}）</b></div>
      <div class="kv"><span>目标群</span><b>${esc(r.targets||'(未选群)')}</b></div>
      <div class="kv"><span>发送时间</span><b>${esc(r.time||'未设定')}</b></div>
      <div class="kv"><span>状态</span><b style="color:${r.status==='success'?'#00b42a':r.status==='failed'?'#f53f3f':''}">${statusTxt}</b></div>
      ${r.sentAt?`<div class="kv"><span>实际发送</span><b>${esc(r.sentAt)}</b></div>`:''}
      ${r.reason?`<div class="kv"><span>${r.status==='failed'?'失败原因':'备注'}</span><b style="color:#e5484d">${esc(r.reason)}</b></div>`:''}
      <div class="kv" style="flex-direction:column;align-items:stretch">
        <span>文案预览</span>
        <div class="preview-box wx-body">${previewHtml}</div>
      </div>`;
    showDetailModal('通知详情', body, ()=> jumpToNotification(r.pid, r.nid));
  }
  function openUpcomingPopup(u){
    const pill = (st)=> st==='done'?'已提醒':st==='due'?'待发':'未到';
    const body = `
      <div class="kv"><span>项目</span><b>${esc(u.proj)}</b></div>
      <div class="kv"><span>阶段</span><b>${esc(u.stage)}</b></div>
      <div class="kv"><span>通知</span><b>${esc(u.notif)}</b></div>
      <div class="kv"><span>发送时间</span><b>${esc(u.time)}</b></div>
      <div class="kv"><span>受众</span><b>${esc(u.auds)}</b></div>
      <div class="kv"><span>提前1天</span><b>${pill(u.r1)}</b></div>
      <div class="kv"><span>提前2小时</span><b>${pill(u.r2)}</b></div>`;
    showDetailModal('临近节点详情', body, ()=> jumpToNotification(u.pid, u.nid));
  }
  function bulkEnable(enable){
    const rows = getSelectedOverviewRows();
    let changed=0;
    rows.forEach(sel=>{
      const r = findAudienceConfig(sel);
      if(r && r.ac && r.ac.enabled!==enable){ r.ac.enabled=enable; changed++; }
    });
    if(changed===0){ toast('选中项状态已是'+(enable?'启用':'停用')+'，无需操作'); return; }
    scheduleAutoSave(); render();
    toast(`已${enable?'启用':'停用'} ${changed} 条受众通知`);
  }
  function bulkDelete(){
    const rows = getSelectedOverviewRows();
    if(rows.length===0) return;
    const nids = [...new Set(rows.map(r=>r.nid))];
    if(!confirm(`确认删除选中的 ${rows.length} 条受众配置对应的 ${nids.length} 条通知？\n（同一通知下多个受众会被整行删除）`)) return;
    let deleted=0;
    rows.forEach(sel=>{
      const r = findAudienceConfig(sel);
      if(r && r.n){
        const idx = r.s.notifications.findIndex(x=>x.id===r.n.id);
        if(idx>-1){ r.s.notifications.splice(idx,1); deleted++; }
      }
    });
    scheduleAutoSave(); render();
    toast(`已删除 ${deleted} 条通知`);
  }

  function openBulkTimeModal(){
    const rows = getSelectedOverviewRows();
    if(rows.length===0) return;
    const hasTime = rows.filter(sel=>{ const r=findAudienceConfig(sel); return r && r.ac && r.ac.notifyAt; }).length;
    $('#bulkTimeSub').textContent = `已选 ${rows.length} 条受众通知，其中 ${hasTime} 条已设发送时间`;
    const preview = ()=>{
      const mode = document.querySelector('input[name="bulkTimeMode"]:checked').value;
      const txt = mode==='offset'
        ? `将把 ${hasTime} 条已设时间的通知按「${$('#bulkTimeOffset').value}${$('#bulkTimeUnit option:checked').text}」整体偏移`
        : `将把 ${hasTime} 条已设时间的通知统一设为「${$('#bulkTimeAbsolute').value || '未选择'}」`;
      $('#bulkTimePreview').textContent = txt;
    };
    $$('input[name="bulkTimeMode"]').forEach(r=> r.addEventListener('change', preview));
    $('#bulkTimeOffset').addEventListener('input', preview);
    $('#bulkTimeUnit').addEventListener('change', preview);
    $('#bulkTimeAbsolute').addEventListener('input', preview);
    preview();
    const apply = async ()=>{
      const mode = document.querySelector('input[name="bulkTimeMode"]:checked').value;
      let changed=0, skipped=0, resetCount=0;
      // [v10.7.5 root-fix] 收集所有需要清 tn_sends 的 (pid, nid, aud) 元组——
      //   批量改时间的旧版 apply 直接 r.ac.notifyAt = v + scheduleAutoSave，
      //   完全没有调 notifyAt change handler 里 sent 状态重置逻辑，导致：
      //     ① 推送概览 computeRowStatus 双校验 n.sentAudiences+n.sentAt 仍命中 → 显示「已发送」+ 旧 sentAt
      //     ② 云端 send-due-scheduled 看到 n.sentAudiences.includes(aud) 永远跳过 → 定时主链路不自动触发
      //   （用户截图实证「托管后测试」scheduled 9-7 13:55 但 sentAt 仍是 8-31）
      const toClean = new Set();   // key: pid||'::'||nid||'::'||aud
      rows.forEach(sel=>{
        const r = findAudienceConfig(sel);
        if(!r || !r.ac) return;
        const oldAt = r.ac.notifyAt;
        let v = oldAt;
        if(mode==='offset'){
          if(!oldAt){ skipped++; return; }
          const dt = new Date(oldAt); if(isNaN(dt.getTime())){ skipped++; return; }
          const val = parseFloat($('#bulkTimeOffset').value)||0;
          const unit = $('#bulkTimeUnit').value;
          const ms = unit==='day'?val*86400000:unit==='hour'?val*3600000:val*60000;
          v = new Date(dt.getTime()+ms).toISOString().slice(0,16);
        } else {
          const inp = $('#bulkTimeAbsolute').value;
          if(!inp){ toast('请先选择绝对时间'); return; }
          v = inp;
        }
        if(v === oldAt){ skipped++; return; }
        r.ac.notifyAt = v;
        // 调用共用 resetSentStateOnNotifyChange（与单条 change handler 行为完全一致）
        //   该函数仅在「曾经发过」时返回 true，避免无意义的 tn_sends 清理
        if(resetSentStateOnNotifyChange(r.n, r.ac)){
          resetCount++;
          // 收集要清的 sendIds
          const pid = r.p.id || currentProjectId;
          if(pid && r.n.id && sel.aud){
            toClean.add(`${pid}::${r.n.id}::${sel.aud}`);
          }
        }
        changed++;
      });
      if(changed === 0){
        toast(skipped ? `跳过 ${skipped} 条（时间未变/未设置）` : '未选择时间');
        return;
      }
      // [v10.7.5] 先 await 清云端 tn_sends，再 cloudSet 覆盖——
      //   顺序敏感：必须先删 tn_sends 再写项目，否则云端 reconcile 仍可能把旧 sentAt 写回
      if(toClean.size > 0 && _sb){
        for(const k of toClean){
          const [pid, nid, aud] = k.split('::');
          await cleanTnSendsForNotification(pid, nid, [aud]);
        }
      }
      // 同步内存 projects[]（cloudSend / clientSendDue 从这里读）
      if(projects && currentProjectId){
        const _idx = projects.findIndex(p=>p.id===currentProjectId);
        if(_idx>=0) projects[_idx] = JSON.parse(JSON.stringify(project));
      }
      // cloudSet 覆盖项目（不走 fetchCloudMerge，避免 merge 把云端 sentAt 再写回本地）
      if(_sb && currentProjectId){
        try{
          await cloudSet('project:'+currentProjectId, project);
        }catch(e){
          console.warn('[bulkTimeApply] cloudSet failed:', e.message);
        }
      } else {
        scheduleAutoSave();
      }
      render();
      $('#bulkTimeModal').classList.remove('show');
      const tip = resetCount > 0
        ? `已修改 ${changed} 条${skipped?('，跳过 '+skipped+' 条'):''}；重置 ${resetCount} 条的已发送状态（请重新勾选自动发送）`
        : `已修改 ${changed} 条${skipped?('，跳过 '+skipped+' 条'):''}`;
      toast(tip, {tone: resetCount > 0 ? 'warn' : 'info'});
    };
    const btn = $('#btnBulkTimeApply');
    const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', apply);
    $('#bulkTimeModal').classList.add('show');
  }

  function openBulkGenerateModal(){
    const p = project;
    const stages = (p && p.stages)||[];
    const wrap = $('#bulkGenerateModal');
    // 阶段列表
    const stageBox = $('#bulkGenStages');
    stageBox.innerHTML = stages.map((s,i)=>`<label style="display:block;margin:4px 0;cursor:pointer"><input type="checkbox" class="bulkgen-stage" value="${s.id}" checked> ${esc(s.name||('阶段'+(i+1)))}</label>`).join('');
    if(stages.length===0) stageBox.innerHTML='<p class="sub">当前项目没有阶段，请先在「通知列表」添加阶段。</p>';
    // 来源选项
    const allNotifs = [];
    stages.forEach(s=> (s.notifications||[]).forEach(n=> allNotifs.push({sid:s.id, nid:n.id, label:`${s.name||'阶段'} / ${n.name||'未命名通知'}`, n})));
    const copySel = $('#bulkGenCopyFrom');
    copySel.innerHTML = allNotifs.map(x=>`<option value="${x.nid}">${esc(x.label)}</option>`).join('') || '<option value="">无现有通知</option>';
    const sourceSel = $('#bulkGenSource');
    // 模板列表（按节点分组）
    const tplSel = $('#bulkGenTemplate');
    const renderTplOptions = ()=>{
      const nodes = [...new Set(TEMPLATES.map(t=>t.node))];
      if(TEMPLATES.length===0){
        tplSel.innerHTML = '<option value="">暂无模板，请到「文案模板」管理</option>';
        return;
      }
      tplSel.innerHTML = nodes.map(node=>{
        const list = TEMPLATES.filter(t=>t.node===node);
        return `<optgroup label="${esc(NODE_LABEL[node]||node)}">` + list.map(t=>`<option value="${t.id}">${esc(GROUPS_LABEL[t.audience]||t.audience)} · ${esc(t.label||'未命名')}</option>`).join('') + '</optgroup>';
      }).join('');
    };
    renderTplOptions();
    const toggleSource = ()=>{
      const isCopy = sourceSel.value==='copy';
      $('#bulkGenTplBox').style.display = isCopy?'none':'block';
      $('#bulkGenCopyBox').style.display = isCopy?'block':'none';
    };
    sourceSel.addEventListener('change', toggleSource);
    toggleSource();
    const ruleSel = $('#bulkGenTimeRule');
    ruleSel.addEventListener('change',()=>{ $('#bulkGenOffsetRow').style.display = ruleSel.value==='none'?'none':'flex'; });
    $('#bulkGenOffsetRow').style.display = ruleSel.value==='none'?'none':'flex';
    const apply = ()=>{
      const sids = $$('.bulkgen-stage:checked').map(cb=>cb.value);
      if(sids.length===0){ toast('请至少选择一个目标阶段'); return; }
      const source = sourceSel.value;
      const rule = ruleSel.value;
      const offsetVal = parseFloat($('#bulkGenOffset').value)||0;
      const unit = $('#bulkGenUnit').value;
      let sourceN = null;
      let sourceTpl = null;
      if(source==='copy'){
        const nid = $('#bulkGenCopyFrom').value;
        if(!nid){ toast('没有可复制的现有通知'); return; }
        stages.forEach(s=> (s.notifications||[]).forEach(n=>{ if(n.id===nid) sourceN=n; }));
      } else {
        const tid = $('#bulkGenTemplate').value;
        if(!tid){ toast('请先选择文案模板'); return; }
        sourceTpl = getTemplateById(tid);
        if(!sourceTpl){ toast('所选模板不存在'); return; }
      }
      let created=0;
      sids.forEach(sid=>{
        const st = stages.find(s=>s.id===sid); if(!st) return;
        const n = defaultNotification();
        if(source==='copy' && sourceN){
          n.name = sourceN.name || '复制通知';
          n.node = sourceN.node;
          AUDIENCES.forEach(a=>{
            const src = sourceN.audienceContent[a];
            if(src){
              n.audienceContent[a] = JSON.parse(JSON.stringify(src));
              n.audienceContent[a].enabled = src.enabled;
            }
          });
        } else if(sourceTpl){
          n.name = sourceTpl.label || '通知';
          n.node = sourceTpl.node;
          AUDIENCES.forEach(a=>{
            n.audienceContent[a].enabled = (a === sourceTpl.audience);
          });
          applyTemplateToAudience(n, sourceTpl.audience, sourceTpl);
        }
        // 时间规则
        if(rule!=='none' && (st.startDate || st.endDate)){
          const base = rule.includes('Start') ? (st.startDate||st.endDate) : (st.endDate||st.startDate);
          const baseTime = base + 'T00:00';
          const dt = new Date(baseTime); if(!isNaN(dt.getTime())){
            const ms = unit==='day'?offsetVal*86400000:offsetVal*3600000;
            const sign = (rule.startsWith('before')) ? -1 : 1;
            const final = new Date(dt.getTime()+sign*ms);
            AUDIENCES.forEach(a=>{ if(n.audienceContent[a].enabled) n.audienceContent[a].notifyAt = final.toISOString().slice(0,16); });
          }
        }
        st.notifications.push(n); created++;
      });
      scheduleAutoSave(); render(); wrap.classList.remove('show');
      toast(`已生成 ${created} 条通知`);
    };
    const btn = $('#btnBulkGenApply');
    const newBtn = btn.cloneNode(true); btn.parentNode.replaceChild(newBtn, btn);
    newBtn.addEventListener('click', apply);
    wrap.classList.add('show');
  }

  // ---------- 智能识别 ----------
  function doParse(){
    const text = $('#parseInput').value.trim();
    if(!text){ toast('请粘贴培训方案文本'); return; }
    const newStages = parseTrainingPlan(text);
    if(newStages.length===0){ toast('未能识别出阶段，请检查文本格式'); return; }
    renderParsePreview($('#parseResult'), newStages);
    project._parseDraft = { text, results: newStages };
    scheduleAutoSave();
  }
  function parseTrainingPlan(text){
    const lines = text.split(/\r?\n/).map(l=>l.trim()).filter(l=>l.length>0);
    const stages=[];
    let curStage=null;
    const tableRows = parseTable(lines);

    if(tableRows.length>=1){
      tableRows.forEach(parts=>{
        const stageName = parts[0]||'';
        const timeText = parts[1]||'';
        const contentText = parts[2]||'';
        const formText = parts[3]||'';
        const noteText = parts.slice(4).join(' ')||'';
        const s = defaultStage();
        s.name = stageName;
        const sd = parseDateRange(timeText);
        if(sd.start) s.startDate=sd.start;
        if(sd.end) s.endDate=sd.end;
        const t = defaultTask();
        t.name = contentText || stageName;
        t.description = [contentText, formText?'形式：'+formText:'', noteText].filter(Boolean).join('\n');
        const due = extractDate(contentText+' '+noteText);
        if(due) t.dueDate=due;
        s.tasks.push(t);
        stages.push(s);
      });
      return stages;
    }

    lines.forEach(line=>{
      const stageMatch = line.match(/^(阶段|模块|Chapter|Part)[\s一二三四五六七八九十0-9]+[:：\.\s]*(.+)/) || line.match(/^(.+?)[:：]\s*\((\d{1,2}[\-/]\d{1,2}[\-/]?\d{0,4}).*?\)/);
      const simpleStage = line.match(/^(.+?)\s*[（(](\d{1,2}[\-/]\d{1,2}[\-/]?\d{0,4}).*?[）)]/);
      if(stageMatch || simpleStage || /^阶段/.test(line) || /^模块/.test(line)){
        curStage = defaultStage();
        const m = stageMatch || simpleStage;
        curStage.name = (m?m[1]||m[2]:line).replace(/[（(].*?[）)]/g,'').trim();
        const sd = parseDateRange(line);
        if(sd.start) curStage.startDate=sd.start;
        if(sd.end) curStage.endDate=sd.end;
        stages.push(curStage);
        return;
      }
      const taskMatch = line.match(/^(?:任务\s*\d+[.:：\s]*|(?:\d+[\.\)）])\s*|[-·]\s*)(.+)/) || (/截止|DDL|截止日期/.test(line) ? {1:line} : null);
      if(taskMatch && curStage){
        const t = defaultTask();
        const raw = taskMatch[1];
        const due = extractDate(raw);
        if(due) t.dueDate=due;
        t.name = raw.replace(/[（(]\s*截止.*?[）)]/g,'').replace(/截止\s*[:：]?\s*\d+[\-/]\d+.*?$/, '').trim() || '学习任务';
        t.description = raw;
        curStage.tasks.push(t);
        return;
      }
      if(curStage && curStage.tasks.length>0){
        curStage.tasks[curStage.tasks.length-1].description += '\n'+line;
      } else if(curStage){
        curStage.name += ' '+line;
      }
    });
    return stages;
  }
  // 解析从在线文档/Excel复制的表格：
  // 支持单元格内换行（说明列折行），按列数对齐并合并续行。
  function parseTable(lines){
    const expectedCols = 5; // 阶段 时间 内容 时长/形式 说明
    let startIdx=0;
    for(let i=0;i<Math.min(lines.length,3);i++){
      const raw = lines[i].replace(/\s+/g,'');
      if(/阶段.*时间.*内容/.test(raw)){ startIdx=i+1; break; }
    }
    const rows=[];
    let currentTokens=[];
    const dateLike = /(\d{1,2}\s*[月/\-]\s*\d{1,2}|\d{4}[\/\-]\d{1,2}[\/\-]?\d{0,2})/;
    function flush(){
      if(currentTokens.length===0) return;
      const parsed = parseRowTokens(currentTokens);
      if(parsed) rows.push(parsed);
      currentTokens=[];
    }
    for(let i=startIdx;i<lines.length;i++){
      const lineTokens = lines[i].split(/\s+/).map(s=>s.trim()).filter(Boolean);
      if(lineTokens.length===0) continue;
      // 新行判断：第二列通常是日期
      const isNewRow = lineTokens.length>=2 && dateLike.test(lineTokens[1]);
      if(isNewRow){
        flush();
        currentTokens = lineTokens.slice();
      }else{
        currentTokens = currentTokens.concat(lineTokens);
      }
    }
    flush();
    return rows;
  }
  // 把一行（已合并续行）的 token 拆成 5 列
  function parseRowTokens(tokens){
    if(tokens.length<2) return null;
    const dateRe = /(\d{1,2}\s*[月/\-]\s*\d{1,2}|\d{4}[\/\-]\d{1,2}[\/\-]?\d{0,2})/;
    const durRe = /^(约?\d+[分钟小时天周节]|共\d+[节分钟小时]|\d+天[,，]?)/;
    let ti = tokens.findIndex((t,i)=>i>0 && dateRe.test(t));
    if(ti===-1) ti = tokens.findIndex(t=>dateRe.test(t));
    if(ti<=0) ti = 1;
    const stage = tokens.slice(0, ti).join(' ');
    const time = tokens[ti] || '';
    let di = -1;
    for(let i=ti+1;i<tokens.length;i++){
      if(durRe.test(tokens[i])){ di=i; break; }
    }
    if(di===-1){
      // 没有时间/时长，把剩余当内容
      return [stage, time, tokens.slice(ti+1).join(' '), '', ''];
    }
    const content = tokens.slice(ti+1, di).join(' ');
    // 时长/形式列可能附带地点（如"2天，北京"），尝试把下一个短 token 也纳入
    let durEnd = di;
    if(di+1 < tokens.length && tokens[di+1].length <= 4 && !/[，,]/.test(tokens[di+1])){
      durEnd = di+1;
    }
    const duration = tokens.slice(di, durEnd+1).join(' ');
    const note = tokens.slice(durEnd+1).join(' ');
    return [stage, time, content, duration, note];
  }
  function parseDateRange(s){
    const out={start:'',end:''};
    if(!s) return out;
    const m1 = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*[~-]\s*(\d{1,2})\s*日/);
    if(m1){
      const now = new Date();
      out.start = now.getFullYear()+'-'+String(parseInt(m1[1],10)).padStart(2,'0')+'-'+String(parseInt(m1[2],10)).padStart(2,'0');
      out.end = now.getFullYear()+'-'+String(parseInt(m1[1],10)).padStart(2,'0')+'-'+String(parseInt(m1[3],10)).padStart(2,'0');
      return out;
    }
    const m2 = s.match(/(\d{1,2})\s*月\s*(\d{1,2})\s*日\s*[~-]\s*(\d{1,2})\s*月\s*(\d{1,2})\s*日/);
    if(m2){
      const now = new Date();
      out.start = now.getFullYear()+'-'+String(parseInt(m2[1],10)).padStart(2,'0')+'-'+String(parseInt(m2[2],10)).padStart(2,'0');
      out.end = now.getFullYear()+'-'+String(parseInt(m2[3],10)).padStart(2,'0')+'-'+String(parseInt(m2[4],10)).padStart(2,'0');
      return out;
    }
    const m3 = s.match(/(\d{4}[\-/]\d{1,2}[\-/]\d{1,2})\s*[~-]\s*(\d{4}[\-/]\d{1,2}[\-/]\d{1,2})/);
    if(m3){ out.start=normalizeDate(m3[1]); out.end=normalizeDate(m3[2]); return out; }
    const single = extractDate(s);
    if(single) out.start=single;
    return out;
  }
  function extractDate(s){
    if(!s) return '';
    const m = s.match(/(\d{4}[\-/]\d{1,2}[\-/]\d{1,2}|\d{1,2}[\-/]\d{1,2}[\-/]\d{4}|\d{1,2}[\-/]\d{1,2})/);
    return m ? normalizeDate(m[1]) : '';
  }
  function normalizeDate(s){
    if(!s) return '';
    const parts = s.split(/[\-/]/).map(x=>parseInt(x,10));
    if(parts.length<2) return '';
    const now = new Date();
    let y=parts[0], m=parts[1], d=parts[2];
    if(parts.length===2){ y=now.getFullYear(); m=parts[0]; d=parts[1]; }
    if(y<100) y += 2000;
    if(y<2000 || y>2100 || m<1 || m>12 || d<1 || d>31) return '';
    return y+'-'+String(m).padStart(2,'0')+'-'+String(d).padStart(2,'0');
  }
  function escapeRegex(s){ return (s||'').replace(/[.*+?^${}()|[\]\\]/g,'\\$&'); }
  function chineseToNum(s){
    const map={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
    if(/^\d+$/.test(s)) return parseInt(s,10);
    if(s==='十') return 10;
    if(s.length===2 && s[0]==='十') return 10+(map[s[1]]||0);
    if(s.length===2 && s[1]==='十') return (map[s[0]]||0)*10;
    if(s.length===3 && s[1]==='十') return (map[s[0]]||0)*10+(map[s[2]]||0);
    return map[s]||0;
  }

  // ---------- 文案识别（通知文案按阶段+受众分发）----------
  function renderCopyRecSection(){
    const wrap = document.createElement('div'); wrap.className='identify-block';
    const draft = project._copyRecDraft || {};
    const stageList = (project.stages||[]).map((s,i)=>`${i+1}. ${esc(s.name||'未命名')}`).join('、') || '（暂无阶段，请先在「通知列表」添加阶段）';
    wrap.innerHTML = `<div class="section-title" style="margin-top:24px"><h4>识别通知文案</h4></div>
      <p class="sub">粘贴一份含多个通知文案的文档，自动分发到对应阶段的受众通知。支持两类编码：
      ①<strong>阶段名 + 称呼 + 正文</strong>（如「训前线上微课 / 各位同学：…」）；
      ②<strong>标题化通知</strong>（如「【7.1】建群及前测通知」「7.13 线上微课学习通知」后接正文）。
      前者按阶段名匹配，后者按标题中的日期/编号归入「待人工确认」，由你指派到具体阶段与受众。</p>
      <p class="hint">当前项目阶段：${stageList}</p>
      <textarea id="copyRecInput" style="min-height:200px" placeholder="例如（类型①）：
训前线上微课
各位同学：
请于8月5日前完成微课学习，链接见下方...
训前线上微课
各位领导、同事：
本次培训进度如下...

或（类型②）：
【7.1】建群及前测通知
各位同学：
请扫码进入班级群...
7.13 线上微课学习通知
各位学员：
本周开放第一节微课..."></textarea>
      <div class="actions" style="justify-content:flex-end;margin-top:10px">
        <button class="ghost" id="btnClearCopyRec" type="button">清空</button>
        <button class="primary" id="btnDoCopyRec">识别并预览</button>
      </div>
      <div id="copyRecResult"></div>`;
    const ta = $('#copyRecInput',wrap); ta.value = draft.text || '';
    const res = $('#copyRecResult',wrap);
    if(draft.results) renderCopyRecPreview(res, draft.results, draft.unclear||[]);
    $('#btnDoCopyRec',wrap).addEventListener('click',()=> doCopyRec());
    $('#btnClearCopyRec',wrap).addEventListener('click',()=>{ ta.value=''; res.innerHTML=''; delete project._copyRecDraft; scheduleAutoSave(); });
    return wrap;
  }
  function renderCopyRecPreview(box, results, unclear){
    let html='';
    const stageOpts = (project.stages||[]).map((s,i)=>`<option value="${s.id}">${esc(s.name||('阶段'+(i+1)))}</option>`).join('');
    function notifOptsFor(stageId){
      const st = project.stages.find(s=>s.id===stageId);
      const n = Math.max(1, (st && st.notifications && st.notifications.length) || 0);
      let opts='';
      for(let i=1;i<=n+1;i++) opts+=`<option value="${i}">第${i}条通知${i>n?'（新建）':''}</option>`;
      return opts;
    }
    if(results.length){
      html += '<h4 style="margin-top:16px">已识别（自动匹配阶段与受众，勾选后应用）</h4><div class="copyrec-table">';
      results.forEach((r,i)=>{
        html += `<div class="copyrec-row">
          <label class="chk" style="flex-shrink:0"><input type="checkbox" class="crpick res-pick" value="${i}" checked></label>
          <span class="cr-stage">${esc(r.stageName)}</span>
          <span class="cr-aud">${GROUPS_LABEL[r.aud]||r.aud}</span>
          <select class="cr-notif-sel" data-mode="res" data-idx="${i}">${notifOptsFor(r.stageId)}</select>
          <span class="cr-preview">${esc(r.content.slice(0,80))}${r.content.length>80?'…':''}</span>
        </div>`;
      });
      html += '</div><div class="actions" style="margin-top:10px"><button class="primary" id="btnApplyCopyRec">应用选中项</button></div>';
    }
    if(unclear.length){
      html += '<h4 style="margin-top:16px;color:var(--warn)">待人工确认（为每条选择「阶段 + 受众 + 通知序号」后应用）</h4><div class="copyrec-unclear">';
      unclear.forEach((u,idx)=>{
        const head = u.title ? ('【标题】'+esc(u.title)) : (u.context?('【'+u.context+'】'):'');
        html += `<div class="cr-unclear-item">
          <div class="cr-unclear-head">
            <label class="chk" style="flex-shrink:0;margin:0"><input type="checkbox" class="crpick unc-pick" value="${idx}" checked></label>
            <select class="cr-stage-sel" data-idx="${idx}"><option value="">选择阶段…</option>${(project.stages||[]).map((s,i)=>`<option value="${s.id}"${s.id===u.stageId?' selected':''}>${esc(s.name||('阶段'+(i+1)))}</option>`).join('')}</select>
            <select class="cr-aud-sel" data-idx="${idx}">
              <option value="">选择受众…</option>
              <option value="student">${GROUPS_LABEL.student||'学员'}</option>
              <option value="manager">${GROUPS_LABEL.manager||'管理'}</option>
              <option value="lecturer">${GROUPS_LABEL.lecturer||'讲师'}</option>
            </select>
            <select class="cr-notif-sel" data-mode="unc" data-idx="${idx}">${notifOptsFor(u.stageId)}</select>
          </div>
          <div class="cr-unclear-body">${esc((head?head+'\n':'')+u.content.slice(0,400))}</div>
        </div>`;
      });
      html += '</div><div class="actions" style="margin-top:10px"><button class="primary" id="btnApplyUnclear">应用选中项（按所选阶段/受众）</button></div>';
    }
    if(!results.length && !unclear.length){
      html = '<p class="sub" style="margin-top:14px">未识别到内容，请检查文档格式。</p>';
    }
    box.innerHTML = html;
    $$('.cr-stage-sel', box).forEach(sel=>{
      const update = ()=>{
        const idx=sel.dataset.idx;
        const notifSel=$('.cr-notif-sel[data-mode="unc"][data-idx="'+idx+'"]', box);
        if(notifSel){
          const cur=notifSel.value||'1';
          notifSel.innerHTML=notifOptsFor(sel.value);
          if(parseInt(cur,10)<=(notifSel.options.length||1)) notifSel.value=cur;
        }
      };
      sel.addEventListener('change', update);
      update();
    });
    if(results.length) $('#btnApplyCopyRec',box).addEventListener('click',()=> applyCopyRec(results, [], 'res'));
    if(unclear.length) $('#btnApplyUnclear',box).addEventListener('click',()=> applyCopyRec([], unclear, 'unc'));
  }
  function parseCopyForNotifications(text){
    const stages = project.stages||[];
    const results=[]; const unclear=[];
    if(stages.length===0) return {results, unclear:[{text:text}]};
    const stageMatchers = stages.map((s,idx)=>({
      id:s.id, name:s.name||('阶段'+(idx+1)),
      re:new RegExp('^\\s*#*\\s*'+escapeRegex(s.name||('阶段'+(idx+1)))+'\\s*[:：]?\\s*$')
    }));
    const ROLES = {
      student:['同学','学员','参训学员','学员们','学员同学们','同学们','学员朋友','学员们朋友','朋友们','学员朋友们','小伙伴们','研究生','在校生','家长'],
      lecturer:['讲师','授课老师','老师们','老师','导师','助教','班主任','教授','教员','教练'],
      manager:['领导','同事','各部门负责人','管理者','管理组','主管','经理','负责人','嘉宾','合作方','甲方']
    };
    const SALUT_PREFIX = '(?:亲爱的|尊敬的|敬爱的|hi|hello|HELLO)?\\s*(?:各位|所有|全体|咱们|亲爱的)?\\s*';
    const SALUT_WORDS = [...ROLES.student, ...ROLES.lecturer, ...ROLES.manager].sort((a,b)=>b.length-a.length);
    const salutationRe = new RegExp('^'+SALUT_PREFIX+'(?:'+SALUT_WORDS.map(escapeRegex).join('|')+')(?:[、,\\s]*(?:'+SALUT_PREFIX+')?(?:'+SALUT_WORDS.map(escapeRegex).join('|')+'))*[:：]?\\s*', 'i');
    // 标题化通知（类型②）：【编号】标题 / [编号]标题 / M.D 或 M月D日 + 标题 / 第X阶段:标题
    const titleRe = /^(?:【[^】]{1,30}】|\[[^\[\]]{1,30}\]|\d{1,2}[.\/]\d{1,2}\s+\S+|\d{1,2}月\d{1,2}日\s+\S+|第[一二三四五六七八九十\d]+阶段[:：]\S+)/;
    // 综合阶段归属判定（用于标题块/模糊归属）：关键词 > 阶段名精确 > 模糊唯一包含 > 编号整数弱启发
    function findStageByText(text){
      const tt = (text||'').trim();
      if(!tt) return null;
      const exact = stages.find(s=>{
        const nm=(s.name||'').trim();
        if(!nm) return false;
        if(tt===nm || tt===nm+'：' || tt===nm+'：') return true;
        return new RegExp('^#*\\s*'+escapeRegex(nm)+'\\s*[:：]?$').test(tt);
      });
      if(exact) return exact;
      const om = tt.match(/^(?:第[一二三四五六七八九十\d]+阶段|(?:阶段|模块)\s*[\d一二三四五六七八九十]+)/);
      if(om){
        const num = chineseToNum((om[0].match(/[\d一二三四五六七八九十]+/)||['0'])[0]);
        if(num>=1 && num<=stages.length) return stages[num-1];
      }
      for(const s of stages){
        const kws=(s.keywords||'').split(/[,，]/).map(x=>x.trim()).filter(Boolean);
        if(kws.some(k=> tt.includes(k))) return s;
      }
      const nameHits = stages.filter(s=> (s.name||'').trim() && tt.includes((s.name||'').trim()));
      if(nameHits.length===1) return nameHits[0];
      const bm = tt.match(/【\s*(\d{1,2})(?:[.\/]\d{1,2})?\s*】/);
      if(bm){
        const n=parseInt(bm[1],10);
        if(n>=1 && n<=stages.length) return stages[n-1];
      }
      return null;
    }
    function isStageLine(t){
      if(stageMatchers.some(m=>m.re.test(t))) return {match:true, stage:stageMatchers.find(m=>m.re.test(t))};
      const om = t.match(/^(?:第[一二三四五六七八九十\d]+阶段|(?:阶段|模块)\s*[\d一二三四五六七八九十]+)[:：]?\s*$/);
      if(om){
        const num = chineseToNum((om[0].match(/[\d一二三四五六七八九十]+/)||['0'])[0]);
        if(num>=1 && num<=stages.length) return {match:true, stage:{id:stages[num-1].id, name:stages[num-1].name}};
      }
      return {match:false};
    }
    function detectAud(t){
      const sm = t.match(salutationRe);
      if(!sm) return {aud:null, rest:null};
      const phrase = sm[0];
      let aud=null;
      if(ROLES.student.some(k=>phrase.includes(k))) aud='student';
      else if(ROLES.lecturer.some(k=>phrase.includes(k))) aud='lecturer';
      else if(ROLES.manager.some(k=>phrase.includes(k))) aud='manager';
      const rest = t.slice(sm[0].length).replace(/^[\s，,:：]+/,'');
      return {aud, rest};
    }
    // 按「通知块」切分
    const lines = text.split(/\r?\n/);
    const blocks=[]; let cur=null;
    function pushBlock(){ if(cur && cur.lines.join('\n').trim()) blocks.push(cur); cur=null; }
    for(const raw of lines){
      const t = raw.trim();
      if(!t){ pushBlock(); continue; }
      const st = isStageLine(t);
      if(st.match){
        pushBlock();
        cur = {stageId:st.stage.id, stageName:st.stage.name, aud:null, title:null, lines:[]};
        continue;
      }
      if(titleRe.test(t)){
        pushBlock();
        cur = {stageId:null, stageName:null, aud:null, title:t, lines:[t]};
        continue;
      }
      if(!cur) cur = {stageId:null, stageName:null, aud:null, title:null, lines:[]};
      cur.lines.push(raw);
    }
    pushBlock();
    // 处理每个块
    for(const b of blocks){
      let stageId = b.stageId, stageName = b.stageName;
      // 标题块 / 普通块首行 尝试自动归属阶段（靠关键词/名称/编号）
      if(!stageId){
        const probe = b.title || b.lines.map(x=>x.trim()).find(x=>x) || '';
        const st = findStageByText(probe);
        if(st){ stageId=st.id; stageName=st.name; }
      }
      let aud=null; const contentLines=[];
      for(const raw of b.lines){
        const t = raw.trim();
        if(!t){ contentLines.push(''); continue; }
        const {aud:da, rest} = detectAud(t);
        if(da && !aud) aud=da;
        contentLines.push(da ? (rest||'') : raw);
      }
      const content = contentLines.join('\n').replace(/\n{3,}/g,'\n\n').trim();
      if(stageId && aud){
        results.push({stageId, stageName, aud, content});
      } else if(stageId && !aud){
        unclear.push({title:b.title, context:stageName, stageId, aud:null, content});
      } else {
        unclear.push({title:b.title, context:null, stageId:null, aud:null, content});
      }
    }
    return {results, unclear};
  }
  function doCopyRec(){
    const text = $('#copyRecInput').value.trim();
    if(!text){ toast('请粘贴文案文档'); return; }
    const parsed = parseCopyForNotifications(text);
    const box = $('#copyRecResult');
    renderCopyRecPreview(box, parsed.results, parsed.unclear);
    project._copyRecDraft = { text, results: parsed.results, unclear: parsed.unclear };
    scheduleAutoSave();
  }
  function applyCopyRec(results, unclear, mode){
    const resBox = $('#copyRecResult');
    let targets=[]; // {stageId, aud, content, stageName, notifIdx}
    if(mode==='res'){
      const checked = $$('.res-pick:checked', resBox).map(x=>parseInt(x.value,10));
      checked.forEach(i=>{
        const r=results[i];
        const notifIdx = parseInt($('.cr-notif-sel[data-mode="res"][data-idx="'+i+'"]', resBox).value,10) || 1;
        targets.push({stageId:r.stageId, aud:r.aud, content:r.content, stageName:r.stageName, notifIdx});
      });
    } else {
      const checked = $$('.unc-pick:checked', resBox).map(x=>parseInt(x.value,10));
      let missing=0;
      checked.forEach(i=>{
        const u = unclear[i];
        const stageId = $(`.cr-stage-sel[data-idx="${i}"]`, resBox).value;
        const aud = $(`.cr-aud-sel[data-idx="${i}"]`, resBox).value;
        const notifIdx = parseInt($('.cr-notif-sel[data-mode="unc"][data-idx="'+i+'"]', resBox).value,10) || 1;
        if(!stageId || !aud){ missing++; return; }
        const st = project.stages.find(s=>s.id===stageId);
        targets.push({stageId, aud, content:u.content, stageName:(st&&st.name)||'', notifIdx});
      });
      if(missing>0){ toast('有 '+missing+' 条未选择阶段或受众，请补全后再应用'); return; }
    }
    if(targets.length===0){ toast('请先勾选要应用的项'); return; }
    // 先确保目标通知存在（无则自动创建）
    targets.forEach(t=>{
      const stage = project.stages.find(s=>s.id===t.stageId);
      ensureNotificationExists(stage, t.notifIdx);
    });
    let willOverwrite=0;
    targets.forEach(t=>{
      const stage = project.stages.find(s=>s.id===t.stageId);
      if(!stage || !stage.notifications || stage.notifications.length<t.notifIdx) return;
      const n = stage.notifications[t.notifIdx-1];
      const ac = n.audienceContent[t.aud];
      if(ac && ac.content && ac.content.trim() && ac.content.trim()!==t.content.trim()) willOverwrite++;
    });
    if(willOverwrite>0 && !confirm('选中的 '+willOverwrite+' 条文案将覆盖已有通知文案，是否继续？')) return;
    let applied=0; const skipped=[];
    targets.forEach(t=>{
      const stage = project.stages.find(s=>s.id===t.stageId);
      if(!stage){ skipped.push(t.stageName||'未知阶段'); return; }
      ensureNotificationExists(stage, t.notifIdx);
      const n = stage.notifications[t.notifIdx-1];
      if(!n){ skipped.push(t.stageName||'未知阶段'); return; }
      const ac = n.audienceContent[t.aud];
      if(!ac) return;
      ac.content = t.content;
      ac.inputMode = 'paste';
      ac.enabled = true;
      applied++;
    });
    delete project._copyRecDraft;
    if(resBox) resBox.innerHTML='';
    scheduleAutoSave();
    render();
    let msg = '已应用 '+applied+' 处（设为「直接粘贴」并启用）';
    if(skipped.length) msg += '；'+skipped.join('、')+' 未找到阶段，已跳过';
    toast(msg);
  }
  function ensureNotificationExists(stage, idx){
    if(!stage) return;
    if(!stage.notifications) stage.notifications=[];
    while(stage.notifications.length < idx){ stage.notifications.push(defaultNotification()); }
  }

  // ---------- 分类管理 ----------
  function openCategoryManager(){
    renderCategoryList();
    $('#categoryModal').classList.add('show');
  }
  function renderCategoryList(){
    const cats = getCategories();
    const wrap = $('#categoryList'); wrap.innerHTML='';
    if(cats.length===0){ wrap.innerHTML='<p class="sub">暂无分类。</p>'; return; }
    cats.forEach(c=>{
      const d = document.createElement('div'); d.className='group-row';
      d.innerHTML = `<span style="flex:1">${esc(c)}</span>
        <span class="sub">${projects.filter(p=>p.category===c).length} 个项目</span>
        <button class="ghost danger mini-btn" data-delcat="${esc(c)}">删除</button>`;
      d.querySelector('[data-delcat]').addEventListener('click',async ()=>{
        if(!confirm(`确认删除分类「${c}」？该分类下的项目将变为未分类。`)) return;
        const affected = projects.filter(p=>p.category===c);
        for(const meta of affected){
          try{
            let p;
            if(SERVER_MODE){
              const r=await fetch('/api/project/'+meta.id);
              const j=await r.json(); p=j.project||{};
            }else if(_sb){
              const v=await cloudGet('project:'+meta.id); p=(v&&Object.keys(v).length)?v:{};
            }else{
              p=JSON.parse(localStorage.getItem('tn_v10_'+meta.id)||'{}');
            }
            p.category=''; p.updatedAt=new Date().toISOString();
            if(SERVER_MODE){
              await fetch('/api/project/'+meta.id,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});
            }else if(_sb){
              await cloudSet('project:'+meta.id, p);
            }else{
              localStorage.setItem('tn_v10_'+meta.id,JSON.stringify(p));
            }
          }catch(e){}
        }
        await loadProjectList();
        renderCategoryList();
        if(view==='list') renderHomeSidebar();
      });
      wrap.appendChild(d);
    });
  }

  // ---------- 杂项 ----------
  function toast(msg, opts){
    const tone = (opts && opts.tone) || 'info';   // info: 底部黑框（默认）；warn: 顶部黄色横幅，停留更久
    const duration = (opts && opts.duration) || (tone === 'warn' ? 6000 : 2600);
    const cls = tone === 'warn' ? 'toast toast-warn' : 'toast';
    let t = tone === 'warn' ? $('#toast-warn') : $('#toast');
    if(!t){
      t = document.createElement('div');
      t.id = tone === 'warn' ? 'toast-warn' : 'toast';
      t.className = cls;
      document.body.appendChild(t);
    } else {
      t.className = cls;
    }
    t.textContent = msg;
    t.classList.add('show');
    if(t._timer) clearTimeout(t._timer);
    t._timer = setTimeout(()=> t.classList.remove('show'), duration);
  }
  async function newProjectFlow(){
    const id = await createProject();
    if(id) setView('edit', id);
  }

  // ---------- 事件绑定 ----------
  $('#btnAddGroup').addEventListener('click',()=>{
    const name=$('#gName').value.trim(), type=$('#gType').value, url=$('#gUrl').value.trim();
    if(!name||!url){ toast('请填写群名称和 Webhook'); return; }
    globalGroups.push({id:uid(),name,type,webhookUrl:url,pinned:false});
    saveGlobalGroups(); $('#gName').value=''; $('#gUrl').value=''; renderGroups(); if(view==='edit') render();
  });
  $('#gSearch').addEventListener('input',renderGroups);
  $('#gFilter').addEventListener('change',renderGroups);
  $('#btnDoTestSend').addEventListener('click', doTestSend);
  $('#assocPickerSearch').addEventListener('input',renderAssocPicker);
  $('#assocPickerFilter').addEventListener('change',renderAssocPicker);
  $('#btnConfirmAssoc').addEventListener('click', confirmAssocPicker);
  $('#btnAddCategory').addEventListener('click',()=>{
    const name = $('#newCategoryName').value.trim();
    if(!name){ toast('请输入分类名称'); return; }
    // 如果当前在项目页且正在编辑项目信息，自动填入
    if(view==='edit' && editSection==='meta'){
      project.category = name;
      scheduleAutoSave();
    }
    $('#newCategoryName').value='';
    renderCategoryList();
    if(view==='list') renderHomeSidebar();
    if(view==='edit' && editSection==='meta') renderProjectMain();
    toast('分类已添加');
  });
  $$('[data-close]').forEach(x=> x.addEventListener('click',()=> $('#'+x.dataset.close).classList.remove('show')));
  $$('.modal-mask').forEach(m=>{
    if(m.id==='templateModal' || m.id==='authMask') return; // 登录遮罩/模板管理弹窗仅允许通过按钮关闭，防止误触
    m.addEventListener('click',e=>{ if(e.target===m) m.classList.remove('show'); });
  });

  // ===================== 系列推送（独立模块 · 不影响现有通知/调度/概览） =====================
  // 数据真源：tn_kv 键 `series:<pid>`，与 project:<pid> 完全隔离（现有 silentSave/pollOverview 不触碰）。
  // 定时发送：独立 Edge Function send-due-series + 独立 pg_cron，复用 tn_sends 做幂等。
  // 现有 send-due-scheduled / 图文编排 / 推送概览：零改动。

  // 2026 法定节假日（内置，年度更新）。周末恒定排除；节假日为最佳努力值，日历可逐日人工修正。
  const SERIES_HOLIDAYS_2026 = {
    '2026-01-01':'元旦','2026-01-02':'元旦','2026-01-03':'元旦',
    '2026-02-17':'春节','2026-02-18':'春节','2026-02-19':'春节','2026-02-20':'春节','2026-02-21':'春节','2026-02-22':'春节','2026-02-23':'春节',
    '2026-04-04':'清明','2026-04-05':'清明','2026-04-06':'清明',
    '2026-05-01':'劳动节','2026-05-02':'劳动节','2026-05-03':'劳动节','2026-05-04':'劳动节','2026-05-05':'劳动节',
    '2026-06-19':'端午','2026-06-20':'端午','2026-06-21':'端午',
    '2026-09-25':'中秋','2026-09-26':'中秋','2026-09-27':'中秋',
    '2026-10-01':'国庆','2026-10-02':'国庆','2026-10-03':'国庆','2026-10-04':'国庆','2026-10-05':'国庆','2026-10-06':'国庆','2026-10-07':'国庆'
  };
  function seriesWeekend(dStr){ const d=new Date(dStr+'T00:00:00'); const w=d.getDay(); return w===0||w===6; }
  function seriesHolidayName(dStr, custom){
    if(custom){ const c=(custom||'').split(/\r?\n/).map(x=>x.trim()).filter(Boolean); if(c.includes(dStr)) return '自定义跳过'; }
    return SERIES_HOLIDAYS_2026[dStr]||'';
  }
  function seriesIsNonWork(dStr, s){
    if(seriesWeekend(dStr)) return true;
    if(s.excludeHoliday!==false && seriesHolidayName(dStr, s.customSkip)) return true;
    return false;
  }

  let seriesData = { series:[], holidays:{}, __pid:null };
  let activeSeriesId = null;
  let seriesSaveTimer = null;
  let seriesCalY = 2026, seriesCalM = 9;
  const seriesStatus = {}; // sid -> { 'YYYY-MM-DD': 'sent'|'failed' }

  function seriesFind(id){ return (seriesData.series||[]).find(s=>s.id===id); }
  function seriesFmt(d){ const p=n=>n<10?'0'+n:''+n; return d.getFullYear()+'-'+p(d.getMonth()+1)+'-'+p(d.getDate()); }
  function seriesParse(s){ const a=String(s).split('-').map(Number); return new Date(a[0],a[1]-1,a[2]); }

  async function seriesLoad(){
    if(!currentProjectId) return;
    if(seriesData.__pid===currentProjectId) return; // 同项目只拉一次
    try{
      const d = await cloudGet('series:'+currentProjectId);
      seriesData = (d && typeof d==='object') ? d : { series:[], holidays:{} };
    }catch(e){ seriesData = { series:[], holidays:{} }; }
    if(!seriesData.series) seriesData.series=[];
    if(!seriesData.holidays) seriesData.holidays={};
    seriesData.__pid = currentProjectId;
  }
  function seriesSave(){
    if(seriesSaveTimer) clearTimeout(seriesSaveTimer);
    seriesSaveTimer = setTimeout(async ()=>{
      if(!currentProjectId) return;
      await cloudSet('series:'+currentProjectId, seriesData);
    }, 600);
  }
  async function seriesRefreshStatus(s){
    if(!_sb) return;
    try{
      const like = 'series:'+currentProjectId+':'+s.id+':*';
      const { data } = await _sb.from('tn_sends').select('id,status').like('id', like);
      const map = {};
      (data||[]).forEach(r=>{ const m=/:([\d-]{8,})?:?main$/.exec(r.id); if(!m) return; map[m[1]] = (r.status==='sent'?'sent':(r.status==='failed'?'failed':'sent')); });
      seriesStatus[s.id] = map;
    }catch(e){ /* tn_sends 可能不可读，忽略 */ }
  }
  function seriesEnsureStyles(){
    if(document.getElementById('seriesStyles')) return;
    const st=document.createElement('style'); st.id='seriesStyles';
    st.textContent = `
      .series-cal{display:grid;grid-template-columns:repeat(7,1fr);gap:6px;margin-top:8px}
      .series-cal .cell{border:1px solid var(--bd,#e5e7eb);border-radius:8px;min-height:74px;padding:6px;cursor:pointer;position:relative;background:#fff;font-size:12px}
      .series-cal .cell:hover{box-shadow:0 1px 6px rgba(0,0,0,.12)}
      .series-cal .cell.dim{background:#f7f8fa;color:#bbb;cursor:default}
      .series-cal .cell .d{font-weight:600}
      .series-cal .cell .tag{position:absolute;right:5px;top:5px;font-size:10px;padding:1px 5px;border-radius:6px}
      .series-cal .tag.sent{background:#e7f7ec;color:#1a7f37}
      .series-cal .tag.fail{background:#fdecec;color:#c0392b}
      .series-cal .tag.skip{background:#fff4e0;color:#b9770e}
      .series-cal .tag.off{background:#f0f1f3;color:#9aa0a6}
      .series-cal .tag.ready{background:#eef4ff;color:#2563eb}
      .series-cal .weekday{text-align:center;font-size:11px;color:var(--sub,#888);padding-bottom:2px}
      .seg button{border:1px solid var(--bd,#e5e7eb);background:#fff;padding:6px 14px;font-size:13px;cursor:pointer}
      .seg button.active{background:var(--brand,#3370ff);color:#fff;border-color:var(--brand,#3370ff)}
      .seg button:first-child{border-radius:6px 0 0 6px}
      .seg button:last-child{border-radius:0 6px 6px 0}
      .seg button:not(:first-child){border-left:none}
      .chk-group{display:flex;flex-wrap:wrap;gap:8px;max-height:120px;overflow:auto}
      .chk-group .chk{display:inline-flex;align-items:center;gap:4px;font-size:13px}
      .series-day-img{height:90px;background:#eef1f5;background-size:cover;background-position:center;border-radius:6px;margin-bottom:6px}
    `;
    document.head.appendChild(st);
  }

  function renderSeriesSection(){
    seriesEnsureStyles();
    const wrap = document.createElement('div');
    wrap.innerHTML = `<h3>系列推送</h3>
      <div class="sub" style="margin-bottom:10px">按"某段时间内每日固定时间推送不同图文"的场景设计。数据独立存储，定时发送走独立调度链路，<b>不影响现有通知与图文编排</b>。发送状态在下方日历中实时显示（读自 tn_sends）。</div>
      <div class="row" style="gap:10px;align-items:flex-end;margin-bottom:14px">
        <div class="field"><label>选择系列</label><select id="seriesSel"></select></div>
        <button class="primary" id="btnNewSeries">+ 新建系列</button>
        <button class="ghost danger" id="btnDelSeries">删除当前系列</button>
      </div>
      <div id="seriesBody"></div>`;
    const sel = wrap.querySelector('#seriesSel');
    function fillSel(){
      if((seriesData.series||[]).length===0){ sel.innerHTML='<option value="">（暂无系列）</option>'; }
      else { sel.innerHTML = (seriesData.series||[]).map(s=>`<option value="${s.id}">${esc(s.name||'未命名系列')}</option>`).join(''); }
      if(activeSeriesId && seriesFind(activeSeriesId)) sel.value=activeSeriesId;
    }
    fillSel();
    sel.addEventListener('change',()=>{ activeSeriesId=sel.value||null; renderSeriesBody(); });
    wrap.querySelector('#btnNewSeries').addEventListener('click',()=>{
      const s={ id:uid(), name:'新系列 '+((seriesData.series||[]).length+1), targetGroupIds:[], time:'09:00', startDate:'', endDate:'', layout:'inline', excludeHoliday:true, customSkip:'', days:{}, createdAt:new Date().toISOString() };
      seriesData.series=seriesData.series||[]; seriesData.series.push(s); activeSeriesId=s.id; seriesSave(); fillSel(); renderSeriesBody();
    });
    wrap.querySelector('#btnDelSeries').addEventListener('click',()=>{
      if(!activeSeriesId){ toast('请先选择系列'); return; }
      if(!confirm('删除当前系列及其所有日期内容？不可撤销。')) return;
      seriesData.series = (seriesData.series||[]).filter(x=>x.id!==activeSeriesId);
      delete seriesStatus[activeSeriesId]; activeSeriesId=null; seriesSave(); fillSel(); renderSeriesBody();
    });
    // 异步加载（同项目只拉一次），加载完重绘
    seriesLoad().then(()=>{ if(activeSeriesId && !seriesFind(activeSeriesId)) activeSeriesId=null; fillSel(); renderSeriesBody(); });
    setTimeout(renderSeriesBody,0);
    return wrap;
  }

  function renderSeriesBody(){
    const body = document.getElementById('seriesBody');
    if(!body) return;
    const s = activeSeriesId ? seriesFind(activeSeriesId) : null;
    if(!s){ body.innerHTML='<div class="section-empty">点击「新建系列」开始，或在上方选择一个系列。</div>'; return; }
    body.innerHTML = `
      <div class="card">
        <h4>① 系列配置</h4>
        <div class="row">
          <div class="field"><label>系列名称</label><input type="text" id="sName" value="${esc(s.name||'')}"></div>
          <div class="field"><label>每日发送时间</label><input type="time" id="sTime" value="${esc(s.time||'09:00')}"></div>
        </div>
        <div class="row">
          <div class="field"><label>起止日期</label>
            <div class="row" style="gap:6px;margin:0">
              <input type="date" id="sStart" value="${esc(s.startDate||'')}">
              <span class="sub">至</span>
              <input type="date" id="sEnd" value="${esc(s.endDate||'')}">
            </div>
          </div>
          <div class="field" style="flex:1;min-width:240px"><label>目标群（复用通讯录）</label>
            <div id="sGroups" class="chk-group"></div>
          </div>
        </div>
        <div class="row">
          <div class="field" style="max-width:380px"><label>默认消息版式</label>
            <div class="seg" id="sLayout">
              <button data-lv="inline" class="${s.layout==='inline'?'active':''}">图文并排</button>
              <button data-lv="card" class="${s.layout==='card'?'active':''}">卡片式</button>
              <button data-lv="text" class="${s.layout==='text'?'active':''}">纯文字</button>
            </div>
          </div>
          <label class="switch" style="align-self:flex-end"><input type="checkbox" id="sExcl" ${s.excludeHoliday!==false?'checked':''}><span class="slider"></span></label>
          <span style="align-self:flex-end">自动排除周末/节假日</span>
        </div>
        <div class="field"><label>自定义跳过日期（可选，每行一个 YYYY-MM-DD）</label>
          <textarea id="sCustomSkip" style="min-height:50px">${esc(s.customSkip||'')}</textarea>
        </div>
      </div>

      <div class="card">
        <h4>② 内容导入</h4>
        <div class="row" style="gap:10px;align-items:center">
          <button class="ghost" id="btnTpl">⬇ 下载 Excel 填写模板</button>
          <button class="ghost" id="seriesUploadBox">📎 上传表格（.xlsx/.csv）</button>
          <input type="file" id="seriesFile" accept=".xlsx,.xls,.csv" hidden>
          <span class="sub">已配置 <b id="dayCount">${Object.keys(s.days||{}).length}</b> 天</span>
        </div>
        <div class="sub" style="margin-top:6px">图片建议留空，上传请在日历里完成，系统自动生成链接。</div>
      </div>

      <div class="card">
        <h4>③ 日历视图（点日期编辑 / 上传图片 / 预览 / 测发）</h4>
        <div class="row" style="gap:10px;align-items:center;margin-bottom:8px">
          <button class="ghost" id="calPrev">◀</button>
          <b id="calTitle"></b>
          <button class="ghost" id="calNext">▶</button>
          <button class="ghost" id="btnGenDays">按起止日期生成工作日</button>
          <span class="sub" id="calHint"></span>
        </div>
        <div class="series-cal" id="calHead"></div>
        <div class="series-cal" id="calGrid"></div>
      </div>
    `;
    body.querySelector('#sName').addEventListener('input',e=>{ s.name=e.target.value; seriesSave(); });
    body.querySelector('#sTime').addEventListener('change',e=>{ s.time=e.target.value; seriesSave(); });
    body.querySelector('#sStart').addEventListener('change',e=>{ s.startDate=e.target.value; if(s.startDate){ const d=seriesParse(s.startDate); seriesCalY=d.getFullYear(); seriesCalM=d.getMonth()+1; } renderCalendar(s); seriesSave(); });
    body.querySelector('#sEnd').addEventListener('change',e=>{ s.endDate=e.target.value; seriesSave(); });
    body.querySelector('#sExcl').addEventListener('change',e=>{ s.excludeHoliday=e.target.checked; renderCalendar(s); seriesSave(); });
    body.querySelector('#sCustomSkip').addEventListener('input',e=>{ s.customSkip=e.target.value; renderCalendar(s); seriesSave(); });
    const gwrap=body.querySelector('#sGroups');
    gwrap.innerHTML = (globalGroups||[]).map(g=>`<label class="chk"><input type="checkbox" class="sgpick" value="${g.id}" ${((s.targetGroupIds||[]).includes(g.id))?'checked':''}> ${esc(g.name)}</label>`).join('') || '<span class="sub">通讯录暂无群，请先到「群通讯录」添加。</span>';
    gwrap.querySelectorAll('.sgpick').forEach(cb=>cb.addEventListener('change',()=>{ s.targetGroupIds=Array.from(gwrap.querySelectorAll('.sgpick:checked')).map(x=>x.value); seriesSave(); }));
    body.querySelector('#sLayout').querySelectorAll('button').forEach(b=>b.addEventListener('click',()=>{ s.layout=b.dataset.lv; body.querySelector('#sLayout').querySelectorAll('button').forEach(x=>x.classList.toggle('active',x===b)); renderCalendar(s); seriesSave(); }));
    const fileInput=body.querySelector('#seriesFile');
    body.querySelector('#seriesUploadBox').addEventListener('click',()=>fileInput.click());
    fileInput.addEventListener('change',e=>seriesHandleFile(e,s));
    body.querySelector('#btnTpl').addEventListener('click',()=>seriesDownloadTemplate());
    body.querySelector('#calPrev').addEventListener('click',()=>{ seriesCalM--; if(seriesCalM<1){seriesCalM=12;seriesCalY--;} renderCalendar(s); });
    body.querySelector('#calNext').addEventListener('click',()=>{ seriesCalM++; if(seriesCalM>12){seriesCalM=1;seriesCalY++;} renderCalendar(s); });
    body.querySelector('#btnGenDays').addEventListener('click',()=>seriesGenDays(s));
    if(s.startDate){ const d=seriesParse(s.startDate); seriesCalY=d.getFullYear(); seriesCalM=d.getMonth()+1; }
    seriesRefreshStatus(s).then(()=>renderCalendar(s));
    renderCalendar(s);
  }

  function seriesStatusOf(s,date){
    const m = seriesStatus[s.id]; if(m && m[date]) return m[date];
    return '';
  }
  function renderCalendar(s){
    const grid=document.getElementById('calGrid'); const head=document.getElementById('calHead'); const title=document.getElementById('calTitle'); const hint=document.getElementById('calHint');
    if(!grid) return;
    const wd=['日','一','二','三','四','五','六'];
    head.innerHTML=wd.map(w=>`<div class="weekday">${w}</div>`).join('');
    title.textContent=seriesCalY+'年'+seriesCalM+'月';
    const first=new Date(seriesCalY,seriesCalM-1,1); const startDay=first.getDay();
    const daysInMonth=new Date(seriesCalY,seriesCalM,0).getDate();
    let html='';
    for(let i=0;i<startDay;i++) html+='<div class="cell dim"></div>';
    for(let d=1;d<=daysInMonth;d++){
      const ds=seriesCalY+'-'+(seriesCalM<10?'0':'')+seriesCalM+'-'+(d<10?'0':'')+d;
      const day=s.days&&s.days[ds]?s.days[ds]:null;
      const nonWork=seriesIsNonWork(ds,s);
      const st=seriesStatusOf(s,ds);
      let tag='';
      if(st==='sent') tag='<span class="tag sent">已发</span>';
      else if(st==='failed') tag='<span class="tag fail">失败</span>';
      else if(day&&day.skip) tag='<span class="tag skip">跳过</span>';
      else if(nonWork) tag='<span class="tag off">休</span>';
      else if(day&&(day.title||day.body||day.img)) tag='<span class="tag ready">待发</span>';
      const dim = nonWork && !day ? ' dim':'';
      html+=`<div class="cell${dim}" data-date="${ds}"><div class="d">${d}</div>${tag}</div>`;
    }
    grid.innerHTML=html;
    grid.querySelectorAll('.cell[data-date]').forEach(c=>c.addEventListener('click',()=>seriesOpenDay(s,c.dataset.date)));
    const configured=Object.keys(s.days||{}).length;
    const working=Object.keys(s.days||{}).filter(dt=>!seriesIsNonWork(dt,s)).length;
    hint.textContent=`工作日内已配置 ${working} / 共 ${configured} 天`;
  }

  function seriesGenDays(s){
    if(!s.startDate||!s.endDate){ toast('请先设置起止日期'); return; }
    let cur=seriesParse(s.startDate); const end=seriesParse(s.endDate);
    if(cur>end){ toast('起止日期无效'); return; }
    let n=0;
    while(cur<=end){
      const ds=seriesFmt(cur);
      if(!seriesIsNonWork(ds,s)){ if(!s.days) s.days={}; if(!s.days[ds]) s.days[ds]={title:'',body:'',img:'',link:'',skip:false}; n++; }
      cur.setDate(cur.getDate()+1);
    }
    seriesSave(); renderCalendar(s);
    document.getElementById('dayCount').textContent=Object.keys(s.days||{}).length;
    toast('已生成 '+n+' 个工作日');
  }

  function seriesOpenDay(s,date){
    const day=(s.days&&s.days[date])||{title:'',body:'',img:'',link:'',skip:false,layout:''};
    let mask=document.getElementById('seriesDayMask');
    if(!mask){ mask=document.createElement('div'); mask.className='modal-mask'; mask.id='seriesDayMask';
      mask.innerHTML=`<div class="modal" style="width:680px"><div id="seriesDayInner"></div></div>`; document.body.appendChild(mask);
      mask.addEventListener('click',e=>{ if(e.target===mask) mask.classList.remove('show'); });
    }
    const inner=mask.querySelector('#seriesDayInner');
    const lv=day.layout||s.layout;
    function fieldRow(label,help,input){
      return `<div class="row"><div class="field" style="flex:1"><label>${label}${help?` <span class="sub">${help}</span>`:''}</label>${input}</div></div>`;
    }
    inner.innerHTML=`
      <h3>编辑当日内容 · ${date}${seriesIsNonWork(date,s)?'（'+seriesHolidayName(date,s.customSkip||'')+'·非工作日）':''}</h3>
      ${fieldRow('标题 <span class="sub">→ 消息首行加粗</span>','',`<input type="text" id="mTitle" value="${esc(day.title||'')}">`)}
      ${(lv==='text')?'':fieldRow('正文 <span class="sub">→ 标题下正文；图文并排可插入图片</span>','',`<textarea id="mBody" style="min-height:90px">${esc(day.body||'')}</textarea>`)}
      ${(lv==='text')?'':`<div class="row"><div class="field" style="flex:1"><label>${(lv==='card')?'配图 → 卡片大图（仅一张）':'正文插图（可选）'}</label><div class="row" style="gap:6px;margin:0"><input type="text" id="mImg" value="${esc(day.img||'')}" placeholder="可填图片URL，或点上传"><button id="mUploadBtn" type="button">🖼 上传</button></div></div></div>`}
      ${fieldRow('跳转链接 <span class="sub">→ 卡片式=整卡跳转；并排/纯文字=文末「查看详情」</span>','',`<input type="text" id="mLink" value="${esc(day.link||'')}">`)}
      <div class="row">
        <div class="field" style="max-width:240px"><label>当日版式（覆盖默认）</label>
          <select id="mLayout"><option value="">跟随系列默认（${lv==='inline'?'图文并排':lv==='card'?'卡片式':'纯文字'}）</option><option value="inline">图文并排</option><option value="card">卡片式</option><option value="text">纯文字</option></select>
        </div>
        <label class="switch" style="align-self:flex-end"><input type="checkbox" id="mSkip" ${day.skip?'checked':''}><span class="slider"></span></label>
        <span style="align-self:flex-end">当日跳过（临时停更，内容保留）</span>
      </div>
      <h4>消息预览（按所选版式实时渲染）</h4>
      <div id="seriesPreview" style="border:1px solid var(--bd,#e5e7eb);border-radius:8px;padding:10px;background:#fafbfc"></div>
      <div style="display:flex;gap:10px;margin-top:12px">
        <button class="primary" id="mSave">保存</button>
        <button id="mTest">测试发送（隔离群）</button>
        <button class="ghost" id="mClose">取消</button>
      </div>
      <input type="file" id="mFile" accept="image/*" hidden>
    `;
    function renderPrev(){
      const t=inner.querySelector('#mTitle').value, b=inner.querySelector('#mBody')?inner.querySelector('#mBody').value:'', img=inner.querySelector('#mImg').value, link=inner.querySelector('#mLink').value;
      const layout=inner.querySelector('#mLayout').value||s.layout;
      const pv=inner.querySelector('#seriesPreview');
      const esc2=x=>(x||'').replace(/&/g,'&amp;').replace(/</g,'&lt;');
      if(!t&&!b&&!img){ pv.innerHTML='<div class="sub">填写左侧字段后，这里实时显示群里收到的消息效果</div>'; return; }
      if(layout==='card'){
        pv.innerHTML=`<div style="border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;max-width:320px"><div style="height:130px;background:#dde3ea ${img?`url('${esc2(img)}') center/cover`:''}"></div><div style="padding:8px 10px"><div style="font-weight:600">${esc2(t)||'（无标题）'}</div><div style="font-size:12px;color:#666;margin-top:2px">${esc2(b)}</div></div></div><div class="sub" style="margin-top:4px">${link?('点击整张卡片跳转 → '+esc2(link)):'（未填跳转链接）'}</div>`;
      }else{
        pv.innerHTML=`<div style="background:#fff;border:1px solid #e5e7eb;border-radius:8px;padding:8px 10px;max-width:360px"><div style="font-weight:600">${esc2(t)||'（无标题）'}</div>${inner.querySelector('#mBody')?`<div style="font-size:13px;margin-top:4px;white-space:pre-wrap">${esc2(b).replace(/!\[[^\]]*\]\(([^)]+)\)/g,'<img src="$1" style="max-width:100%;border-radius:6px;margin:4px 0;display:block">')}</div>`:''}${link?`<div style="font-size:12px;color:#2563eb;margin-top:4px">🔗 查看详情</div>`:''}</div>`;
      }
    }
    inner.querySelector('#mTitle').addEventListener('input',renderPrev);
    if(inner.querySelector('#mBody')) inner.querySelector('#mBody').addEventListener('input',renderPrev);
    inner.querySelector('#mImg').addEventListener('input',renderPrev);
    inner.querySelector('#mLink').addEventListener('input',renderPrev);
    inner.querySelector('#mLayout').addEventListener('change',renderPrev);
    inner.querySelector('#mUploadBtn').addEventListener('click',()=>inner.querySelector('#mFile').click());
    inner.querySelector('#mFile').addEventListener('change',async e=>{
      const f=e.target.files[0]; if(!f) return;
      const r=await readFileAsDataUrl(f); const up=await cloudUpload(r);
      if(up.success){ inner.querySelector('#mImg').value=up.url; renderPrev(); toast('已上传'); } else { toast('上传失败：'+up.error); }
      e.target.value='';
    });
    renderPrev();
    inner.querySelector('#mSave').addEventListener('click',()=>{
      if(!s.days) s.days={};
      s.days[date]={ title:inner.querySelector('#mTitle').value, body:inner.querySelector('#mBody')?inner.querySelector('#mBody').value:'', img:inner.querySelector('#mImg').value, link:inner.querySelector('#mLink').value, skip:inner.querySelector('#mSkip').checked, layout:inner.querySelector('#mLayout').value };
      seriesSave(); mask.classList.remove('show'); renderCalendar(s);
      const dc=document.getElementById('dayCount'); if(dc) dc.textContent=Object.keys(s.days||{}).length;
      toast('已保存 '+date);
    });
    inner.querySelector('#mClose').addEventListener('click',()=>mask.classList.remove('show'));
    inner.querySelector('#mTest').addEventListener('click',()=>seriesTestSend(s,date));
    mask.classList.add('show');
  }

  function seriesBuildPayload(day,s){
    const layout=day.layout||s.layout;
    if(layout==='card'){
      if(day.img){
        return { msgtype:'news', news:{ articles:[{ title:day.title||'通知', description:(day.body||'').replace(/!\[[^\]]*\]\([^)]*\)/g,'').slice(0,200), url:day.link||'https://work.weixin.qq.com/', picurl:day.img }] } };
      }
      // 卡片无图降级为并排
    }
    const content=((day.title?('**'+day.title+'**\n'):'')+(day.body||'')+(day.link?('\n[查看详情]('+day.link+')'):''));
    const articleUrl=day.link||'https://work.weixin.qq.com/';
    return RenderCore.buildNewsPayload(content,{ articleUrl });
  }
  async function seriesTestSend(s,date){
    const day=(s.days&&s.days[date])||{};
    if(!day.title&&!day.body&&!day.img){ toast('当天内容为空'); return; }
    const testG=(globalGroups||[]).find(g=>g.type==='test');
    if(!testG){ toast('未找到测试群（类型=test），请先在群通讯录添加'); return; }
    const payload=seriesBuildPayload(day,s);
    try{
      const { data, error } = await _sb.functions.invoke('send-v10',{ body:{ items:[{ webhookUrl:testG.webhookUrl, groupName:testG.name, payload }], testMode:true } });
      if(error) toast('测试发送失败：'+error.message); else toast('已发送测试到隔离群「'+(testG.name||'')+'」');
    }catch(e){ toast('测试发送异常：'+e.message); }
  }

  // ---- 表格上传解析 ----
  async function seriesEnsureXLSX(){
    if(window.XLSX) return;
    await new Promise((res,rej)=>{ const sc=document.createElement('script'); sc.src='https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js'; sc.onload=res; sc.onerror=rej; document.head.appendChild(sc); });
  }
  function seriesParseCSV(text){
    const rows=[]; let row=[],cur='',inQ=false;
    for(let i=0;i<text.length;i++){ const ch=text[i];
      if(inQ){ if(ch==='"'){ if(text[i+1]==='"'){cur+='"';i++;}else inQ=false; } else cur+=ch; }
      else { if(ch==='"') inQ=true; else if(ch===','){ row.push(cur);cur=''; } else if(ch==='\n'||ch==='\r'){ if(ch==='\r'&&text[i+1]==='\n')i++; row.push(cur);cur=''; if(row.some(x=>x!==''))rows.push(row); row=[]; } else cur+=ch; }
    }
    row.push(cur); if(row.some(x=>x!==''))rows.push(row); return rows;
  }
  function readFileAsDataUrl(f){ return new Promise((res,rej)=>{ const r=new FileReader(); r.onload=()=>res(r.result); r.onerror=rej; r.readAsDataURL(f); }); }
  async function seriesHandleFile(e,s){
    const f=e.target.files[0]; if(!f) return;
    try{
      const buf=await f.arrayBuffer();
      let rows;
      if(/\.csv$/i.test(f.name)){ let txt=new TextDecoder('utf-8').decode(buf); if(txt.includes('�')) txt=new TextDecoder('gbk').decode(buf); rows=seriesParseCSV(txt); }
      else { await seriesEnsureXLSX(); const wb=XLSX.read(buf,{type:'array'}); rows=XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]],{header:1,raw:false}); }
      seriesIngest(rows,s);
    }catch(err){ toast('解析失败：'+err.message); }
    e.target.value='';
  }
  function seriesIngest(rows,s){
    if(!rows||!rows.length){ toast('表格为空'); return; }
    const head=rows[0].map(x=>String(x||'').trim());
    const idx=n=>head.findIndex(h=>h.includes(n));
    let map;
    if(idx('标题')>=0){ map={date:idx('日期'),title:idx('标题'),desc:idx('描述'),img:idx('图片'),link:idx('跳转'),layout:idx('版式'),skip:idx('跳过')}; rows=rows.slice(1); }
    else { map={date:0,title:1,desc:2,img:3,link:4,layout:-1,skip:-1}; }
    const get=(r,i)=>i>=0?(r[i]||'').trim():'';
    const LV={'并排':'inline','图文并排':'inline','卡片':'card','卡片式':'card','纯文字':'text'};
    let n=0; s.days=s.days||{};
    rows.forEach(r=>{
      let date=get(r,map.date), title=get(r,map.title); if(!date&&!title) return;
      if(!date){ toast('存在缺日期的行，已跳过：'+(title||'')); return; }
      const lvRaw=get(r,map.layout); const layout=lvRaw?(LV[lvRaw]||''):'';
      const skip=/^(是|y|yes|true|1)$/i.test(get(r,map.skip));
      s.days[date]={ title, body:get(r,map.desc), img:get(r,map.img), link:get(r,map.link), layout, skip }; n++;
    });
    seriesSave(); if(activeSeriesId) renderCalendar(s);
    const dc=document.getElementById('dayCount'); if(dc) dc.textContent=Object.keys(s.days||{}).length;
    toast('已导入 '+n+' 天');
  }
  async function seriesDownloadTemplate(){
    try{ await seriesEnsureXLSX(); }catch(e){ toast('模板库加载失败，请检查网络'); return; }
    const ws=XLSX.utils.aoa_to_sheet([
      ['日期','标题','描述','图片链接','跳转链接','版式','跳过'],
      ['2026-09-21','【用户成功】用习惯养成学习法拿下季度冠军','30天打卡坚持，她总结出3条可复制经验','','https://yili.com/a','并排','否'],
      ['2026-09-22','【团队突破】跨部门的协作让他少走了三年弯路','一次复盘会带来的组织效率跃迁','','https://yili.com/b','卡片','否'],
      ['2026-09-23','【工具上新】培训数据看板2.0上线','支持按部门自动汇总，导出一键完成','','https://yili.com/c','纯文字','']
    ]);
    ws['!cols']=[{wch:12},{wch:42},{wch:38},{wch:24},{wch:22},{wch:8},{wch:6}];
    const help=XLSX.utils.aoa_to_sheet([
      ['系列推送 · 内容表填写说明'],
      [],['字段','填写说明'],
      ['日期','YYYY-MM-DD 格式。必填。'],
      ['标题','消息首行加粗显示，建议带栏目标签，如【用户成功】'],
      ['描述','正文内容。图文并排版式=可写多段正文；卡片式=一两行摘要；纯文字=全部正文'],
      ['图片链接','⚠ 推荐留空：留空后到日历里点开当天「上传图片」，系统自动生成并填充链接，无需手填 URL、不会出错。卡片式=推送时的大图（仅一张）；图文并排=建议留空，在日历编辑正文中穿插多图。若已有可公开访问的图片 URL 也可直接填，系统原样使用（填错则图片异常）。'],
      ['跳转链接','卡片式=点击整张卡片跳转的地址；图文并排/纯文字=文末自动生成「查看详情」链接'],
      ['版式','可选值：并排 / 卡片 / 纯文字。留空则跟随系列默认版式'],
      ['跳过','可选值：是 / 否。填「是」表示该日临时停更（内容保留，之后可取消跳过补发）'],
      [],['注意：表头名称请勿修改，列顺序不限；无需的列可整列删除']
    ]);
    help['!cols']=[{wch:10},{wch:100}];
    const wb=XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb,ws,'内容'); XLSX.utils.book_append_sheet(wb,help,'填写说明');
    XLSX.writeFile(wb,'系列推送-内容模板.xlsx'); toast('模板已下载');
  }


  // ---------- 启动 ----------
  (async function init(){
    // 认证未通过则不加载业务数据（包括 createProject 不会自动写 localStorage）
    // 登录成功后会由 doLogin 内部调用 bootBusiness() 完成首次加载
    const authOk = await setupAuth();
    if(authOk){
      // [v10.7.8 性能优化] 4 个独立数据 fetch 改为 Promise.all 并行，原本串行 4×RTT 现在 1×RTT
      const [g, s, t] = await Promise.all([
        loadGlobalGroups(),
        loadAppSettings(),
        loadTemplates()
      ]);
      seedDefaultTemplates(); // 内存操作，无网络，可立即返回
      await loadProjectList();
      if(projects.length===0){
        const id = await createProject();
        if(id) await loadProjectList();
      }
      render();
    }
  })();
})();
