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
