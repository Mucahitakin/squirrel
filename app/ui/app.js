// Squirrel — arayüz mantığı (ui/index.html sonunda yüklenir).
const $=(id)=>document.getElementById(id);
let datasets=[],liveRunId=null,archiveRuns=[],currentRunId=null,currentTurns=[],liveTurns=new Map();
let selRow=null,selSpan=null,detailData=null,done=0,errs=0,total=0;
try{$('token').value=localStorage.getItem('mmx_sid')||'';}catch{}
const esc=(s)=>String(s??'').replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));

/* ---------- uygulama içi diyaloglar ----------
   Squirrel bir masaüstü uygulamasıdır; tarayıcının alert/confirm'i yerine
   kendi modal'ı kullanılır. sqConfirm({typeToConfirm}) verilirse kullanıcı
   onay için adı aynen yazmak zorundadır (geri alınamaz işlemler). */
function sqDialog({title,html='',warn='',confirmText='Tamam',cancelText='Vazgeç',danger=false,typeToConfirm=null,alertOnly=false}){
  return new Promise((resolve)=>{
    let wrap=$('sqModalWrap');
    if(!wrap){wrap=document.createElement('div');wrap.id='sqModalWrap';document.body.appendChild(wrap);}
    wrap.innerHTML=`<div class="sqModal">
      <h3>${esc(title)}</h3>
      <div class="body">${html}</div>
      ${warn?`<div class="warn">${warn}</div>`:''}
      ${typeToConfirm?`<input id="sqModalType" placeholder="onaylamak için '${esc(typeToConfirm)}' yaz" autocomplete="off" spellcheck="false">`:''}
      <div class="btns">
        ${alertOnly?'':`<button class="cancel" id="sqModalCancel">${esc(cancelText)}</button>`}
        <button class="go${danger?' danger':''}" id="sqModalGo"${typeToConfirm?' disabled':''}>${esc(confirmText)}</button>
      </div></div>`;
    wrap.classList.add('on');
    const close=(val)=>{wrap.classList.remove('on');wrap.innerHTML='';document.removeEventListener('keydown',onKey);resolve(val);};
    const onKey=(e)=>{if(e.key==='Escape'&&!alertOnly)close(false);};
    document.addEventListener('keydown',onKey);
    if(typeToConfirm){
      const inp=$('sqModalType');
      inp.addEventListener('input',()=>{$('sqModalGo').disabled=inp.value.trim()!==typeToConfirm;});
      setTimeout(()=>inp.focus(),40);
    }
    $('sqModalGo').onclick=()=>close(true);
    const cancelBtn=$('sqModalCancel');if(cancelBtn)cancelBtn.onclick=()=>close(false);
    wrap.onclick=(e)=>{if(e.target===wrap&&!alertOnly)close(false);};
  });
}
const sqAlert=(title,html)=>sqDialog({title,html,alertOnly:true});
const sqConfirm=(opts)=>sqDialog(opts);

/* ---------- durum eşleme ---------- */
function stateOf(r){
  const c=r.completion_status||r.status||'';
  if(c==='completed'||c==='final_answer')return['ok','tamamlandı'];
  if((r.status||'').startsWith('request_error'))return['err',r.status.replace('request_error:','')];
  if(c==='failed')return['err','başarısız'];
  if(c==='blocked')return['warn','engellendi'];
  if(c==='incomplete')return['warn','yarım'];
  if(c==='needs_user')return['purple','soru soruldu'];
  if((r.status||'').includes('waiting_for_approval'))return['purple','onay bekliyor'];
  return['gray',c||r.status||'?'];
}
const ICONS={
  ok:'<svg viewBox="0 0 24 24"><path d="M20 6L9 17l-5-5"/></svg>',
  err:'<svg viewBox="0 0 24 24"><path d="M18 6L6 18M6 6l12 12"/></svg>',
  warn:'<svg viewBox="0 0 24 24"><path d="M12 8v5M12 16.5v.5"/></svg>',
  purple:'<svg viewBox="0 0 24 24"><path d="M12 6v6l4 2"/></svg>',
  gray:'<svg viewBox="0 0 24 24"><path d="M5 12h14"/></svg>'};
const stIcon=(s)=>`<span class="stIcon st-${s}">${ICONS[s]||ICONS.gray}</span>`;
const pillHtml=(s,l)=>`<span class="pill p-${s}"><span class="d"></span>${esc(l)}</span>`;

/* ---------- config ---------- */
async function loadConfig(){
  const cfg=await (await fetch('/api/config')).json();
  datasets=cfg.datasets||[];
  renderRepoState(cfg);
  $('cfgOut').textContent=cfg.desktop_out;
  if(cfg.api_key){$('cfgKey').value=cfg.api_key;$('cfgIngest').value=cfg.ingest_url||'';}
  $('cfgLive').checked=cfg.live_ingest!==false;
  $('dataset').innerHTML=datasets.map(d=>`<option value="${d.name}">${d.name} · ${d.count} madde</option>`).join('');
  const pref=datasets.find(d=>d.name==='agent-60')?'agent-60':(datasets[0]||{}).name;
  if(pref)$('dataset').value=pref;
  updDesc();
}
/* ---------- repo (harness) klasörü ----------
   Masaüstünde native klasör seçici (preload köprüsü) kullanılır; tarayıcı
   kipinde yol elle yazılır. Kayıt anında uygulanır, yeniden başlatma yok. */
const DESKTOP=window.squirrelDesktop||null;
function renderRepoState(cfg){
  const ok=Boolean(cfg.repo_ok), root=cfg.repo_root||'';
  $('repoStat').textContent=ok?root:(root?'⚠ harness bulunamadı':'bağımsız kip');
  $('cfgRepo').value=root;
  const box=$('harnessRepo');
  box.classList.toggle('ok',ok);box.classList.toggle('bad',!ok);
  $('harnessRepoState').textContent=ok?'Repo bağlı':'Repo klasörü seçilmedi';
  $('harnessRepoPath').textContent=ok?root:(DESKTOP?'Harness için repo klasörünü seç':'Ayarlar > Repo klasörü\'ne yolu yaz');
  $('harnessRepoPath').title=root;
}
async function saveRepo(value,noteEl){
  const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({repo_root:value})});
  const data=await res.json();
  if(!data.ok){
    if(noteEl)noteEl.textContent='';
    await sqAlert('Klasör kullanılamadı',esc(data.error||'bilinmeyen hata'));
    return false;
  }
  await loadConfig();
  if(noteEl)noteEl.textContent=value?'Bağlandı ✓ — dataset\'ler yenilendi.':'Bağlantı kaldırıldı — bağımsız kip.';
  return true;
}
async function pickRepo(noteEl){
  if(!DESKTOP)return;
  const dir=await DESKTOP.pickFolder('Harness içeren repo klasörünü seç (ör. marketing_mix)');
  if(dir)await saveRepo(dir,noteEl);
}
if(DESKTOP){$('cfgPick').style.display='';}
else{$('harnessPick').style.display='none';}
$('cfgPick').onclick=()=>pickRepo($('cfgNote'));
$('harnessPick').onclick=()=>pickRepo(null);
$('cfgClear').onclick=()=>saveRepo('',$('cfgNote'));

function updDesc(){
  const d=datasets.find(x=>x.name===$('dataset').value);
  $('datasetDesc').textContent=d?d.description:'';
  $('stTotal').textContent=d?d.count:'–';
}
$('dataset').addEventListener('change',updDesc);

/* ---------- nav ---------- */
const navs={proj:['nvProj','vProj','Projeler'],live:['nvLive','vLive','Canlı Test'],runs:['nvRuns','vRuns','Koşular'],thr:['nvThr','vThr','Threads'],comp:['nvComp','vComp','Karşılaştır'],mon:['nvMon','vMon','Monitoring'],data:['nvData','vData','Dataset\'ler'],set:['nvSet','vSettings','Ayarlar']};
let currentView='runs';
function go(name){
  currentView=name;
  for(const[k,[nv,v,label]]of Object.entries(navs)){
    $(nv).classList.toggle('active',k===name);
    $(v).classList.toggle('on',k===name);
    if(k===name)$('crumb').textContent=label;
  }
  placePanels();
  if(name==='runs')loadArchive();
  if(name==='thr')loadThreadsView();
  if(name==='comp')loadCompareView();
  if(name==='data')renderDatasetList();
  if(name==='mon')loadMonitor();
  if(name==='proj')loadProjects();
}
$('nvProj').onclick=()=>go('proj');$('nvLive').onclick=()=>go('live');$('nvRuns').onclick=()=>go('runs');$('nvThr').onclick=()=>go('thr');$('nvComp').onclick=()=>go('comp');$('nvMon').onclick=()=>go('mon');$('nvData').onclick=()=>go('data');$('nvSet').onclick=()=>go('set');

// trace+detail panellerini aktif görünümün workArea'sına taşı
function placePanels(){
  const host=(currentView==='live')?document.querySelector('#vLive .workArea')
    :(currentView==='comp')?document.querySelector('#vComp .workArea')
    :(currentView==='thr')?document.querySelector('#vThr .workArea')
    :document.querySelector('#vRuns .workArea');
  if(host){host.appendChild($('trace'));host.appendChild($('detail'));}
}

