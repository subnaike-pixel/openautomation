'use strict';

// marked
if (window.marked) {
  if (typeof window.marked === 'function') window.marked = { parse: window.marked };
  else if (!window.marked.parse && window.marked.marked) window.marked.parse = window.marked.marked;
}
const md = t => { if (!t) return ''; try { return window.marked.parse(t, { breaks:true, gfm:true }); } catch { return esc(t); } };

const $ = id => document.getElementById(id);
const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
const tf = t => t ? new Date(t).toLocaleTimeString([],{hour:'2-digit',minute:'2-digit'}) : '';
const FICONS = {js:'🟨',ts:'🔷',json:'📋',md:'📝',txt:'📄',html:'🌐',css:'🎨',py:'🐍',sh:'⚙️',png:'🖼️',jpg:'🖼️',pdf:'📕',zip:'📦'};
const ficon = n => FICONS[n.split('.').pop()?.toLowerCase()] || '📄';

function toast(msg, dur=2500) {
  const t = $('toast');
  t.textContent = msg; t.style.opacity = '1';
  clearTimeout(t._t); t._t = setTimeout(() => t.style.opacity = '0', dur);
}

// State
const SK = 'agent:main:main';
let projects = [], activePid = null, connSt = 'connecting', gmailAddr = '';
const pSt = {};
const MC = { msgs:[], streaming:false, el:null, text:'' };

function ps(id) {
  if (!pSt[id]) pSt[id] = { tab:'chat', msgs:[], streaming:false, el:null, text:'' };
  return pSt[id];
}

// Connection
window.api.onConnectionStatus(s => {
  connSt = s;
  $('cdot').className = 'cd ' + s;
  $('clbl').textContent = {connected:'Connected',connecting:'Connecting…',disconnected:'Disconnected',error:'Error'}[s]||s;
  $('rbn').style.display = (s==='disconnected'||s==='error') ? 'inline' : 'none';
  updatePills();
  if (s === 'connected') window.api.getChatHistory(SK).then(p=>mergeHistory(p)).catch(()=>{});
});
window.api.onGatewayError(m => toast('⚠️ '+m, 4000));

// Chat events — gateway sends state:"final" when run completes, then we fetch history
window.api.onChatEvent(payload => {
  const isPrj = activePid != null;
  const state = isPrj ? ps(activePid) : MC;
  const container = $(isPrj ? 'pmsgs' : 'msgs');
  if (!container) return;

  // Handle streaming delta (if gateway ever sends it)
  if (payload.delta != null) {
    if (!state.streaming) {
      removeTyping(container);
      const el = mkA('');
      state.el = el.querySelector('.bbl');
      state.text = ''; state.streaming = true;
      container.appendChild(el); sb(container);
    }
    state.text += payload.delta;
    if (state.el) { state.el.classList.add('streaming'); state.el.innerHTML = md(state.text); }
    sb(container);
    return;
  }

  // Finalise streaming if it was active
  if (payload.done === true && state.streaming) {
    if (state.el) { state.el.classList.remove('streaming'); state.el.innerHTML = md(state.text||''); }
    state.streaming = false;
    state.msgs.push({ role:'assistant', content:state.text||'', ts:Date.now() });
    if (isPrj) saveLChat(activePid, state.msgs);
    state.el = null; state.text = '';
    sb(container);
    return;
  }

  // Gateway sends {state:"final"} when run completes — fetch history to get the response
  if (payload.state === 'final') {
    removeTyping(container);
    window.api.getChatHistory(SK).then(p => {
      if (!p?.messages?.length) return;
      const msgs = p.messages;

      // Extract tool names used in this run (tool_use blocks)
      const toolsUsed = [];
      msgs.slice(-10).forEach(m => {
        if (Array.isArray(m.content)) {
          m.content.forEach(c => {
            if (c.type === 'tool_use' && c.name && !toolsUsed.includes(c.name)) {
              toolsUsed.push(c.name.replace(/_/g, ' '));
            }
          });
        }
      });

      // Finish the run queue
      if (RunQueue.active) RunQueue.finish(toolsUsed);

      // Find the last assistant text message
      const last = msgs[msgs.length - 1];
      if (last?.role !== 'assistant') return;
      const text = extractText(last.content);
      if (!text) return;
      const alreadyShown = state.msgs.find(m => m.role === 'assistant' && m.content === text);
      if (alreadyShown) return;
      const ts = last.ts || last.createdAt || Date.now();
      state.msgs.push({ role:'assistant', content:text, ts, gw:true });
      if (isPrj) saveLChat(activePid, state.msgs);
      container.appendChild(mkA(text, ts));
      sb(container);
    }).catch(() => {});
  }
});