/* ---------- tablo üretimi ---------- */
const tagChips=(t,max=3)=>(t.tags||[]).slice(0,max).map(x=>`<span class="tag">${esc(x)}</span>`).join('');
function turnRow(t){
  const[s,label]=stateOf(t);
  return `<tr class="turn" data-i="${t.index}">
    <td style="width:34px">${stIcon(s)}</td>
    <td style="width:44px" class="idx">#${t.index}</td>
    <td style="width:170px"><span class="ellip" style="color:var(--muted)">${esc(t.category||'')}</span></td>
    <td><span class="ellip">${tagChips(t)}${esc(t.user||'')}</span></td>
    <td><span class="ellip" style="color:${s==='err'?'var(--err)':'var(--muted)'}">${esc(t.agent_text||label)}</span></td>
    <td style="width:56px" class="num">${t.duration_s??''}s</td>
    <td style="width:40px" class="num">${(t.tools||[]).length}</td></tr>`;
}
const tableHead=`<thead><tr><th></th><th>#</th><th>Kategori</th><th>Girdi</th><th>Çıktı</th><th>Süre</th><th>Tool</th></tr></thead>`;

/* ---------- KOŞULAR ---------- */
let projFilter='';
function setProjFilter(name){
  projFilter=name||'';
  $('runProjBadge').style.display=projFilter?'inline-flex':'none';
  $('runProjName').textContent=projFilter;
}
async function loadArchive(){
  const data=await (await fetch('/api/archive'+(projFilter?`?project=${encodeURIComponent(projFilter)}`:''))).json();
  archiveRuns=data.runs||[];
  $('runPicker').innerHTML=archiveRuns.map(r=>`<option value="${esc(r.id)}">${esc(r.dataset)} · ${esc(r.stamp)}</option>`).join('');
  if(archiveRuns.length){
    if(!currentRunId||!archiveRuns.some(r=>r.id===currentRunId))currentRunId=archiveRuns[0].id;
    $('runPicker').value=currentRunId;
    selectRun(currentRunId);
  }
}
$('runPicker').addEventListener('change',()=>selectRun($('runPicker').value));
$('runProjClear').onclick=()=>{setProjFilter('');loadArchive();};
async function selectRun(id){
  currentRunId=id;
  const run=await (await fetch(`/api/archive-run?id=${encodeURIComponent(id)}`)).json();
  currentTurns=run.turns||[];
  $('runCounts').innerHTML=Object.entries(run.counts||{}).map(([k,v])=>`<span class="cPill">${esc(k)} · ${v}</span>`).join('');
  // filtre seçeneklerini bu koşunun içeriğinden üret (seçim korunur)
  const tools=[...new Set(currentTurns.flatMap(t=>(t.tools||[]).map(x=>x.capability)))].sort();
  const tags=[...new Set(currentTurns.flatMap(t=>t.tags||[]))].sort();
  const keep=(sel,list)=>list.includes(sel)?sel:'';
  const toolSel=keep($('runFilterTool').value,tools),tagSel=keep($('runFilterTag').value,tags);
  $('runFilterTool').innerHTML='<option value="">Tool: tümü</option>'+tools.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');
  $('runFilterTool').value=toolSel;
  $('runFilterTag').innerHTML='<option value="">Tag: tümü</option>'+tags.map(x=>`<option value="${esc(x)}">${esc(x)}</option>`).join('');
  $('runFilterTag').value=tagSel;
  $('runFilterTag').style.display=tags.length?'inline-block':'none';
  renderRunsTable();
  closePanels();
}
function runFilters(){
  const q=($('runFilterText').value||'').toLowerCase().trim();
  const st=$('runFilterStatus').value,tool=$('runFilterTool').value,tag=$('runFilterTag').value;
  return currentTurns.filter(t=>{
    if(q&&!(String(t.user||'').toLowerCase().includes(q)||String(t.agent_text||'').toLowerCase().includes(q)
      ||String(t.category||'').toLowerCase().includes(q)))return false;
    if(st&&stateOf(t)[0]!==st)return false;
    if(tool&&!(t.tools||[]).some(x=>x.capability===tool))return false;
    if(tag&&!(t.tags||[]).includes(tag))return false;
    return true;
  });
}
function renderRunsTable(){
  const rows=runFilters();
  const filtered=rows.length!==currentTurns.length;
  $('runsTableWrap').innerHTML=(rows.length
    ?`<table>${tableHead}<tbody>${rows.map(turnRow).join('')}</tbody></table>`
    :'<div id="emptyMsg">Filtreye uyan tur yok.</div>')
    +(filtered?`<div style="padding:8px 14px;font-size:10.5px;color:var(--faint)">${rows.length}/${currentTurns.length} tur gösteriliyor (filtre aktif)</div>`:'');
  bindRows($('runsTableWrap'),currentRunId);
}
for(const id of['runFilterStatus','runFilterTool','runFilterTag'])$(id).addEventListener('change',renderRunsTable);
let runFilterTimer=null;
$('runFilterText').addEventListener('input',()=>{clearTimeout(runFilterTimer);runFilterTimer=setTimeout(renderRunsTable,180);});
function bindRows(wrap,runId){
  wrap.querySelectorAll('tr.turn').forEach(tr=>{
    tr.onclick=()=>{
      if(selRow)selRow.classList.remove('sel');
      selRow=tr;tr.classList.add('sel');
      openTrace(runId,Number(tr.dataset.i));
    };
  });
}

/* ---------- TRACE + DETAY ---------- */
let detailRun=null; // açık detayın ait olduğu koşu (skor kaydı için)
async function openTrace(runId,index){
  if(!runId)return;
  const res=await fetch(`/api/turn?id=${encodeURIComponent(runId)}&index=${index}`);
  if(!res.ok)return;
  detailRun=runId;
  detailData=await res.json();
  buildSpans();
  $('trace').classList.add('open');
  $('detail').classList.add('open');
  selectSpan(0);
}
function spanColor(type){
  const s=String(type);
  if(s==='root')return'var(--accent)';
  if(s.includes('error'))return'var(--err)';
  if(s.startsWith('tool'))return'var(--ok)';
  if(s.includes('assistant')||s.includes('model'))return'var(--teal)';
  if(s.includes('routed')||s.includes('capabilit')||s.includes('context'))return'var(--purple)';
  if(s==='done'||s.includes('completed'))return'var(--ok)';
  return'var(--gray)';
}
let spans=[];
function buildSpans(){
  const d=detailData;
  const evs=d.events||[];
  const times=evs.map(e=>Date.parse(e.at||'')).filter(t=>!isNaN(t));
  const t0=times.length?Math.min(...times):null;
  spans=[{kind:'root',name:`Tur #${d.index}`,dur:d.duration_s!=null?d.duration_s+'s':'',chips:[d.logical_thread||''].filter(Boolean)}];
  evs.forEach((e,i)=>{
    let name=e.type;let payloadObj=null;
    try{payloadObj=JSON.parse(e.payload);}catch{}
    if(payloadObj&&payloadObj.capability)name=payloadObj.capability;
    const et=Date.parse(e.at||'');
    const next=evs[i+1]?Date.parse(evs[i+1].at||''):NaN;
    const durMs=(!isNaN(et)&&!isNaN(next)&&next>=et)?(next-et):null;
    spans.push({kind:e.type,name,ev:e,payloadObj,
      rel:(t0!=null&&!isNaN(et))?((et-t0)/1000).toFixed(2)+'s':'',
      dur:durMs!=null?(durMs/1000).toFixed(2)+'s':'',
      chips:[`seq:${e.n}`],indent:String(e.type).startsWith('tool')||String(e.type).includes('capabilit')});
  });
  $('traceTot').textContent=`${d.duration_s??'?'}s · ${evs.length} event`;
  $('spanTree').innerHTML=spans.map((sp,i)=>{
    const color=spanColor(sp.kind);
    return `<div class="spanRow${sp.indent?' ind1':''}" data-si="${i}">
      <div class="l1"><span class="spanIcon" style="background:${color}"><svg viewBox="0 0 10 10"><rect x="2" y="2" width="6" height="6" rx="1.5"/></svg></span>
      <span class="spanName">${esc(sp.name)}</span></div>
      <div class="spanChips">${sp.dur?`<span class="sChip time">⏱ ${sp.dur}</span>`:''}${sp.rel?`<span class="sChip">+${sp.rel}</span>`:''}
        ${(sp.chips||[]).map(c=>`<span class="sChip">${esc(c)}</span>`).join('')}</div></div>`;
  }).join('');
  $('spanTree').querySelectorAll('.spanRow').forEach(el=>{
    el.onclick=()=>selectSpan(Number(el.dataset.si));
  });
}
function selectSpan(i){
  selSpan=i;
  $('spanTree').querySelectorAll('.spanRow').forEach((el,j)=>el.classList.toggle('sel',j===i));
  renderDetail(spans[i]);
}
function renderDetail(sp){
  const d=detailData;if(!d||!sp)return;
  const[s,label]=stateOf(d);
  $('dBadge').className=`pill p-${sp.kind==='root'?s:(String(sp.kind).includes('error')?'err':'gray')}`;
  $('dBadge').innerHTML=`<span class="d"></span>${sp.kind==='root'?esc(label):esc(sp.kind)}`;
  $('dTitle').textContent=sp.name;
  let main='';
  if(sp.kind==='root'){
    main=`${(d.tags||[]).length?`<div style="margin:0 0 10px">${d.tags.map(x=>`<span class="tag">${esc(x)}</span>`).join('')}</div>`:''}
      <div class="ioCard"><div class="ioHead">Girdi — kullanıcı mesajı</div><div class="ioBody">${esc(d.user||'')}</div></div>
      <div class="ioCard"><div class="ioHead">Çıktı — asistan cevabı</div><div class="ioBody">${esc(d.agent_text||'(yok)')}</div></div>
      ${d.metadata?`<div class="ioCard"><div class="ioHead">Metadata</div><div class="ioBody mono">${esc(JSON.stringify(d.metadata,null,2))}</div></div>`:''}
      ${(d.errors||[]).length?`<div class="blockTitle" style="font-size:11px;color:var(--err)">Hatalar (${d.errors.length})</div>`+
        d.errors.map(e=>`<div class="errbox"><code>${esc(e.code||e.type)}</code><br>${esc(e.message||'')}</div>`).join(''):''}
      ${(d.tools||[]).length?`<div class="ioCard"><div class="ioHead">Tool çağrıları (${d.tools.length})</div><div class="ioBody mono">${d.tools.map(t=>`${t.status==='success'||t.status==='completed'?'[ok] ':'[hata] '}${esc(t.capability)}${t.duration_ms?'  ·  '+(t.duration_ms/1000).toFixed(2)+'s':''}`).join('\n')}</div></div>`:''}
      ${scoreBlock(d)}`;
  }else{
    main=`<div class="ioCard"><div class="ioHead">Event payload</div><div class="ioBody mono">${esc(prettyPayload(sp))}</div></div>`;
  }
  $('dMain').innerHTML=main;
  if(sp.kind==='root')bindScoreForm();
}