window.api.onChatHistory(p => mergeHistory(p));

function extractText(content) {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // Only extract plain text blocks, skip thinking/tool_use/tool_result
    return content
      .filter(c => c.type === 'text' || (typeof c === 'string'))
      .map(c => (typeof c === 'string' ? c : (c.text || '')))
      .join('')
      .trim();
  }
  return '';
}

function mergeHistory(payload) {
  if (!payload?.messages) return;
  const gw = payload.messages
    .map(m => ({
      role: m.role,
      content: extractText(m.content),
      ts: m.ts || m.createdAt || Date.now(),
      gw: true
    }))
    // Skip messages with no visible text (thinking, tool calls, etc.)
    .filter(m => m.content.length > 0 && (m.role === 'user' || m.role === 'assistant'));

  const merged = [...gw];
  for (const lm of MC.msgs)
    if (!lm.gw && !merged.find(g => g.role === lm.role && g.content === lm.content)) merged.push(lm);
  merged.sort((a, b) => (a.ts || 0) - (b.ts || 0));
  MC.msgs = merged;
  if (!activePid) { renderMsgs($('msgs'), MC.msgs); sb($('msgs')); }
}

// Nav
const VIEWS = ['chat','apikeys','gmail','doctor','setup'];

function goTo(name) {
  document.querySelectorAll('.nb').forEach(b => b.classList.toggle('on', b.dataset.v===name));

  // Aside
  const aside = $('aside');
  if (name==='projects'||name==='doctor') {
    aside.classList.remove('gone');
    $('asd-p').style.display = name==='projects' ? 'flex' : 'none';
    $('asd-d').style.display = name==='doctor'   ? 'flex' : 'none';
  } else {
    aside.classList.add('gone');
  }

  // Main views
  $('v-project').classList.add('gone');
  VIEWS.forEach(v => $('v-'+v)?.classList.toggle('gone', v!==name));

  if (name==='chat') {
    activePid = null;
    renderMsgs($('msgs'), MC.msgs);
    sb($('msgs'));
  }
  if (name==='projects') {
    // show current project or chat in main area
    VIEWS.forEach(v => $('v-'+v)?.classList.add('gone'));
    if (activePid) {
      $('v-project').classList.remove('gone');
    } else {
      $('v-chat').classList.remove('gone');
    }
  }
  if (name==='setup')  runSetupCheck();
  if (name==='doctor') updatePills();
  if (name==='gmail')  initGmail();
}

document.querySelectorAll('.nb[data-v]').forEach(b => b.addEventListener('click', () => goTo(b.dataset.v)));

// Msg helpers
function mkU(c,t){const el=document.createElement('div');el.className='msg u';el.innerHTML=`<div class="bbl">${esc(c).replace(/\n/g,'<br>')}</div><div class="mt">${tf(t)}</div>`;return el;}
function mkA(c,t){const el=document.createElement('div');el.className='msg a';el.innerHTML=`<div class="bbl">${c?md(c):''}</div>${t?`<div class="mt">${tf(t)}</div>`:''}`;return el;}
function renderMsgs(c,msgs){c.innerHTML='';msgs.forEach(m=>c.appendChild(m.role==='user'?mkU(m.content,m.ts):mkA(m.content,m.ts)));}
function showTyping(c){removeTyping(c);const el=document.createElement('div');el.className='msg a';el.id='ty-'+c.id;el.innerHTML='<div class="typing"><span class="td"></span><span class="td"></span><span class="td"></span></div>';c.appendChild(el);sb(c);}
function removeTyping(c){document.getElementById('ty-'+c.id)?.remove();}
function sb(c){if(c)c.scrollTop=c.scrollHeight;}

async function sendMsg(inp, btn, container, state, pid) {
  const text = inp.value.trim(); if (!text) return;
  if (connSt !== 'connected') { toast('Not connected to gateway'); return; }
  inp.value=''; inp.style.height='auto'; btn.disabled=true;
  const now=Date.now();
  container.appendChild(mkU(text,now)); sb(container);
  state.msgs.push({role:'user',content:text,ts:now});
  if (pid) saveLChat(pid, state.msgs);
  showTyping(container);
  try {
    const key = crypto.randomUUID();
    const res = await window.api.sendMessage(text, key, SK);
    // Start run queue with runId from response
    if (res?.runId) RunQueue.start(res.runId);
    else RunQueue.start(key);
  }
  catch(e) { removeTyping(container); container.appendChild(mkA('⚠️ '+esc(e.message),Date.now())); sb(container); }
  btn.disabled=false; inp.focus();
}
async function saveLChat(id,msgs){try{await window.api.saveLocalChat(id,msgs);}catch{}}

// Main chat
$('bsend').addEventListener('click',()=>sendMsg($('mi'),$('bsend'),$('msgs'),MC,null));
$('mi').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();sendMsg($('mi'),$('bsend'),$('msgs'),MC,null);}});
$('mi').addEventListener('input',()=>{$('mi').style.height='auto';$('mi').style.height=Math.min($('mi').scrollHeight,150)+'px';});

// Project chat
$('pbsend').addEventListener('click',()=>{if(activePid)sendMsg($('pmi'),$('pbsend'),$('pmsgs'),ps(activePid),activePid);});
$('pmi').addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();if(activePid)sendMsg($('pmi'),$('pbsend'),$('pmsgs'),ps(activePid),activePid);}});
$('pmi').addEventListener('input',()=>{$('pmi').style.height='auto';$('pmi').style.height=Math.min($('pmi').scrollHeight,150)+'px';});

// Projects
function renderProjects() {
  const list=$('plist'); list.innerHTML='';
  if (!projects.length) { list.innerHTML='<div style="padding:14px;font-size:12px;color:#3a3a3a">No projects. Click + to create.</div>'; return; }
  projects.forEach(p=>{
    const el=document.createElement('div'); el.className='pi'+(p.id===activePid?' on':'');
    el.innerHTML=`<span class="pdot" style="background:${esc(p.color||'#7c3aed')}"></span><div class="pinfo"><div class="pn">${esc(p.name)}</div>${p.description?`<div class="pd">${esc(p.description)}</div>`:''}</div><button class="pdel" data-id="${p.id}">✕</button>`;
    el.addEventListener('click',e=>{if(e.target.classList.contains('pdel'))return;openProject(p.id);});
    el.querySelector('.pdel').addEventListener('click',e=>{e.stopPropagation();deleteProject(p.id);});
    list.appendChild(el);
  });
}

async function openProject(id) {
  activePid=id;
  const proj=projects.find(p=>p.id===id); if(!proj)return;
  VIEWS.forEach(v=>$('v-'+v)?.classList.add('gone'));
  $('v-chat').classList.add('gone');
  $('v-project').classList.remove('gone');
  renderProjects();
  switchPTab(ps(id).tab||'chat',false);
  const state=ps(id);
  if(!state.msgs.length) state.msgs=await window.api.getLocalChat(id);
  renderMsgs($('pmsgs'),state.msgs); sb($('pmsgs'));
}

function switchPTab(tab,load=true){
  if(activePid)ps(activePid).tab=tab;
  document.querySelectorAll('.pt').forEach(b=>b.classList.toggle('on',b.dataset.pt===tab));
  ['chat','notes','files'].forEach(t=>$('pt-'+t)?.classList.toggle('gone',t!==tab));
  if(!activePid||!load)return;
  if(tab==='notes')loadNotes(activePid);
  if(tab==='files')loadFiles(activePid);
}
document.querySelectorAll('.pt').forEach(b=>b.addEventListener('click',()=>switchPTab(b.dataset.pt)));
$('bback').addEventListener('click',()=>{activePid=null;goTo('chat');});

let npColor='#7c3aed';
$('bnp').addEventListener('click',()=>{$('npf').classList.toggle('show');if($('npf').classList.contains('show')){$('npn').value='';$('npd').value='';$('npn').focus();}});
document.querySelectorAll('.cp').forEach(d=>d.addEventListener('click',()=>{npColor=d.dataset.c;document.querySelectorAll('.cp').forEach(x=>x.classList.remove('sel'));d.classList.add('sel');}));
$('bnpc').addEventListener('click',()=>$('npf').classList.remove('show'));
$('bnpok').addEventListener('click',createProject);
$('npn').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();$('npd').focus();}if(e.key==='Escape')$('npf').classList.remove('show');});
$('npd').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();createProject();}if(e.key==='Escape')$('npf').classList.remove('show');});

async function createProject(){
  const name=$('npn').value.trim();
  if(!name){$('npn').style.borderColor='#ef4444';setTimeout(()=>$('npn').style.borderColor='',1500);return;}
  const p={id:crypto.randomUUID(),name,description:$('npd').value.trim(),color:npColor,createdAt:Date.now()};
  projects.push(p);await window.api.saveProjects(projects);
  $('npf').classList.remove('show');renderProjects();openProject(p.id);
}
async function deleteProject(id){
  if(!confirm('Remove project? (Files stay on disk.)'))return;
  projects=projects.filter(p=>p.id!==id);await window.api.saveProjects(projects);
  delete pSt[id];renderProjects();
  if(activePid===id){activePid=null;goTo('chat');}
}