/* ---------- skorlar (feedback) ---------- */
const scoreChips=(t)=>(t.scores||[]).map(sc=>
  `<span class="scoreChip">${esc(sc.key)}: ${Number(sc.value).toFixed(2)}${sc.source==='manual'?' ✎':''}</span>`).join('');
function scoreBlock(d){
  return `<div class="blockTitle" style="font-size:11px">Skorlar${(d.scores||[]).length?` (${d.scores.length})`:''}</div>
    ${(d.scores||[]).length?`<div style="margin-bottom:8px">${scoreChips(d)}</div>`:''}
    ${(d.scores||[]).some(sc=>sc.comment)?(d.scores.filter(sc=>sc.comment).map(sc=>
      `<div style="font-size:11px;color:var(--muted);margin-bottom:6px"><b>${esc(sc.key)}</b>: ${esc(sc.comment)}</div>`).join('')):''}
    <div class="scoreForm">
      <div class="row2">
        <div><label>Anahtar</label><input id="scKey" value="rating"></div>
        <div><label>Skor (0–1)</label><input id="scVal" type="number" min="0" max="1" step="0.05" value="1"></div>
      </div>
      <div style="margin-bottom:8px"><label>Yorum (ops.)</label><input id="scComment" placeholder="neden bu skor?"></div>
      <div style="display:flex;gap:8px;align-items:center">
        <button class="btnPrimary" style="width:auto;padding:6px 14px" id="scSave">Puanla</button>
        <span id="scNote" style="font-size:11px;color:var(--muted)"></span>
      </div>
    </div>`;
}
function bindScoreForm(){
  const btn=$('scSave');if(!btn)return;
  btn.onclick=async()=>{
    const res=await fetch('/api/score',{method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({run:detailRun,index:detailData.index,
        key:$('scKey').value.trim()||'rating',value:Number($('scVal').value),
        comment:$('scComment').value.trim()||undefined})});
    const d=await res.json();
    if(!d.ok){$('scNote').textContent=d.error;return;}
    await openTrace(detailRun,detailData.index); // skoru tazele
  };
}
function prettyPayload(sp){
  try{return JSON.stringify(sp.payloadObj??JSON.parse(sp.ev.payload),null,2);}catch{return sp.ev?.payload||'';}
}
function closePanels(){
  $('trace').classList.remove('open');$('detail').classList.remove('open');
  if(selRow){selRow.classList.remove('sel');selRow=null;}
}
$('detailClose').onclick=closePanels;

/* ---------- THREADS (konuşma görünümü) ---------- */
let thrData=[],thrSel=null;
async function loadThreadsView(){
  const data=await (await fetch('/api/monitor-threads')).json();
  thrData=data.threads||[];
  renderThreadList();
  if(thrSel&&thrData.some(t=>t.id===thrSel))openThread(thrSel);
}
function renderThreadList(){
  const q=($('thrSearch').value||'').toLowerCase();
  const rows=thrData.filter(t=>!q||String(t.id).toLowerCase().includes(q));
  $('thrList').innerHTML=rows.map(t=>`
    <div class="thrItem${t.id===thrSel?' sel':''}" data-t="${esc(t.id)}">
      <span class="tid">${esc(t.id)}</span>
      <span class="tmeta">${t.turns} tur · ${esc(t.dataset||'')}</span>
    </div>`).join('')||'<div style="color:var(--faint);font-size:11px;padding:8px">thread bulunamadı</div>';
  $('thrList').querySelectorAll('.thrItem').forEach(el=>{
    el.onclick=()=>openThread(el.dataset.t);
  });
}
$('thrSearch').addEventListener('input',renderThreadList);
async function openThread(id){
  thrSel=id;renderThreadList();
  const data=await (await fetch(`/api/thread?id=${encodeURIComponent(id)}`)).json();
  const turns=data.turns||[];
  $('thrTitle').textContent=id;
  $('thrSub').textContent=`${turns.length} tur`;
  let html='';let lastRun=null;
  for(const t of turns){
    if(t.run!==lastRun){
      lastRun=t.run;
      html+=`<div class="thrRunSep"><span>${esc(t.run)}</span></div>`;
    }
    const[s,label]=stateOf(t);
    html+=`<div class="bubbleRow user"><div class="bubble user">${esc(t.user||'')}</div></div>`;
    html+=`<div class="bubbleRow"><div class="bubble asst${s==='err'?' err':''}">${esc(t.agent_text||label)}
      <div class="bubbleMeta">${stIcon(s)}<span>#${t.index}</span>${t.duration_s!=null?`<span>${t.duration_s}s</span>`:''}
        ${(t.tools||[]).length?`<span>${t.tools.length} tool</span>`:''}
        ${scoreChips(t)}${tagChips(t,2)}
        <span class="lnk" data-run="${esc(t.run)}" data-i="${t.index}">izi aç</span></div></div></div>`;
  }
  $('thrChat').innerHTML=html||'<div id="emptyThr" style="margin:60px auto;text-align:center;color:var(--faint)">Bu thread için tur bulunamadı.</div>';
  $('thrChat').querySelectorAll('.lnk').forEach(el=>{
    el.onclick=()=>openTrace(el.dataset.run,Number(el.dataset.i));
  });
  $('thrChat').scrollTop=0;
}