// Notes
let ntmr=null,prevOn=true;
async function loadNotes(id){const c=await window.api.getNotes(id);$('ned').value=c||'';$('nprev').innerHTML=md(c||'');$('nst').textContent='All saved';}
$('ned').addEventListener('input',()=>{
  $('nprev').innerHTML=md($('ned').value);$('nst').textContent='Unsaved…';
  clearTimeout(ntmr);ntmr=setTimeout(async()=>{if(!activePid)return;await window.api.saveNotes(activePid,$('ned').value);$('nst').textContent='Saved ✓';},1000);
});
$('btogp').addEventListener('click',()=>{
  prevOn=!prevOn;$('npw').classList.toggle('gone',!prevOn);
  document.querySelector('.ned-wrap').style.borderRight=prevOn?'':'none';
  $('btogp').textContent=prevOn?'Hide Preview':'Preview';
});

// Files
async function loadFiles(id){
  const list=$('flist');list.innerHTML='';
  const files=await window.api.getFiles(id);
  if(!files?.length){list.innerHTML='<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;height:150px;gap:8px;color:#3a3a3a;font-size:13px"><div style="font-size:26px;opacity:.3">📁</div><div>No files yet</div></div>';return;}
  files.forEach(name=>{
    const el=document.createElement('div');el.className='fitem';
    el.innerHTML=`<span class="fico">${ficon(name)}</span><span class="fname">${esc(name)}</span><span class="fext">.${esc(name.split('.').pop())}</span>`;
    el.addEventListener('click',async()=>{const c=await window.api.readFile(id,name);$('mfn').textContent=name;$('mcon').textContent=c||'[Empty]';$('fmodal').style.display='flex';});
    list.appendChild(el);
  });
}

// API Keys
document.querySelectorAll('.eyebtn').forEach(btn=>btn.addEventListener('click',()=>{
  const inp=$(btn.dataset.t);if(!inp)return;
  inp.type=inp.type==='password'?'text':'password';
  btn.textContent=inp.type==='password'?'👁':'🙈';
}));
document.querySelectorAll('[data-prov][data-inp]').forEach(btn=>btn.addEventListener('click',async()=>{
  const inp=$(btn.dataset.inp);const key=inp?.value.trim();
  if(!key){toast('Paste your API key first');return;}
  const ks=$('ks-'+btn.dataset.prov);
  if(ks){ks.textContent='Saving…';ks.className='ks';}
  btn.disabled=true;
  const r=await window.api.setupConfigureApiKey(btn.dataset.prov,key);
  btn.disabled=false;
  if(r.ok){if(ks){ks.textContent='✓ Saved!';ks.className='ks ok';}inp.value='';inp.placeholder='••••••••••••••• (saved)';toast('✓ API key saved!');}
  else{if(ks){ks.textContent='✗ '+(r.error||'Error');ks.className='ks err';}toast('Error: '+r.error,4000);}
}));

// Doctor
function updatePills(){
  const gw=$('pgw'),wd=$('pwd'),bk=$('pbk');
  if(gw){gw.className='pill '+(connSt==='connected'?'ok':'bad');gw.textContent='⬤ Gateway '+(connSt==='connected'?'OK':'Offline');}
  if(wd){wd.className='pill ok';wd.textContent='⬤ Watchdog';}
  if(bk){bk.className='pill ok';bk.textContent='⬤ Backup';}
}
document.querySelectorAll('.cbtn').forEach(btn=>btn.addEventListener('click',async()=>{
  document.querySelectorAll('.cbtn').forEach(b=>b.classList.remove('run'));
  btn.classList.add('run');
  const res=$('drres');
  res.innerHTML='<div class="dim"><span class="dspin">⟳</span> Running…</div>';
  try{
    const data=await window.api.doctorRun(btn.dataset.ck);
    if(!data?.length){res.innerHTML='<div class="dim">No results.</div>';return;}
    let html='<table class="drtable"><thead><tr><th>Check</th><th>Value</th><th>Status</th></tr></thead><tbody>';
    data.forEach(r=>{html+=`<tr><td>${esc(r.label)}</td><td><code style="font-size:12px;font-family:Consolas,monospace">${esc(String(r.value))}</code></td><td class="${r.ok?'dok':'dbad'}">${r.ok?'✓':'✗'}</td></tr>`;});
    html+='</tbody></table>';res.innerHTML=html;
  }catch(e){res.innerHTML=`<div class="dim" style="color:#ef4444">Error: ${esc(e.message)}</div>`;}
  btn.classList.remove('run');
}));

// Setup
async function runSetupCheck(){
  const rows=$('srows');if(!rows)return;
  rows.innerHTML='<div class="dim">Checking…</div>';
  const s=await window.api.setupCheck();
  const row=(label,ok,last=false)=>`<div class="srow${last?' last':''}"><span>${label}</span><span style="color:${ok?'#10b981':'#ef4444'}">${ok?'✓ OK':'✗ Missing'}</span></div>`;
  rows.innerHTML=row('Node.js',s.nodeInstalled)+row('npm',s.npmInstalled)+row('OpenClaw',s.openclawInstalled)+row('Gateway',s.gatewayConnected,true).replace('Missing','Not connected');
  $('binstall').style.display=(!s.openclawInstalled||!s.gatewayConnected)?'block':'none';
}
$('binstall').addEventListener('click',async()=>{
  const log=$('ilog');log.style.display='block';log.textContent='';
  window.api.onInstallLog(msg=>{log.textContent+=msg+'\n';log.scrollTop=log.scrollHeight;});
  const r=await window.api.setupInstall();
  r.ok?(toast('✓ OpenClaw ready!'),setTimeout(runSetupCheck,2000)):toast('Error: '+r.error,5000);
});
$('bsvt').addEventListener('click',async()=>{
  const val=$('gwt').value.trim();if(!val){toast('Enter a token');return;}
  const cfg=await window.api.getConfig();cfg.gatewayToken=val;await window.api.saveConfig(cfg);
  toast('Token saved!');$('gwt').value='';$('gwt').placeholder='••••••••••••••• (saved)';
});
$('bbkp').addEventListener('click',async()=>{await window.api.backup();toast('Backup complete ✓');});

// Gmail
function gmailStep(n){
  for(let i=1;i<=4;i++){
    const el=$('gs'+i);if(!el)continue;
    if(i<n){el.classList.remove('dis');const d=$('gsd'+i);if(d)d.style.display='flex';}
    else if(i===n)el.classList.remove('dis');
    else el.classList.add('dis');
  }
}
async function initGmail(){
  const st=await window.api.gmailStatus();
  if(st.configured){
    gmailAddr=st.account||'';
    if(gmailAddr&&$('gemail'))$('gemail').value=gmailAddr;
    for(let i=1;i<=4;i++){gmailStep(i);const d=$('gsd'+i);if(d)d.style.display='flex';}
  }else{gmailStep(1);}
  checkPrereqs();
}
async function checkPrereqs(){
  const list=$('prereqs');if(!list)return;
  list.innerHTML='<div class="dim">Checking…</div>';
  const p=await window.api.gmailCheckPrereqs();
  const items=[{key:'node',label:'Node.js',url:null},{key:'openclaw',label:'OpenClaw',url:null},{key:'gcloud',label:'gcloud CLI',url:'https://cloud.google.com/sdk/docs/install'},{key:'gogcli',label:'gogcli',url:null}];
  list.innerHTML='';
  items.forEach(it=>{
    const row=document.createElement('div');row.className='prow';
    const a=p[it.key]?`<span class="pok">✓ Ready</span>`:it.url?`<span class="pbad">✗</span> <a href="${esc(it.url)}" target="_blank" style="color:#a78bfa;font-size:12px">Install ↗</a>`:`<span class="pbad">✗ Missing</span>`;
    row.innerHTML=`<span>${esc(it.label)}</span><div>${a}</div>`;
    list.appendChild(row);
  });
  if(items.every(it=>p[it.key]))gmailStep(2);
}
$('brecheck').addEventListener('click',checkPrereqs);
$('bauth').addEventListener('click',async()=>{
  const email=$('gemail').value.trim();
  if(!email||!email.includes('@')){toast('Enter a valid Gmail address');return;}
  gmailAddr=email;$('bauth').disabled=true;$('bauth').textContent='Authorizing…';
  $('gawait').style.display='block';$('gares').style.display='none';
  const r=await window.api.gmailSetup(email);
  $('gawait').style.display='none';$('bauth').disabled=false;$('bauth').textContent='Authorize';
  $('gares').style.display='block';
  if(r.ok){$('gares').className='res ok';$('gares').textContent='✓ Gmail authorized!';const d=$('gsd2');if(d)d.style.display='flex';gmailStep(3);}
  else{$('gares').className='res err';$('gares').textContent='Error: '+(r.error||'Failed');}
});
$('bapply').addEventListener('click',async()=>{
  $('bapply').disabled=true;$('bapply').textContent='Applying…';$('gcres').style.display='none';
  const r=await window.api.gmailApplyConfig(gmailAddr);
  $('bapply').disabled=false;$('bapply').textContent='⚡ Apply & Restart';$('gcres').style.display='block';
  if(r.ok){$('gcres').className='res ok';$('gcres').textContent='✓ Applied!';const d=$('gsd3');if(d)d.style.display='flex';gmailStep(4);}
  else{$('gcres').className='res err';$('gcres').textContent='Error: '+(r.error||'Failed');}
});
$('btest').addEventListener('click',async()=>{
  const email=gmailAddr||$('gemail')?.value.trim();
  $('btest').disabled=true;$('btest').textContent='Sending…';$('gtres').style.display='none';
  const r=await window.api.gmailTest(email);
  $('btest').disabled=false;$('btest').textContent='📧 Send Test Email';$('gtres').style.display='block';
  if(r.ok){$('gtres').className='res ok';$('gtres').textContent='✓ Test email sent!';}
  else{$('gtres').className='res err';$('gtres').textContent='Error: '+(r.error||'Failed');}
});