/* ---------- KARŞILAŞTIR ---------- */
let cmpData=null;
async function loadCompareView(){
  const data=await (await fetch('/api/archive')).json();
  archiveRuns=data.runs||[];
  const opts=archiveRuns.map(r=>`<option value="${esc(r.id)}">${esc(r.dataset)} · ${esc(r.stamp.slice(0,19))}</option>`).join('');
  const keepA=$('cmpA').value,keepB=$('cmpB').value;
  $('cmpA').innerHTML=opts;$('cmpB').innerHTML=opts;
  if(archiveRuns.some(r=>r.id===keepA))$('cmpA').value=keepA;
  if(archiveRuns.some(r=>r.id===keepB))$('cmpB').value=keepB;
  else if(archiveRuns.length>1)$('cmpB').selectedIndex=1;
}
const dChip=(a,b,goodWhenUp,fmt=(x)=>x)=>{
  const diff=b-a;
  if(!diff)return '<span class="delta flat">±0</span>';
  const good=goodWhenUp?diff>0:diff<0;
  return `<span class="delta ${good?'up':'down'}">${diff>0?'+':''}${fmt(diff)}</span>`;
};
function cmpCard(label,va,vb,chip){
  return `<div class="cmpCard"><div class="cLbl">${label}</div>
    <div class="cVal"><span>${va}</span><span class="arrow">→</span><span>${vb}</span>${chip}</div></div>`;
}
function cmpSideCell(side,runId,index){
  if(!side)return '<td class="cmpCell"><span style="color:var(--faint);font-size:11px">— yok —</span></td>';
  const s=side.ok?'ok':(side.status==='blocked'?'warn':'err');
  return `<td class="cmpCell" data-run="${esc(runId)}" data-i="${index}">
    <span style="display:flex;align-items:flex-start;gap:7px;min-width:0">${stIcon(s)}
      <span style="min-width:0"><span class="ellip">${esc(side.output||side.status||'')}</span>
        <span class="cmpMeta">${side.duration_s}s · ${side.tools.length} tool${side.tokens?` · ${fmtNum(side.tokens)} tok`:''}${side.error_codes.length?` · <span style="color:var(--err)">${esc(side.error_codes[0])}</span>`:''}</span>
      </span></span></td>`;
}
function renderCompare(){
  if(!cmpData)return;
  const {a,b,items}=cmpData;
  const onlyDiff=$('cmpOnlyDiff').checked;
  const list=onlyDiff?items.filter(it=>it.changed||!it.a||!it.b):items;
  const cards=`<div class="cmpCards">${
    cmpCard('Başarı',a.totals.success_rate+'%',b.totals.success_rate+'%',dChip(a.totals.success_rate,b.totals.success_rate,true,(x)=>x+' puan'))}${
    cmpCard('Ort. süre',a.totals.avg_s+'s',b.totals.avg_s+'s',dChip(a.totals.avg_s,b.totals.avg_s,false,(x)=>x+'s'))}${
    cmpCard('Token (≈)',fmtNum(a.totals.tokens),fmtNum(b.totals.tokens),dChip(a.totals.tokens,b.totals.tokens,false,fmtNum))}${
    cmpCard('Tool çağrısı',a.totals.tool_calls,b.totals.tool_calls,dChip(a.totals.tool_calls,b.totals.tool_calls,false,(x)=>String(x)))}</div>`;
  const rows=list.map(it=>`<tr class="turn${it.changed?' cmpDiff':''}">
    <td style="width:44px" class="idx">#${it.index}</td>
    <td style="width:24%"><span class="ellip" style="color:var(--muted)">${esc(it.input||'')}</span></td>
    ${cmpSideCell(it.a,a.id,it.index)}${cmpSideCell(it.b,b.id,it.index)}</tr>`).join('');
  $('cmpWrap').innerHTML=cards+
    `<div style="padding:0 18px 8px;font-size:10.5px;color:var(--faint)">${list.length}/${items.length} madde${onlyDiff?' (sadece farklılar)':''} — hücreye tıklayınca o koşunun izi açılır</div>`+
    `<table><thead><tr><th>#</th><th>Girdi</th><th>A · ${esc(a.id)}</th><th>B · ${esc(b.id)}</th></tr></thead><tbody>${rows}</tbody></table>`;
  $('cmpWrap').querySelectorAll('td.cmpCell[data-run]').forEach(td=>{
    td.onclick=()=>openTrace(td.dataset.run,Number(td.dataset.i));
  });
}
$('cmpGo').onclick=async()=>{
  const idA=$('cmpA').value,idB=$('cmpB').value;
  if(!idA||!idB)return;
  $('cmpWrap').innerHTML='<div id="emptyMsg">Karşılaştırılıyor…</div>';
  const res=await fetch(`/api/compare?a=${encodeURIComponent(idA)}&b=${encodeURIComponent(idB)}`);
  if(!res.ok){$('cmpWrap').innerHTML='<div id="emptyMsg" style="color:var(--err)">Karşılaştırma başarısız — koşular okunamadı.</div>';return;}
  cmpData=await res.json();
  renderCompare();
};
$('cmpOnlyDiff').addEventListener('change',renderCompare);

/* ---------- CANLI ---------- */
function ensureLiveTable(){
  if(!document.getElementById('liveTbody')){
    $('liveTableWrap').innerHTML=`<table>${tableHead}<tbody id="liveTbody"></tbody></table>`;
  }
  return document.getElementById('liveTbody');
}
function liveRowStart(d){
  const e=$('emptyLive');if(e)e.remove();
  const tb=ensureLiveTable();
  const tr=document.createElement('tr');tr.className='turn';tr.dataset.i=d.index;
  tr.innerHTML=`<td style="width:34px"><span class="stIcon" style="background:var(--card2)"><svg viewBox="0 0 24 24" style="width:9px;height:9px;fill:none;stroke:var(--muted);stroke-width:3;stroke-linecap:round"><path d="M12 6v6l4 2"/></svg></span></td>
    <td style="width:44px" class="idx">#${d.index}</td>
    <td style="width:170px"><span class="ellip" style="color:var(--muted)">${esc(d.category||'')}</span></td>
    <td><span class="ellip">${esc(d.user||'')}</span></td>
    <td><span class="ellip" style="color:var(--faint)">yanıt bekleniyor…</span></td>
    <td style="width:56px" class="num"></td><td style="width:40px" class="num"></td>`;
  tr.onclick=()=>{if(selRow)selRow.classList.remove('sel');selRow=tr;tr.classList.add('sel');openTrace(liveRunId,d.index);};
  tb.appendChild(tr);
  liveTurns.set(d.index,tr);
  tr.scrollIntoView({block:'nearest'});
}
function liveRowResult(r){
  let tr=liveTurns.get(r.index);
  if(!tr){liveRowStart({index:r.index,category:r.category,user:r.user});tr=liveTurns.get(r.index);}
  const tmp=document.createElement('tbody');tmp.innerHTML=turnRow(r);
  const fresh=tmp.firstElementChild;
  fresh.onclick=()=>{if(selRow)selRow.classList.remove('sel');selRow=fresh;fresh.classList.add('sel');openTrace(liveRunId,r.index);};
  tr.replaceWith(fresh);liveTurns.set(r.index,fresh);
  done+=1;$('stDone').textContent=done;
  $('progressBar').style.width=total?`${Math.round(100*done/total)}%`:'0%';
  const[s]=stateOf(r);
  if(s!=='ok'){errs+=1;$('stErr').textContent=errs;}
  $('liveSub').textContent=`${done}/${total} tamamlandı`;
}

/* ---------- SSE ---------- */
const es=new EventSource('/api/stream');
es.addEventListener('run_started',(e)=>{
  const d=JSON.parse(e.data);
  done=0;errs=0;total=d.total||0;liveTurns=new Map();liveRunId=null;
  $('stDone').textContent='0';$('stErr').textContent='0';$('exportBox').style.display='none';
  $('liveTableWrap').innerHTML='';ensureLiveTable();
  go('live');
  $('liveSub').textContent=`${d.dataset} koşusu başladı`;
  $('livePill').style.display='inline-flex';
  $('btnStart').disabled=true;$('btnStop').style.display='block';
});
es.addEventListener('run_meta',(e)=>{liveRunId=JSON.parse(e.data).run_id||null;});
es.addEventListener('item_started',(e)=>liveRowStart(JSON.parse(e.data)));
es.addEventListener('item_result',(e)=>liveRowResult(JSON.parse(e.data)));
es.addEventListener('run_finished',(e)=>{
  const d=JSON.parse(e.data);
  $('livePill').style.display='none';$('progressBar').style.width='0%';
  $('btnStart').disabled=false;$('btnStop').style.display='none';
  if(d.export_path){$('exportBox').style.display='block';$('exportPath').textContent=d.export_path;}
  if((d.error_tail||[]).length){
    $('liveSub').innerHTML='<span style="color:var(--err);font-weight:700">koşu hata ile durdu</span>';
    const wrap=$('liveTableWrap');
    const box=document.createElement('div');
    box.style.cssText='margin:14px;padding:12px 14px;background:var(--errbg);border:1px solid rgba(239,103,103,.4);border-radius:10px;font:10.5px/1.6 var(--mono);color:#f0b6b6;white-space:pre-wrap;word-break:break-all';
    box.textContent='Koşu beklenmedik şekilde durdu. Son çıktı:\n\n'+d.error_tail.join('\n');
    wrap.appendChild(box);box.scrollIntoView({block:'nearest'});
    const logs=$('logs');logs.style.display='block';
    $('logtoggle').textContent='▾ teknik log';
  }else{
    $('liveSub').textContent=`koşu bitti · ${d.total} madde`;
  }
});
let ingestTimer=null;
es.addEventListener('ingest',(e)=>{
  const d=JSON.parse(e.data);
  clearTimeout(ingestTimer);
  ingestTimer=setTimeout(async()=>{
    if(currentView==='runs'){
      const has=[...$('runPicker').options].some(o=>o.value===d.run);
      if(!has){await loadArchive();}
      if(currentRunId===d.run){selectRun(currentRunId);}
    }else if(currentView==='mon'){loadMonitor();}
    else if(currentView==='proj'){loadProjects();}
  },700);
});
es.addEventListener('score',(e)=>{
  const d=JSON.parse(e.data);
  // başka bir pencereden puanlama geldiyse açık detayı tazele
  if(detailData&&detailRun===d.run&&Number(detailData.index)===Number(d.index))openTrace(d.run,d.index);
});
es.addEventListener('log',(e)=>{
  const box=$('logs');const line=document.createElement('div');line.textContent=JSON.parse(e.data).line;
  box.appendChild(line);if(box.children.length>500)box.removeChild(box.firstChild);box.scrollTop=box.scrollHeight;
});
$('logtoggle').onclick=()=>{
  const box=$('logs');const open=box.style.display==='block';
  box.style.display=open?'none':'block';
  $('logtoggle').textContent=(open?'▸':'▾')+' teknik log';
};

/* ---------- kontroller ---------- */
/* Kimlik doğrulama panelleri: seçilen tipe göre ilgili alanlar görünür. */
const AUTH_PANES={none:null,api_key:'apApiKey',bearer:'apBearer',cookie:'apCookie',basic:'apBasic',header:'apHeader',refresh:'apRefresh'};
function showAuthPane(){
  const type=$('genAuthType').value;
  for(const id of Object.values(AUTH_PANES)){if(id)$(id).style.display='none';}
  const pane=AUTH_PANES[type];
  if(pane)$(pane).style.display=pane==='apRefresh'?'flex':'block';
}
$('genAuthType').addEventListener('change',showAuthPane);
function buildAuth(){
  const type=$('genAuthType').value;
  switch(type){
    case 'api_key':return{type,header:$('genKeyHeader').value.trim()||'x-api-key',value:$('genKeyValue').value.trim()};
    case 'bearer':return{type,value:$('genBearer').value.trim()};
    case 'cookie':return{type,cookie_name:$('genCookieName').value.trim()||'session_id',value:$('genCookieValue').value.trim()};
    case 'basic':return{type,username:$('genBasicUser').value.trim(),password:$('genBasicPass').value};
    case 'header':return{type,header:$('genAuthH').value.trim()||'Authorization',value:$('genAuthV').value.trim()};
    case 'refresh':return{type,token_url:$('genTokUrl').value.trim(),refresh_token:$('genRefTok').value.trim(),
      token_field:$('genRefField').value.trim()||'refresh_token',access_path:$('genAccPath').value.trim()||'access_token'};
    default:return{type:'none'};
  }
}
function initGenericForm(){
  $('genProject').innerHTML=projects.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  try{
    const saved=JSON.parse(localStorage.getItem('sq_generic')||'{}');
    if(saved.url)$('genUrl').value=saved.url;
    if(saved.auth_type)$('genAuthType').value=saved.auth_type;
    if(saved.key_header)$('genKeyHeader').value=saved.key_header;
    if(saved.cookie_name)$('genCookieName').value=saved.cookie_name;
    if(saved.auth_header)$('genAuthH').value=saved.auth_header;
    if(saved.token_url)$('genTokUrl').value=saved.token_url;
    if(saved.token_field)$('genRefField').value=saved.token_field;
    if(saved.access_path)$('genAccPath').value=saved.access_path;
    if(saved.message_field)$('genMsgField').value=saved.message_field;
    if(saved.thread_field)$('genThreadField').value=saved.thread_field;
    if(saved.reply_path)$('genReplyPath').value=saved.reply_path;
    if(saved.headers)$('genHeaders').value=saved.headers;
    if(saved.body_extra)$('genBodyExtra').value=saved.body_extra;
  }catch{}
  showAuthPane();
}
$('engine').addEventListener('change',()=>{
  const generic=$('engine').value==='generic';
  $('harnessFields').style.display=generic?'none':'flex';
  $('genericFields').style.display=generic?'flex':'none';
  if(generic)initGenericForm();
});
$('btnStart').onclick=async()=>{
  if($('engine').value==='generic'){
    const auth=buildAuth();
    const endpoint={
      url:$('genUrl').value.trim(),
      auth,
      message_field:$('genMsgField').value.trim()||'message',
      thread_field:$('genThreadField').value.trim(),
      reply_path:$('genReplyPath').value.trim(),
      timeout_s:Number($('genTimeout').value)||120,
      headers:$('genHeaders').value,
      body_extra:$('genBodyExtra').value.trim()||undefined,
    };
    // Gizli değerler (token/şifre/anahtar) localStorage'a yazılmaz.
    try{localStorage.setItem('sq_generic',JSON.stringify({
      url:endpoint.url,auth_type:auth.type,key_header:auth.header,cookie_name:auth.cookie_name,
      auth_header:$('genAuthH').value.trim(),token_url:auth.token_url,token_field:auth.token_field,
      access_path:auth.access_path,message_field:endpoint.message_field,thread_field:endpoint.thread_field,
      reply_path:endpoint.reply_path,headers:endpoint.headers,body_extra:$('genBodyExtra').value.trim(),
    }));}catch{}
    const res=await fetch('/api/run-generic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
      dataset:$('dataset').value,from:Number($('from').value)||null,to:Number($('to').value)||null,
      project:$('genProject').value||'generic',endpoint,
    })});
    const data=await res.json();
    if(!data.ok)sqAlert('Başlatılamadı',esc(data.error||'bilinmeyen hata'));
    return;
  }
  const token=$('token').value.trim();
  try{localStorage.setItem('mmx_sid',token);}catch{}
  const res=await fetch('/api/run',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({
    dataset:$('dataset').value,from:Number($('from').value)||null,to:Number($('to').value)||null,
    multi_thread:$('multiThread').checked,thread:$('thread').value.trim()||null,
    base:$('base').value.trim()||null,refresh_token:token,
  })});
  const data=await res.json();
  if(!data.ok)sqAlert('Başlatılamadı',esc(data.error||'bilinmeyen hata'));
};
$('btnStop').onclick=()=>fetch('/api/stop',{method:'POST'});
$('cfgSave').onclick=()=>saveRepo($('cfgRepo').value.trim(),$('cfgNote'));

/* ---------- DATASET'LER ---------- */
let dsCurrent=null;
function renderDatasetList(){
  $('dsDetail').style.display='none';$('dsCreate').style.display='none';
  $('dsListWrap').style.display='block';$('dsListHead').style.display='flex';
  const q=($('dsSearch').value||'').toLowerCase();
  const rows=datasets.filter(d=>!q||d.name.toLowerCase().includes(q)||String(d.description||'').toLowerCase().includes(q))
    .map(d=>`<tr class="turn" data-ds="${esc(d.name)}">
      <td style="width:180px"><b>${esc(d.name)}</b></td>
      <td><span class="ellip" style="color:var(--muted)">${esc(d.description||'')}</span></td>
      <td style="width:70px" class="num">${d.count}</td>
      <td style="width:70px" class="num">${d.attachments} ek</td>
      <td style="width:44px"><button class="pjIconBtn danger dsKill" data-ds="${esc(d.name)}" title="seti sil">${ICON_TRASH}</button></td></tr>`).join('');
  $('dsListWrap').innerHTML=`<table><thead><tr><th>Ad</th><th>Açıklama</th><th>Madde</th><th>Ek</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('dsListWrap').querySelectorAll('tr.turn').forEach(tr=>{tr.onclick=()=>openDataset(tr.dataset.ds);});
  $('dsListWrap').querySelectorAll('.dsKill').forEach(btn=>{
    btn.onclick=(ev)=>{ev.stopPropagation();deleteDatasetUI(btn.dataset.ds);};
  });
}
$('dsSearch').addEventListener('input',renderDatasetList);
// --- olusturma sayfasi ---
let dcItems=[];let dcMode='file';
const SAMPLE_CSV='prompt,category,thread\n"Google Ads hesabımın durumunu özetler misin?","Google Ads","thread_ads"\n"Bir landing page yapar mısın?","Web","thread_web"';
const SAMPLE_JSON='{"prompt":"Google Ads hesabımın durumunu özetler misin?","category":"Google Ads","thread":"thread_ads"}\n{"prompt":"Bir landing page yapar mısın?","category":"Web","thread":"thread_web"}';
function showCreate(){
  $('dsListWrap').style.display='none';$('dsListHead').style.display='none';$('dsDetail').style.display='none';
  $('dsCreate').style.display='flex';dcItems=[];$('dcPreview').style.display='none';$('dcPreview').innerHTML='';
  $('dcSample').textContent=SAMPLE_CSV;
}
$('dsNewBtn').onclick=showCreate;
$('dsCreateCancel').onclick=()=>{$('dsCreate').style.display='none';renderDatasetList();};
$('dcTabFile').onclick=()=>{dcMode='file';$('dcTabFile').classList.add('on');$('dcTabScratch').classList.remove('on');
  $('dcFilePane').style.display='block';$('dcScratchPane').style.display='none';};
$('dcTabScratch').onclick=()=>{dcMode='scratch';$('dcTabScratch').classList.add('on');$('dcTabFile').classList.remove('on');
  $('dcFilePane').style.display='none';$('dcScratchPane').style.display='block';};
$('dcFmtCsv').onclick=()=>{$('dcFmtCsv').classList.add('on');$('dcFmtJson').classList.remove('on');$('dcSample').textContent=SAMPLE_CSV;};
$('dcFmtJson').onclick=()=>{$('dcFmtJson').classList.add('on');$('dcFmtCsv').classList.remove('on');$('dcSample').textContent=SAMPLE_JSON;};

function parseCsv(text){
  const rows=[];let row=[],cell='',inQ=false;
  for(let i=0;i<text.length;i++){
    const c=text[i];
    if(inQ){ if(c==='"'){ if(text[i+1]==='"'){cell+='"';i++;} else inQ=false; } else cell+=c; }
    else if(c==='"')inQ=true;
    else if(c===','){row.push(cell);cell='';}
    else if(c==='\n'||c==='\r'){ if(c==='\r'&&text[i+1]==='\n')i++; row.push(cell);cell=''; if(row.some(x=>x.trim()!==''))rows.push(row); row=[]; }
    else cell+=c;
  }
  if(cell!==''||row.length){row.push(cell);if(row.some(x=>x.trim()!==''))rows.push(row);}
  return rows;
}
function keyOf(headers,names){
  const lower=headers.map(x=>String(x).trim().toLowerCase());
  for(const n of names){const i=lower.indexOf(n);if(i>=0)return i;}
  return -1;
}
function normalizeEntry(o){
  const prompt=o.prompt??o.input??o.mesaj??o.message??o.text??o['input 1'];
  if(!prompt||!String(prompt).trim())return null;
  return {prompt:String(prompt),category:o.category??o.kategori??'',thread:o.thread??o.conversation_thread_id??'',dep:o.dep??o.context_dependency??null};
}
function parseFile(name,text){
  const items=[];
  if(/\.csv$/i.test(name)){
    const rows=parseCsv(text);
    if(rows.length<2)throw new Error('CSV en az başlık + 1 satır içermeli.');
    const H=rows[0];
    const pi=keyOf(H,['prompt','input','mesaj','message','text','input 1']);
    if(pi<0)throw new Error("CSV'de 'prompt' (veya input/mesaj) kolonu bulunamadı.");
    const ci=keyOf(H,['category','kategori']),ti=keyOf(H,['thread','conversation_thread_id']),di=keyOf(H,['dep','context_dependency']);
    for(const r of rows.slice(1)){
      const e=normalizeEntry({prompt:r[pi],category:ci>=0?r[ci]:'',thread:ti>=0?r[ti]:'',dep:di>=0?r[di]:null});
      if(e)items.push(e);
    }
  }else{
    let parsed=null;
    try{parsed=JSON.parse(text);}catch{}
    if(Array.isArray(parsed)){ for(const o of parsed){const e=normalizeEntry(o||{});if(e)items.push(e);} }
    else{
      for(const line of text.split('\n')){
        const t=line.trim();if(!t)continue;
        try{const e=normalizeEntry(JSON.parse(t));if(e)items.push(e);}catch{}
      }
    }
  }
  if(!items.length)throw new Error('Dosyadan hiç madde çıkarılamadı — kolon adlarını kontrol et.');
  return items;
}
function showPreview(fileName){
  const p=$('dcPreview');p.style.display='block';
  const head=dcItems.slice(0,3).map((e,i)=>`<tr><td class="idx" style="width:40px">#${i+1}</td><td><span class="ellip">${esc(e.prompt)}</span></td><td style="width:140px"><span class="ellip" style="color:var(--muted)">${esc(e.category||'')}</span></td></tr>`).join('');
  p.innerHTML=`<div style="background:var(--okbg);border:1px solid rgba(47,191,130,.35);border-radius:10px;padding:10px 13px;font-size:12px;margin-bottom:10px">
    <b style="color:var(--ok)">${esc(fileName)}</b> — <b>${dcItems.length} madde</b> algılandı. Sağ üstten <b>Oluştur</b>'a bas.</div>
    <table><thead><tr><th>#</th><th>Mesaj (ilk 3)</th><th>Kategori</th></tr></thead><tbody>${head}</tbody></table>`;
}
async function handleFile(file){
  const text=await file.text();
  try{ dcItems=parseFile(file.name,text); if(!$('dcName').value.trim())$('dcName').value=file.name.replace(/\.(csv|jsonl?|txt)$/i,'').toLowerCase().replace(/[^a-z0-9-_]+/g,'-'); showPreview(file.name); }
  catch(err){ dcItems=[]; const p=$('dcPreview');p.style.display='block';
    p.innerHTML=`<div style="background:var(--errbg);border:1px solid rgba(239,103,103,.4);border-radius:10px;padding:10px 13px;font-size:12px;color:#f0b6b6">${esc(err.message)}</div>`; }
}
$('dcDrop').onclick=()=>$('dcFileInput').click();
$('dcFileInput').addEventListener('change',(e)=>{if(e.target.files[0])handleFile(e.target.files[0]);});
$('dcDrop').addEventListener('dragover',(e)=>{e.preventDefault();$('dcDrop').classList.add('drag');});
$('dcDrop').addEventListener('dragleave',()=>$('dcDrop').classList.remove('drag'));
$('dcDrop').addEventListener('drop',(e)=>{e.preventDefault();$('dcDrop').classList.remove('drag');
  if(e.dataTransfer.files[0])handleFile(e.dataTransfer.files[0]);});