// Modal
$('bmcls').addEventListener('click',()=>$('fmodal').style.display='none');
$('fmodal').addEventListener('click',e=>{if(e.target===$('fmodal'))$('fmodal').style.display='none';});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){$('fmodal').style.display='none';$('npf').classList.remove('show');}});

// Window controls
$('bmin').addEventListener('click',()=>window.api.minimizeWindow());
$('bmax').addEventListener('click',()=>window.api.maximizeWindow());
$('bcls').addEventListener('click',()=>window.api.closeWindow());

// ── Model selector ────────────────────────────────────────────────────────────
let selectedModel = 'anthropic/claude-sonnet-4-6';

async function initModelSelector() {
  // Load current model from config
  try {
    const cfg = await window.api.getConfig();
    if (cfg.activeModel) selectedModel = cfg.activeModel;
  } catch {}
  highlightModel(selectedModel);
}

function highlightModel(model) {
  document.querySelectorAll('.model-opt').forEach(el => {
    el.classList.toggle('active', el.dataset.model === model);
  });
}

document.querySelectorAll('.model-opt').forEach(el => {
  el.addEventListener('click', () => {
    selectedModel = el.dataset.model;
    highlightModel(selectedModel);
  });
});

const btnApplyModel = document.getElementById('btn-apply-model');
if (btnApplyModel) {
  btnApplyModel.addEventListener('click', async () => {
    const status = document.getElementById('model-apply-status');
    if (status) { status.textContent = 'Applying…'; status.style.color = '#777'; }
    btnApplyModel.disabled = true;
    const result = await window.api.setModel(selectedModel);
    btnApplyModel.disabled = false;
    if (result.ok) {
      if (status) { status.textContent = '✓ Model saved!'; status.style.color = '#10b981'; }
      // Save to local config too
      const cfg = await window.api.getConfig();
      cfg.activeModel = selectedModel;
      await window.api.saveConfig(cfg);
      toast('✓ Model set to ' + selectedModel.split('/').pop().replace(':free','') + ' — restart chat to apply');
    } else {
      if (status) { status.textContent = '✗ ' + (result.error || 'Failed'); status.style.color = '#ef4444'; }
      toast('Error: ' + result.error, 4000);
    }
  });
}