$('dsCreateSave').onclick=async()=>{
  const name=$('dcName').value.trim();
  if(!name){sqAlert('Eksik bilgi','Set adı gerekli.');return;}
  if(dcMode==='file'&&!dcItems.length){sqAlert('Eksik bilgi','Önce bir dosya yükle (ya da &quot;Sıfırdan oluştur&quot; sekmesini kullan).');return;}
  const res=await fetch('/api/dataset-create',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name,description:$('dcDesc').value.trim(),items:dcMode==='file'?dcItems:[]})});
  const data=await res.json();
  if(!data.ok){sqAlert('Olmadı',esc(data.error||''));return;}
  $('dsCreate').style.display='none';
  await loadConfig();renderDatasetList();openDataset(data.name);
};
async function openDataset(name){
  dsCurrent=name;
  const data=await (await fetch(`/api/dataset-items?name=${encodeURIComponent(name)}`)).json();
  const items=data.items||[];
  $('dsListWrap').style.display='none';$('dsListHead').style.display='none';$('dsAddForm').style.display='none';
  $('dsDetail').style.display='flex';
  $('dsDetailName').textContent=name;
  $('dsDetailSub').textContent=`${items.length} madde`;
  const rows=items.map(t=>`<tr class="turn">
    <td style="width:44px" class="idx">#${t.index}</td>
    <td style="width:180px"><span class="ellip" style="color:var(--faint);font:10.5px var(--mono)">${esc(t.thread||'')}</span></td>
    <td style="width:170px"><span class="ellip" style="color:var(--muted)">${esc(t.category||'')}</span></td>
    <td><span class="ellip">${esc(t.prompt||'')}</span></td>
    <td style="width:56px" class="num">${t.attachments&&t.attachments.length?t.attachments.length+' ek':''}</td>
    <td style="width:64px;white-space:nowrap">
      <span style="display:inline-flex;gap:5px"><button class="pjIconBtn dsEdit" data-id="${t.index}" title="düzenle"><svg viewBox="0 0 24 24"><path d="M17 3l4 4L8 20H4v-4L17 3z"/></svg></button><button class="pjIconBtn danger dsDel" data-id="${t.index}" title="sil">${ICON_TRASH}</button></span></td></tr>`).join('');
  $('dsItemsWrap').innerHTML=`<table><thead><tr><th>#</th><th>Thread</th><th>Kategori</th><th>Mesaj</th><th>Ek</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
  $('dsItemsWrap').querySelectorAll('.dsEdit').forEach(btn=>{
    btn.onclick=(ev)=>{
      ev.stopPropagation();
      const it=items.find(x=>Number(x.index)===Number(btn.dataset.id));
      if(it)openItemForm(it);
    };
  });
  $('dsItemsWrap').querySelectorAll('.dsDel').forEach(btn=>{
    btn.onclick=async(ev)=>{
      ev.stopPropagation();
      if(!await sqConfirm({title:`Maddeyi sil`,html:`<b>#${esc(btn.dataset.id)}</b> maddesi silinecek; kalan maddeler yeniden numaralanır.`,warn:'Bu işlem <b>geri alınamaz</b>.',confirmText:'Sil',danger:true}))return;
      const res=await fetch('/api/dataset-item-delete',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({dataset:dsCurrent,id:Number(btn.dataset.id)})});
      const d=await res.json();
      if(!d.ok){sqAlert('Olmadı',esc(d.error||''));return;}
      await loadConfig();openDataset(dsCurrent);
    };
  });
}
async function deleteDatasetUI(name){
  if(!await sqConfirm({title:`'${name}' setini sil`,html:`<b>${esc(name)}</b> seti tüm maddeleriyle birlikte kalıcı olarak silinecek.`,warn:'Bu işlem <b>geri alınamaz</b> — silinen maddeler geri getirilemez.',confirmText:'Kalıcı olarak sil',danger:true}))return;
  const res=await fetch('/api/dataset-delete',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name})});
  const d=await res.json();
  if(!d.ok){sqAlert('Olmadı',esc(d.error||''));return;}
  await loadConfig();renderDatasetList();
}
$('dsDelBtn').onclick=()=>deleteDatasetUI(dsCurrent);
let dsEditId=null;
function openItemForm(item){
  const f=$('dsAddForm');f.style.display='block';
  dsEditId=item?item.index:null;
  $('dsFormTitle').textContent=item?`Madde #${item.index} düzenleniyor`:'Yeni madde';
  $('dsAddSave').textContent=item?'Kaydet':'Ekle';
  $('dsAddPrompt').value=item?item.prompt:'';
  $('dsAddCat').value=item?(item.category||''):'';
  $('dsAddThread').value=item?(item.thread||''):'';
  $('dsAddDep').value='';
  $('dsAddNote').textContent='';
  $('dsAddPrompt').focus();
}
$('dsBack').onclick=()=>renderDatasetList();
$('dsAddBtn').onclick=()=>{const f=$('dsAddForm');if(f.style.display==='block'&&dsEditId===null){f.style.display='none';}else{openItemForm(null);}};
$('dsAddSave').onclick=async()=>{
  const payload={dataset:dsCurrent,prompt:$('dsAddPrompt').value,category:$('dsAddCat').value,
    thread:$('dsAddThread').value,dep:$('dsAddDep').value||null};
  const endpoint=dsEditId?'/api/dataset-item-update':'/api/dataset-item-add';
  if(dsEditId)payload.id=dsEditId;
  const res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify(payload)});
  const d=await res.json();
  if(!d.ok){$('dsAddNote').textContent=d.error;return;}
  $('dsAddNote').textContent=dsEditId?`#${dsEditId} güncellendi.`:`#${d.item.id} eklendi.`;
  dsEditId=null;$('dsAddPrompt').value='';$('dsAddForm').style.display='none';
  await loadConfig();openDataset(dsCurrent);
};
$('dsRunBtn').onclick=()=>{ $('dataset').value=dsCurrent;updateDescSafe();go('live'); };
function updateDescSafe(){ try{updDesc();}catch{} }