// ── Run Queue / Activity Panel ────────────────────────────────────────────────
const RunQueue = {
  active: false,
  runId: null,
  startTs: null,
  elapsedTimer: null,
  steps: [],

  start(runId) {
    this.active = true;
    this.runId = runId;
    this.startTs = Date.now();
    this.steps = [];
    $('run-panel').classList.add('active');
    $('rp-bar').classList.add('indeterminate');
    $('rp-label').textContent = 'AutoAgent is thinking…';
    $('rp-steps').innerHTML = '';
    this.addStep('thinking', '🧠 Processing your message…', 'running');
    this.startElapsed();
  },

  addStep(id, text, state = 'running') {
    const existing = this.steps.find(s => s.id === id);
    if (existing) {
      existing.state = state;
      existing.text = text;
    } else {
      this.steps.push({ id, text, state, ts: Date.now() });
    }
    this.renderSteps();
  },

  completeStep(id) {
    const s = this.steps.find(s => s.id === id);
    if (s) { s.state = 'done'; this.renderSteps(); }
  },

  renderSteps() {
    const container = $('rp-steps');
    container.innerHTML = '';
    this.steps.forEach(s => {
      const el = document.createElement('div');
      el.className = 'rp-step ' + s.state;
      const icon = s.state === 'running' ? '<span class="step-pulse">⚡</span>'
                 : s.state === 'done'    ? '✓'
                 : s.state === 'error'   ? '✗'
                 : '·';
      const elapsed = s.state !== 'running' ? `<span class="rp-step-time">${((Date.now()-s.ts)/1000).toFixed(1)}s</span>` : '';
      el.innerHTML = `<span class="rp-step-icon">${icon}</span><span class="rp-step-text">${esc(s.text)}</span>${elapsed}`;
      container.appendChild(el);
    });
    container.scrollTop = container.scrollHeight;
  },

  setLabel(text) {
    $('rp-label').textContent = text;
  },

  startElapsed() {
    clearInterval(this.elapsedTimer);
    const phases = [
      [3,  '🧠 Thinking…'],
      [8,  '🔍 Working on it…'],
      [15, '⚙️ Running tasks…'],
      [25, '📡 Almost there…'],
      [40, '⏳ Still going…'],
    ];
    this.elapsedTimer = setInterval(() => {
      const secs = Math.floor((Date.now() - this.startTs) / 1000);
      $('rp-elapsed').textContent = secs + 's';
      // Update label based on elapsed time
      for (let i = phases.length - 1; i >= 0; i--) {
        if (secs >= phases[i][0]) { $('rp-label').textContent = phases[i][1]; break; }
      }
    }, 1000);
  },

  finish(toolsUsed) {
    this.active = false;
    clearInterval(this.elapsedTimer);
    // Mark all running steps as done
    this.steps.forEach(s => { if (s.state === 'running') s.state = 'done'; });
    $('rp-bar').classList.remove('indeterminate');
    $('rp-bar').style.width = '100%';
    $('rp-label').textContent = '✓ Done' + (toolsUsed.length ? ` · used ${toolsUsed.join(', ')}` : '');

    // Show tool steps used
    if (toolsUsed.length) {
      toolsUsed.forEach(t => this.addStep('tool-'+t, '🔧 ' + t, 'done'));
    }
    this.renderSteps();

    // Collapse after 3s
    setTimeout(() => {
      $('run-panel').classList.remove('active');
      $('rp-bar').style.width = '0%';
    }, 3000);
  },

  cancel() {
    this.active = false;
    clearInterval(this.elapsedTimer);
    this.steps.forEach(s => { if (s.state === 'running') s.state = 'error'; });
    this.addStep('cancelled', '⛔ Run stopped', 'error');
    $('rp-bar').classList.remove('indeterminate');
    $('rp-label').textContent = 'Run stopped';
    setTimeout(() => $('run-panel').classList.remove('active'), 2000);
  }
};

// Stop button
$('rp-stop').addEventListener('click', async () => {
  if (!RunQueue.runId) return;
  try {
    await window.api.sendMessage('/stop', crypto.randomUUID(), SK);
  } catch {}
  RunQueue.cancel();
  removeTyping($('msgs'));
  removeTyping($('pmsgs'));
});