/* ---------- MONITORING ---------- */
const MC={ok:'#4f79ff',bad:'#e05555',tok_in:'#4f79ff',tok_out:'#199e70',lat:'#199e70'}; // dogrulanmis palet (koyu yuzey)
function fmtNum(n){ if(n>=1e6)return (n/1e6).toFixed(1)+'M'; if(n>=1e3)return (n/1e3).toFixed(1)+'k'; return String(n); }
function monTipShow(ev,html){const t=$('monTip');t.innerHTML=html;t.style.display='block';
  t.style.left=(ev.clientX+14)+'px';t.style.top=(ev.clientY+10)+'px';}
function monTipHide(){$('monTip').style.display='none';}

function barChart({title,runs,series,legend}){
  // series: [{key,label,color,val:(r)=>n}] — stacked
  const W=940,H=190,padL=44,padB=34,padT=10,plotW=W-padL-8,plotH=H-padT-padB;
  const n=runs.length||1;
  const totals=runs.map(r=>series.reduce((a,s)=>a+s.val(r),0));
  const max=Math.max(1,...totals);
  const step=plotW/n, bw=Math.max(6,Math.min(34,step-8));
  const ticks=[0,.5,1].map(f=>Math.round(max*f));
  let svg=`<svg viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;display:block">`;
  for(const t of ticks){
    const y=padT+plotH-(t/max)*plotH;
    svg+=`<line x1="${padL}" y1="${y}" x2="${W-8}" y2="${y}" stroke="var(--line)" stroke-width="1"/>`;
    svg+=`<text x="${padL-6}" y="${y+3}" text-anchor="end" font-size="9.5" fill="var(--faint)" font-family="var(--mono)">${fmtNum(t)}</text>`;
  }
  const maxIdx=totals.indexOf(Math.max(...totals));
  runs.forEach((r,i)=>{
    const x=padL+i*step+(step-bw)/2;
    let y=padT+plotH;
    const parts=series.map(s=>`${s.label}: <b>${fmtNum(s.val(r))}</b>`).join(' · ');
    const tip=`<b>${r.dataset}</b> ${r.stamp.slice(0,16)}<br>${parts}`;
    series.forEach((s,si)=>{
      const v=s.val(r); if(v<=0)return;
      const hgt=Math.max(2,(v/max)*plotH-(si>0?2:0));
      y-=hgt;
      const topSeg=si===series.length-1||series.slice(si+1).every(z=>z.val(r)<=0);
      const rx=topSeg?3:0;
      svg+=`<rect class="mBar" data-tip="${tip.replace(/"/g,'&quot;')}" x="${x}" y="${y}" width="${bw}" height="${hgt}" rx="${rx}" fill="${s.color}"/>`;
      y-=si>0?0:2;
    });
    if(i===maxIdx&&totals[i]>0)
      svg+=`<text x="${x+bw/2}" y="${padT+plotH-(totals[i]/max)*plotH-5}" text-anchor="middle" font-size="9.5" fill="var(--muted)" font-family="var(--mono)">${fmtNum(totals[i])}</text>`;
    const lbl=(r.stamp||'').slice(5,16).replace('T',' ');
    if(n<=14||i%2===0)
      svg+=`<text x="${x+bw/2}" y="${H-18}" text-anchor="middle" font-size="8.5" fill="var(--faint)" font-family="var(--mono)" transform="rotate(0)">${lbl}</text>`;
    svg+=`<text x="${x+bw/2}" y="${H-7}" text-anchor="middle" font-size="8.5" fill="var(--faint)">${r.dataset.slice(0,10)}</text>`;
  });
  svg+='</svg>';
  const leg=legend?`<div style="display:flex;gap:14px;margin:2px 0 6px">${series.map(s=>
    `<span style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--muted)"><span style="width:9px;height:9px;border-radius:3px;background:${s.color}"></span>${s.label}</span>`).join('')}</div>`:'';
  const tableRows=runs.map(r=>`<tr><td>${esc(r.dataset)}</td><td style="font-family:var(--mono);font-size:10px">${esc(r.stamp)}</td>${series.map(s=>`<td class="num">${fmtNum(s.val(r))}</td>`).join('')}</tr>`).join('');
  return `<div style="background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px">
    <div style="font-size:12.5px;font-weight:700;margin-bottom:4px">${title}</div>${leg}${svg}
    <details style="margin-top:6px"><summary style="font-size:10.5px;color:var(--faint);cursor:pointer">tablo görünümü</summary>
    <table style="margin-top:8px"><thead><tr><th>Set</th><th>Koşu</th>${series.map(s=>`<th style="text-align:right">${s.label}</th>`).join('')}</tr></thead><tbody>${tableRows}</tbody></table></details></div>`;
}