// ── Onboarding Wizard ─────────────────────────────────────────────────────────
const Onboard = {
  step: 0,
  selectedModel: 'openrouter/meta-llama/llama-3.3-70b-instruct:free',
  selectedProv: 'openrouter',
  checksOk: false,

  async shouldShow() {
    try {
      const cfg = await window.api.getConfig();
      if (cfg.onboarded) return false;
    } catch {}
    return true;
  },

  show() {
    $('onboard').style.display = 'flex';
    this.goStep(0);
    this.bindEvents();
  },

  hide() {
    const el = $('onboard');
    el.style.transition = 'opacity .35s';
    el.style.opacity = '0';
    setTimeout(() => { el.style.display = 'none'; el.style.opacity = ''; el.style.transition = ''; }, 360);
  },

  goStep(n) {
    this.step = n;
    [0,1,2,3].forEach(i => {
      $('obs-'+i)?.classList.toggle('gone', i !== n);
      document.querySelector('.ob-dot[data-s="'+i+'"]')?.classList.toggle('on', i === n);
    });
    if (n === 1) this.runChecks();
  },

  bindEvents() {
    $('ob-start').addEventListener('click', () => this.goStep(1));
    $('ob-back-check').addEventListener('click', () => this.goStep(0));
    $('ob-check-next').addEventListener('click', () => this.goStep(2));
    $('ob-back-1').addEventListener('click', () => this.goStep(1));

    // Node.js download link
    $('ob-node-dl').addEventListener('click', () => window.api.openExternal('https://nodejs.org'));

    // Model selection
    document.querySelectorAll('.ob-model').forEach(el => {
      el.addEventListener('click', () => {
        document.querySelectorAll('.ob-model').forEach(m => m.classList.remove('on'));
        el.classList.add('on');
        this.selectedModel = el.dataset.model;
        this.selectedProv = el.dataset.prov;
        this.updateKeyHint();
      });
    });

    // Eye toggle
    $('ob-eye').addEventListener('click', () => {
      const inp = $('ob-key-input');
      inp.type = inp.type === 'password' ? 'text' : 'password';
      $('ob-eye').textContent = inp.type === 'password' ? '👁' : '🙈';
    });

    $('ob-save-key').addEventListener('click', () => this.saveKey());
    $('ob-done').addEventListener('click', () => this.finish());
  },

  async runChecks() {
    const nextBtn = $('ob-check-next');
    nextBtn.disabled = true;
    $('ob-node-warning').style.display = 'none';

    // Reset UI
    const setCheck = (id, state, sub, badge) => {
      const el = $('obck-'+id);
      const icon = el.querySelector('.obck-icon');
      const subEl = $('obck-'+id+'-sub');
      const badgeEl = $('obck-'+id+'-badge');
      el.className = 'ob-check ' + (state === 'ok' ? 'ok' : state === 'bad' ? 'bad' : '');
      icon.className = 'obck-icon' + (state === 'loading' ? ' obck-spin' : '');
      icon.textContent = state === 'loading' ? '⟳' : state === 'ok' ? '✅' : '❌';
      subEl.textContent = sub;
      badgeEl.textContent = badge;
      badgeEl.style.color = state === 'ok' ? '#10b981' : state === 'bad' ? '#ef4444' : '#666';
    };

    setCheck('node', 'loading', 'Checking…', '');
    setCheck('openclaw', 'loading', 'Checking…', '');

    try {
      const s = await window.api.setupCheck();

      // Node check
      if (s.nodeInstalled) {
        setCheck('node', 'ok', 'Installed and ready', '✓ OK');
      } else {
        setCheck('node', 'bad', 'Not found — required to run OpenAutomation', '✗ Missing');
        $('ob-node-warning').style.display = 'flex';
        this.checksOk = false;
        return;
      }

      // OpenClaw check
      if (s.openclawInstalled || s.gatewayConnected) {
        setCheck('openclaw', 'ok', 'Engine ready', '✓ OK');
        this.checksOk = true;
        nextBtn.disabled = false;
      } else {
        setCheck('openclaw', 'loading', 'Installing engine…', '');
        // Trigger install in background
        const r = await window.api.setupInstall();
        if (r.ok) {
          setCheck('openclaw', 'ok', 'Installed and started', '✓ OK');
          this.checksOk = true;
          nextBtn.disabled = false;
        } else {
          setCheck('openclaw', 'bad', 'Could not install — try Setup tab', '✗ Error');
        }
      }
    } catch (e) {
      setCheck('node', 'bad', 'Check failed: ' + e.message, '✗');
      setCheck('openclaw', 'bad', 'Check failed', '✗');
    }
  },

  updateKeyHint() {
    const hints = {
      openrouter: 'Sign up free at <strong>openrouter.ai</strong> → Keys → Create key.',
      anthropic: 'Get your key at <strong>console.anthropic.com</strong> → API Keys.',
      openai: 'Get your key at <strong>platform.openai.com</strong> → API Keys.',
    };
    const placeholders = {
      openrouter: 'sk-or-v1-...',
      anthropic: 'sk-ant-api03-...',
      openai: 'sk-...',
    };
    $('ob-key-hint').innerHTML = hints[this.selectedProv] || '';
    $('ob-key-input').placeholder = placeholders[this.selectedProv] || 'Paste API key…';
  },

  async saveKey() {
    const key = $('ob-key-input').value.trim();
    const btn = $('ob-save-key');
    const st = $('ob-key-status');

    if (!key) {
      st.className = 'ob-key-status err';
      st.textContent = 'Please paste your API key first.';
      return;
    }

    btn.disabled = true; btn.textContent = 'Saving…';
    st.className = 'ob-key-status'; st.textContent = '';

    try {
      const r = await window.api.setupConfigureApiKey(this.selectedProv, key);
      if (!r.ok) throw new Error(r.error || 'Failed');

      // Also set the model
      await window.api.setModel(this.selectedModel).catch(() => {});
      const cfg = await window.api.getConfig();
      cfg.activeModel = this.selectedModel;
      await window.api.saveConfig(cfg);

      st.className = 'ob-key-status ok'; st.textContent = '✓ Key saved!';
      await new Promise(r => setTimeout(r, 700));
      this.goStep(3);
    } catch (e) {
      st.className = 'ob-key-status err'; st.textContent = '✗ ' + e.message;
    } finally {
      btn.disabled = false; btn.textContent = 'Save & Continue →';
    }
  },

  async finish() {
    try {
      const cfg = await window.api.getConfig();
      cfg.onboarded = true;
      await window.api.saveConfig(cfg);
    } catch {}
    this.hide();
    toast('🎉 Welcome to OpenAutomation!', 3000);
  }
};

// Boot
async function init() {
  projects = await window.api.getProjects();
  renderProjects();
  updatePills();
  initModelSelector();
  goTo('chat');
  try { const p = await window.api.getChatHistory(SK); mergeHistory(p); } catch {}

  // Show onboarding wizard for new users
  if (await Onboard.shouldShow()) {
    Onboard.show();
  }
}
init();