let monThreads=[];let monSelected=new Set();
async function loadThreadList(){
  const data=await (await fetch('/api/monitor-threads')).json();
  monThreads=data.threads||[];
  $('monThreadList').innerHTML=monThreads.map(t=>`
    <label style="display:flex;align-items:center;gap:8px;padding:4px 6px;border-radius:6px;cursor:pointer;font-size:11.5px">
      <input type="checkbox" class="monThreadCk" value="${esc(t.id)}" ${monSelected.has(t.id)?'checked':''} style="width:auto;accent-color:var(--accent)">
      <span class="ellip" style="flex:1;font-family:var(--mono);font-size:10.5px">${esc(t.id)}</span>
      <span style="color:var(--faint);font-size:10px">${t.turns} tur</span></label>`).join('')
    ||'<div style="color:var(--faint);font-size:11px;padding:6px">thread bulunamadı</div>';
  document.querySelectorAll('.monThreadCk').forEach(ck=>{
    ck.addEventListener('change',()=>{
      if(ck.checked)monSelected.add(ck.value);else monSelected.delete(ck.value);
      $('monThreadCount').textContent=monSelected.size?`(${monSelected.size})`:'';
      loadMonitor();
    });
  });
}
$('monThreadBtn').onclick=async()=>{
  const m=$('monThreadMenu');
  if(m.style.display==='none'){await loadThreadList();m.style.display='block';}
  else m.style.display='none';
};
document.addEventListener('click',(e)=>{
  if(!e.target.closest('#monThreadMenu')&&!e.target.closest('#monThreadBtn'))
    {const m=$('monThreadMenu');if(m)m.style.display='none';}
});
$('monThreadAll').onclick=()=>{monSelected=new Set(monThreads.map(t=>t.id));loadThreadList();$('monThreadCount').textContent=`(${monSelected.size})`;loadMonitor();};
$('monThreadNone').onclick=()=>{monSelected=new Set();loadThreadList();$('monThreadCount').textContent='';loadMonitor();};
$('monGroup').addEventListener('change',()=>loadMonitor());
/* ---------- PROJELER ---------- */
let projects=[];
async function loadProjects(){
  const data=await (await fetch('/api/projects')).json();
  projects=data.projects||[];
  const mp=$('monProject');
  mp.innerHTML='<option value="">Tüm projeler</option>'+projects.map(p=>`<option value="${esc(p.name)}">${esc(p.name)}</option>`).join('');
  renderProjects();
}
const PJ_COLORS=['#4f79ff','#a78bf2','#2fbf82','#e8a13c','#3fc1c9','#ef6767','#7a5cff'];
function pjColor(name){
  let h=0;for(const ch of String(name))h=(h*31+ch.charCodeAt(0))>>>0;
  return PJ_COLORS[h%PJ_COLORS.length];
}
function pjInitials(name){
  const parts=String(name).split(/[-_\s]+/).filter(Boolean);
  return ((parts[0]?.[0]||'')+(parts[1]?.[0]||'')).toUpperCase()||'?';
}
function pjStamp(s){
  if(!s)return null;
  const str=String(s);
  // koşu damgası ISO tarih ise okunur biçime çevir; değilse (serbest koşu adı) kısalt
  if(/^\d{4}-\d{2}-\d{2}T/.test(str))return `${str.slice(0,10)} ${str.slice(11,16).replace('-',':')}`;
  return str.length>22?`${str.slice(0,22)}…`:str;
}
const ICON_COPY='<svg viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h9"/></svg>';
const ICON_ROTATE='<svg viewBox="0 0 24 24"><path d="M21 12a9 9 0 1 1-2.64-6.36M21 3v6h-6"/></svg>';
const ICON_TRASH='<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13a1.6 1.6 0 0 0 1.6 1.5h6.8A1.6 1.6 0 0 0 17 20l1-13M9 7V5a1.5 1.5 0 0 1 1.5-1.5h3A1.5 1.5 0 0 1 15 5v2"/></svg>';
const ICON_CLOCK='<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>';
function renderProjects(){
  const q=($('pjSearch').value||'').toLowerCase();
  const list=projects.filter(p=>!q||p.name.includes(q)||String(p.description||'').toLowerCase().includes(q));
  if(!list.length){
    $('pjListWrap').innerHTML='<div class="pjEmpty">Eşleşen proje yok.<br><b>+ Proje</b> ile yeni bir proje oluşturabilirsin.</div>';
    return;
  }
  const cards=list.map(p=>{
    const errCls=p.error_rate>=30?'p-err':p.error_rate>0?'p-warn':'p-ok';
    const last=pjStamp(p.last_run);
    return `<div class="pjCard" data-p="${esc(p.name)}">
      <div class="pjTop">
        <div class="pjAvatar" style="background:${pjColor(p.name)}">${esc(pjInitials(p.name))}</div>
        <div class="pjTitleBox">
          <div class="pjName">${esc(p.name)}</div>
          <div class="pjDescTxt">${esc(p.description||'açıklama yok')}</div>
        </div>
        <span class="pill ${errCls}" title="hata oranı"><span class="d"></span>%${p.error_rate}</span>
      </div>
      <div class="pjStats">
        <div class="pjStat"><b>${p.runs}</b><span>koşu</span></div>
        <div class="pjStat"><b>${p.turns}</b><span>tur</span></div>
        <div class="pjStat"><b>${fmtNum(p.tokens)}</b><span>token</span></div>
        <div class="pjStat"><b>${p.avg_s}<small style="font-size:9px;color:var(--faint)"> sn</small></b><span>ort. süre</span></div>
      </div>
      <div class="pjLast">${ICON_CLOCK}${last?`son koşu ${esc(last)}`:'henüz koşu yok'}</div>
      <div class="pjFoot">
        <div class="pjKeyChip pjKey" data-k="${esc(p.api_key)}" title="API anahtarını kopyala">
          ${ICON_COPY}<span class="kTxt">${esc(p.api_key.slice(0,18))}…</span>
        </div>
        <div class="pjIconBtn warn pjRotate" data-p="${esc(p.name)}" title="anahtarı yenile">${ICON_ROTATE}</div>
        ${p.name==='default'?'':`<div class="pjIconBtn danger pjDel" data-p="${esc(p.name)}" title="projeyi sil">${ICON_TRASH}</div>`}
      </div>
    </div>`;
  }).join('');
  $('pjListWrap').innerHTML=`<div class="pjGrid">${cards}</div>`;
  $('pjListWrap').querySelectorAll('.pjCard').forEach(card=>{
    card.onclick=()=>{setProjFilter(card.dataset.p);go('runs');};
  });
  $('pjListWrap').querySelectorAll('.pjRotate').forEach(btn=>{
    btn.onclick=async(ev)=>{
      ev.stopPropagation();
      if(!await sqConfirm({title:`'${btn.dataset.p}' anahtarını yenile`,html:`Yeni bir API anahtarı üretilecek.`,warn:'Eski anahtar <b>anında geçersiz</b> olur; bu anahtarı kullanan tüm entegrasyonların güncellenmesi gerekir.',confirmText:'Anahtarı yenile',danger:true}))return;
      const res=await fetch('/api/project-key-rotate',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name:btn.dataset.p})});
      const d=await res.json();
      if(!d.ok){sqAlert('Olmadı',esc(d.error||''));return;}
      loadProjects();
    };
  });
  $('pjListWrap').querySelectorAll('.pjDel').forEach(btn=>{
    btn.onclick=async(ev)=>{
      ev.stopPropagation();
      const name=btn.dataset.p;
      const ok=await sqConfirm({
        title:`'${name}' projesini sil`,
        html:`<b>${esc(name)}</b> projesi, API anahtarı ve bu projeye ait <b>tüm koşu ve tur verileri</b> silinecek.`,
        warn:'Bu işlem <b>geri alınamaz</b> — silinen veriler geri getirilemez. Bu anahtarı kullanan entegrasyonlar veri gönderemez olur.',
        confirmText:'Kalıcı olarak sil',danger:true,typeToConfirm:name,
      });
      if(!ok)return;
      const res=await fetch('/api/project-delete',{method:'POST',headers:{'Content-Type':'application/json'},
        body:JSON.stringify({name})});
      const d=await res.json();
      if(!d.ok){sqAlert('Silinemedi',esc(d.error||''));return;}
      loadProjects();
    };
  });
  $('pjListWrap').querySelectorAll('.pjKey').forEach(btn=>{
    btn.onclick=(ev)=>{
      ev.stopPropagation();
      navigator.clipboard.writeText(btn.dataset.k);
      const txt=btn.querySelector('.kTxt');
      if(txt){const old=txt.textContent;txt.textContent='kopyalandı ✓';setTimeout(()=>{txt.textContent=old;},1200);}
    };
  });
}
$('pjSearch').addEventListener('input',renderProjects);
$('pjNewBtn').onclick=()=>{const f=$('pjNewForm');f.style.display=f.style.display==='none'?'block':'none';};
$('pjNewSave').onclick=async()=>{
  const res=await fetch('/api/project-create',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({name:$('pjNewName').value,description:$('pjNewDesc').value})});
  const d=await res.json();
  if(!d.ok){$('pjNewNote').textContent=d.error;return;}
  $('pjNewNote').textContent='Oluşturuldu — anahtar kartın altında.';$('pjNewForm').style.display='none';$('pjNewName').value='';$('pjNewDesc').value='';
  loadProjects();
};
$('monProject').addEventListener('change',()=>loadMonitor());

async function loadMonitor(){
  const params=new URLSearchParams({group:$('monGroup').value});
  if($('monProject').value)params.set('project',$('monProject').value);
  if(monSelected.size)params.set('threads',[...monSelected].join(','));
  const data=await (await fetch('/api/monitor?'+params)).json();
  const runs=data.runs||[];
  $('monSub').textContent=$('monGroup').value==='thread'?`${runs.length} thread`:`son ${runs.length} koşu`;
  const sum=(f)=>runs.reduce((a,r)=>a+f(r),0);
  $('mRuns').textContent=runs.length;
  $('mTurns').textContent=fmtNum(sum(r=>r.turns));
  const okT=sum(r=>r.ok),allT=sum(r=>r.turns);
  $('mRate').textContent=allT?Math.round(100*okT/allT)+'%':'–';
  $('mTok').textContent=fmtNum(sum(r=>r.tokens_in+r.tokens_out));
  $('mTools').textContent=fmtNum(sum(r=>r.tool_calls));
  if(!runs.length){$('monCharts').innerHTML='<div style="color:var(--faint)">Henüz koşu verisi yok.</div>';return;}
  $('monCharts').innerHTML=
    barChart({title:($('monGroup').value==='thread'?'Thread':'Koşu')+' başına tur sonucu',runs,legend:true,series:[
      {key:'ok',label:'tamamlanan',color:MC.ok,val:r=>r.ok},
      {key:'bad',label:'sorunlu',color:MC.bad,val:r=>r.bad}]})+
    barChart({title:($('monGroup').value==='thread'?'Thread':'Koşu')+' başına token kullanımı (≈)',runs,legend:true,series:[
      {key:'in',label:'girdi token',color:MC.tok_in,val:r=>r.tokens_in},
      {key:'out',label:'çıktı token',color:MC.tok_out,val:r=>r.tokens_out}]})+
    barChart({title:($('monGroup').value==='thread'?'Thread':'Koşu')+' başına ortalama tur süresi (sn)',runs,legend:false,series:[
      {key:'lat',label:'ort. süre (sn)',color:MC.lat,val:r=>r.avg_s}]})+
    (runs.some(r=>r.avg_score!=null)
      ?barChart({title:($('monGroup').value==='thread'?'Thread':'Koşu')+' başına ortalama skor (%)',runs,legend:false,series:[
        {key:'score',label:'ort. skor (%)',color:MC.ok,val:r=>r.avg_score!=null?Math.round(r.avg_score*100):0}]})
      :'');
  document.querySelectorAll('.mBar').forEach(el=>{
    el.addEventListener('mousemove',(ev)=>monTipShow(ev,el.dataset.tip));
    el.addEventListener('mouseleave',monTipHide);
  });
}
$('monRefresh').onclick=loadMonitor;
$('cfgKeyCopy').onclick=()=>{navigator.clipboard.writeText($('cfgKey').value);$('cfgKeyCopy').textContent='Kopyalandı';setTimeout(()=>$('cfgKeyCopy').textContent='Kopyala',1200);};
$('cfgLiveSave').onclick=async()=>{
  const res=await fetch('/api/config',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({live_ingest:$('cfgLive').checked})});
  const d=await res.json();
  $('cfgLiveNote').textContent=d.ok?'Kaydedildi — anında geçerli.':'Kaydedilemedi.';
};

loadConfig().then(async()=>{await loadProjects();initGenericForm();go('proj');});
