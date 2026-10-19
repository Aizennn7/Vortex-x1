import './styles.css';
import { relay } from './relay';

const root = document.getElementById('workspace-root');
const base = (import.meta.env.VITE_RELAY_URL || '').replace(/\/$/, '');
const pages = [
  ['index.html','Overview'],['signals.html','Signals'],['markets.html','Markets'],['learning.html','AI Learning'],
  ['secrets.html','Secrets & Data'],['instructions.html','Instructions'],
  ['performance.html','Performance'],['system.html','System Health'],['settings.html','Settings'],['integrations.html','Plugins & MCP'],['operator.html','AI Operator'],
];
const page = location.pathname.split('/').pop() || 'index.html';
const current = pages.find(([file]) => file === page)?.[1] || 'Overview';
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const nav = () => `<aside class="page-sidebar"><a class="nexus-brand" href="./index.html"><span class="nexus-brand-mark">V</span><span><strong>VORTEX SI</strong><small>Signal Intelligence</small></span></a><nav>${pages.map(([href,label])=>`<a href="./${href}" ${label===current?'aria-current="page"':''}>${label}</a>`).join('')}</nav></aside>`;
const operatorMarkup = () => `
  <button class="ai-operator-launch" id="ai-operator-launch" type="button" aria-controls="ai-operator-panel" aria-expanded="false"><span aria-hidden="true">✳</span> AI Operator</button>
  <section class="ai-operator-panel" id="ai-operator-panel" aria-label="VORTEX AI Operator" hidden>
    <header class="ai-operator-header"><div><p class="eyebrow">LOCAL MODEL BRIDGE</p><h2>VORTEX AI Operator</h2><p class="page-note">Advisory by default. With a backend token, it may request explicitly allowlisted read-only tools; each call requires your confirmation.</p></div><button type="button" id="ai-operator-close" aria-label="Close AI Operator">×</button></header>
    <div class="ai-operator-config">
      <label>OpenAI-compatible endpoint<input id="ai-operator-endpoint" type="url" inputmode="url" placeholder="Local inference endpoint URL" autocomplete="url"></label>
      <label>Model name<input id="ai-operator-model" value="Qwen3-4B-Q4" autocomplete="off"></label>
      <label>Backend admin token (optional; memory only)<input id="ai-operator-admin-token" type="password" autocomplete="off" placeholder="Enable allowlisted tools for this session"></label>
      <p class="page-note">Endpoint must be HTTPS or loopback. Prompts go to this model endpoint. The admin token is never saved; when supplied, only backend-allowlisted read-only commands/tools are offered and every call requires your confirmation.</p>
    </div>
    <div class="ai-operator-messages" id="ai-operator-messages" role="log" aria-live="polite"><div class="ai-message ai-message-system">Connect a local OpenAI-compatible inference server, then ask about VORTEX status, signal workflows, or debugging. Model output is treated as advice, never as executable instructions.</div></div>
    <div class="ai-operator-actions"><button type="button" id="ai-operator-inspect">Inspect VORTEX status</button><label class="ai-context-toggle"><input id="ai-operator-context" type="checkbox" checked> Include read-only status context</label></div>
    <form class="ai-operator-compose" id="ai-operator-form"><label class="sr-only" for="ai-operator-prompt">Message the AI Operator</label><textarea id="ai-operator-prompt" rows="2" maxlength="4000" placeholder="Ask about system health, signals, workflows…" required></textarea><button type="submit" id="ai-operator-send">Send</button></form>
    <p class="page-note" id="ai-operator-status" role="status">Local inference is not connected until you configure and test an endpoint.</p>
  </section>`; 
const layout = (title, desc, body) => { document.title = 'VORTEX SI — '+title; root.innerHTML = `<main class="page-layout"><div class="page-shell">${nav()}<section class="page-content"><header class="page-heading"><h1>${title}</h1><p>${desc}</p></header>${body}</section></div></main>${operatorMarkup()}`; initAiOperator(); };
const card = (title, body) => `<section class="workspace-card"><h2>${title}</h2>${body}</section>`;
const status = (msg, cls='') => `<div class="page-status ${cls}" role="status">${esc(msg)}</div>`;
async function api(path, opts={}) {
  const response = await fetch((base || '')+path, { ...opts, headers: { 'Content-Type':'application/json', ...(opts.token ? {Authorization:'Bearer '+opts.token}:{}), ...(opts.headers||{}) } });
  const text = await response.text(); let data;
  const contentType = response.headers.get('content-type') || '';
  if (contentType.includes('text/html') || /^\s*<!doctype\s+html|^\s*<html\b/i.test(text)) {
    throw new Error('The request returned a web page instead of API JSON. Set VITE_RELAY_URL to your VORTEX worker URL, or select a configured Supabase/snapshot data source.');
  }
  try { data = text ? JSON.parse(text) : {}; } catch { throw new Error('The API returned invalid JSON. Check the worker URL and endpoint.'); }
  if (!response.ok) throw new Error(data.error?.message || data.message || data.error || ('HTTP '+response.status));
  return data?.ok === true && Object.prototype.hasOwnProperty.call(data, 'data') ? data.data : data;
}
function utc(value) { if(!value) return '—'; const d=new Date(value); return Number.isNaN(d.getTime())?esc(value):d.toISOString().replace('T',' ').replace('.000Z',' UTC').replace('Z',' UTC'); }

function initAiOperator() {
 const launch=document.getElementById('ai-operator-launch'), panel=document.getElementById('ai-operator-panel');
 const endpoint=document.getElementById('ai-operator-endpoint'), model=document.getElementById('ai-operator-model');
 const messages=document.getElementById('ai-operator-messages'), statusEl=document.getElementById('ai-operator-status');
 const form=document.getElementById('ai-operator-form'), prompt=document.getElementById('ai-operator-prompt');
 if(!launch||!panel)return;
 try{endpoint.value=localStorage.getItem('vortex.ai.endpoint')||'';model.value=localStorage.getItem('vortex.ai.model')||'Qwen3-4B-Q4';}catch{}
 const open=(value)=>{panel.hidden=!value;launch.setAttribute('aria-expanded',String(value));if(value)prompt.focus();};
 launch.addEventListener('click',()=>open(panel.hidden));document.getElementById('ai-operator-close').addEventListener('click',()=>open(false));
 endpoint.addEventListener('change',()=>{try{localStorage.setItem('vortex.ai.endpoint',endpoint.value.trim());}catch{}});
 model.addEventListener('change',()=>{try{localStorage.setItem('vortex.ai.model',model.value.trim());}catch{}});
 const addMessage=(role,text)=>{const node=document.createElement('div');node.className='ai-message ai-message-'+role;node.textContent=text;messages.appendChild(node);messages.scrollTop=messages.scrollHeight;return node;};
 async function inspect(){
  const result={checkedAt:new Date().toISOString(),dataSource:base?'configured relay':'same-origin relay'};
  const jobs=[['health',()=>relay.health()],['summary',()=>relay.summary()],['signals',()=>relay.signals(10)]];
  for(const [name,load] of jobs){try{const r=await load();result[name]=r?.ok&&r.data?r.data:{available:false,error:r?.error||'not available'};}catch(e){result[name]={available:false,error:String(e?.message||e)};}}
  // Keep context small and strictly read-only. Never request or include secrets/admin inventory.
  if(result.health?.provider)result.health={status:result.health.status,ready:result.health.ready,reasons:result.health.reasons,provider:result.health.provider,database:result.health.database,timestamp:result.health.timestamp};
  if(result.summary?.marketData)result.summary={workerStatus:result.summary.workerStatus,marketOpen:result.summary.marketOpen,marketData:result.summary.marketData,providerBudget:result.summary.providerBudget,lastSuccessfulJob:result.summary.lastSuccessfulJob,generatedAt:result.summary.generatedAt,learning:result.summary.learning,scan:result.summary.scan};
  if(result.signals?.signals)result.signals={count:result.signals.count??result.signals.signals.length,signals:result.signals.signals.map(s=>({pair:s.pair,decision:s.decision,status:s.status,scheduledEntryAt:s.scheduledEntryAt,outcome:s.outcome,strategy:s.strategy}))};
  return result;
 }
 document.getElementById('ai-operator-inspect').addEventListener('click',async()=>{
  const button=document.getElementById('ai-operator-inspect');button.disabled=true;statusEl.textContent='Reading permitted health, summary and recent-signal endpoints…';
  try{const context=await inspect();addMessage('system','Read-only VORTEX snapshot:\n'+JSON.stringify(context,null,2));statusEl.textContent='Snapshot loaded. No commands were executed.';}
  catch(e){statusEl.textContent='Inspection failed: '+String(e?.message||e);}finally{button.disabled=false;}
 });
 async function loadToolCatalog(token){
  if(!token)return {tools:[],byName:{}};
  const tools=[],byName={};
  const commandData=await api('/admin/operator/commands',{token});
  for(const command of commandData.commands||[]){
   const name='vortex_'+String(command.id).replace(/[^a-zA-Z0-9_]/g,'_');
   const def={type:'function',function:{name,description:command.label+' (read-only VORTEX command)',parameters:{type:'object',properties:{},additionalProperties:false}}};
   tools.push(def);byName[name]={kind:'command',id:command.id,label:command.label};
  }
  const pluginData=await api('/admin/operator/plugins',{token});
  for(const server of (pluginData.mcpServers||[]).filter(item=>item.enabled)){
   try{
    const discovered=await api('/admin/operator/mcp/'+encodeURIComponent(server.id)+'/tools',{token});
    const allowed=new Set(discovered.allowedReadOnlyTools||[]);
    for(const tool of (discovered.tools||[]).filter(item=>allowed.has(item.name))){
     const name=('mcp_'+server.id+'_'+tool.name).replace(/[^a-zA-Z0-9_]/g,'_').slice(0,64);
     const parameters=tool.inputSchema&&typeof tool.inputSchema==='object'?tool.inputSchema:{type:'object',properties:{}};
     tools.push({type:'function',function:{name,description:(server.name+': '+(tool.description||tool.name)+' (server-allowlisted read-only tool)').slice(0,900),parameters}});
     byName[name]={kind:'mcp',serverId:server.id,toolName:tool.name,label:server.name+': '+tool.name};
    }
   }catch(error){addMessage('system','Skipped MCP server '+server.id+': '+String(error?.message||error));}
  }
  return {tools,byName};
 }
 async function executeOperatorTool(token,descriptor,args){
  if(descriptor.kind==='command')return api('/admin/operator/commands/'+encodeURIComponent(descriptor.id)+'/run',{method:'POST',body:'{}',token});
  if(descriptor.kind==='mcp')return api('/admin/operator/mcp/'+encodeURIComponent(descriptor.serverId)+'/call',{method:'POST',body:JSON.stringify({toolName:descriptor.toolName,arguments:args}),token});
  throw new Error('Tool is not allowlisted.');
 }
 form.addEventListener('submit',async(event)=>{
  event.preventDefault();const userText=prompt.value.trim();if(!userText)return;
  const url=endpoint.value.trim(), modelName=model.value.trim(), adminToken=document.getElementById('ai-operator-admin-token').value.trim();
  if(!url||!modelName){statusEl.textContent='Enter an inference endpoint and model name first.';return;}
  let parsed;try{parsed=new URL(url);}catch{statusEl.textContent='Endpoint URL is invalid.';return;}
  const loopback=['localhost',['127','0','0','1'].join('.'),'['+'::1'+']'].includes(parsed.hostname);
  if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&loopback)){statusEl.textContent='For safety, use HTTPS or a loopback endpoint only. Never expose a local model port to the public internet.';return;}
  const send=document.getElementById('ai-operator-send');send.disabled=true;prompt.value='';addMessage('user',userText);statusEl.textContent='Connecting to model…';
  try{
   const context=document.getElementById('ai-operator-context').checked?await inspect():{contextIncluded:false};
   const catalog=adminToken?await loadToolCatalog(adminToken):{tools:[],byName:{}};
   if(adminToken&&!catalog.tools.length)addMessage('system','No allowlisted tools are available; continuing in advisory-only mode.');
   const system='You are the VORTEX SI AI Operator. Help diagnose, explain and plan changes across the dashboard, signals, market-data ingestion, learning, and CI workflows. Use only supplied read-only context and the explicitly provided allowlisted tools. Never invent data, expose secrets, or claim an action succeeded without its tool result. Each requested tool call is shown to the user for confirmation before execution. Do not attempt writes, trading, deployments, merges, shell commands, or actions not represented by a supplied tool. Distinguish unknown from healthy. Market signals are informational, not financial advice. Current read-only context: '+JSON.stringify(context);
   const messages=[{role:'system',content:system},{role:'user',content:userText}];
   let finalAnswer='';
   for(let round=0;round<4;round++){
    const body={model:modelName,stream:false,messages,...(catalog.tools.length?{tools:catalog.tools,tool_choice:'auto'}:{})};
    const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const raw=await response.text();let data;try{data=raw?JSON.parse(raw):{};}catch{data={};}
    if(!response.ok)throw new Error(data.error?.message||data.message||('HTTP '+response.status+' — check endpoint, CORS and model name'));
    const message=data.choices?.[0]?.message;
    if(!message)throw new Error('The endpoint returned no assistant message. Confirm it supports OpenAI-compatible chat completions.');
    const calls=Array.isArray(message.tool_calls)?message.tool_calls:[];
    if(!calls.length){finalAnswer=typeof message.content==='string'?message.content.trim():'';break;}
    messages.push(message);
    for(const call of calls){
     const fn=call.function||{}, descriptor=catalog.byName[fn.name];
     let args={};try{args=typeof fn.arguments==='string'?JSON.parse(fn.arguments||'{}'):(fn.arguments||{});}catch{args={__invalidJson:true};}
     let result;
     if(!descriptor)result={ok:false,error:'Tool is not in the current allowlist.'};
     else if(args.__invalidJson||!args||typeof args!=='object'||Array.isArray(args))result={ok:false,error:'Tool arguments must be a valid JSON object.'};
     else if(!confirm('The model requests a read-only tool call: '+descriptor.label+'.\n\nArguments:\n'+JSON.stringify(args,null,2)+'\n\nAllow this single call?'))result={cancelled:true,note:'User declined this tool call.'};
     else {statusEl.textContent='Executing confirmed read-only tool: '+descriptor.label;try{result=await executeOperatorTool(adminToken,descriptor,args);}catch(error){result={ok:false,error:String(error?.message||error)};}}
     messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    }
   }
   if(!finalAnswer)finalAnswer='The model did not provide a final text answer within the tool-call limit. Review the tool results above and ask a follow-up.';
   addMessage('assistant',finalAnswer);statusEl.textContent=catalog.tools.length?'Reply received. Only individually confirmed, allowlisted read-only tools could execute.':'Reply received in advisory-only mode; no tools were available.';
  }catch(e){statusEl.textContent='Model request failed: '+String(e?.message||e)+'. On a hosted HTTPS site, browser CORS / mixed-content rules may block phone-local HTTP servers.';}
  finally{send.disabled=false;prompt.focus();}
 });
}
async function signalsPage() {
 layout('Signals','A dedicated signal registry. Every row comes from persisted engine data; no sample or synthetic signals are displayed.',card('Published signals',`<div id="signal-status">${status('Connecting to the configured data source…')}</div><div class="row-fields"><label>Search pair / direction / strategy<input id="signal-search" placeholder="EUR/USD, BUY…"></label><label>Outcome<select id="signal-filter"><option value="">All outcomes</option><option>WIN</option><option>LOSS</option><option>PENDING</option><option>DRAW</option></select></label></div><div class="table-scroll"><table><thead><tr><th>Pair</th><th>Direction</th><th>Open time (UTC)</th><th>Timeframe</th><th>Entry</th><th>Expiry</th><th>Status</th><th>Result</th></tr></thead><tbody id="signals-body"><tr><td colspan="8">Loading…</td></tr></tbody></table></div><p class="page-note">The database schema currently exposes scheduled entry, pair, decision, status and outcome. Timeframe, entry price and expiry are shown only when returned by the API; unavailable fields are marked —.</p><button id="signals-refresh">Refresh signals</button><button id="signals-export">Export CSV</button>`));
 let rows=[];
 const render=()=>{const q=document.getElementById('signal-search').value.toLowerCase(), filter=document.getElementById('signal-filter').value;const filtered=rows.filter(s=>([s.pair,s.decision,s.strategy,s.status,s.outcome].join(' ').toLowerCase().includes(q))&&(!filter||String(s.outcome||'PENDING').toUpperCase()===filter));document.getElementById('signals-body').innerHTML=filtered.length?filtered.map(s=>`<tr><td>${esc(s.pair)}</td><td>${esc(String(s.decision||'—').toUpperCase())}</td><td>${utc(s.scheduledEntryAt||s.openTime||s.open_time)}</td><td>${esc(s.timeframe||s.interval||'—')}</td><td>${esc(s.entryPrice??s.entry_price??'—')}</td><td>${utc(s.expiryAt||s.expiry_at)}</td><td>${esc(s.status||'—')}</td><td>${esc(s.outcome||'PENDING')}${s.realizedPips!=null?' · '+esc(s.realizedPips)+' pips':''}</td></tr>`).join(''):'<tr><td colspan="8">No persisted signals match this filter.</td></tr>';};
 const load=async()=>{document.getElementById('signal-status').innerHTML=status('Loading saved signals…');try{const response=await relay.signals(200);if(!response.ok||!response.data)throw new Error(response.error||'Signal data source did not return a usable response');const d=response.data;rows=d.signals||[];document.getElementById('signal-status').innerHTML=status(rows.length+' persisted signals loaded.','success');render();}catch(e){document.getElementById('signal-status').innerHTML=status('Could not load signals: '+e.message+' · Check relay URL and public API availability.','error');document.getElementById('signals-body').innerHTML='<tr><td colspan="8">Data source unavailable; no fabricated signals shown.</td></tr>';}}
 document.getElementById('signal-search').addEventListener('input',render);document.getElementById('signal-filter').addEventListener('change',render);document.getElementById('signals-refresh').onclick=load;document.getElementById('signals-export').onclick=()=>{const csv=[['pair','direction','open_time_utc','timeframe','entry','expiry','status','result'],...rows.map(s=>[s.pair,s.decision,s.scheduledEntryAt||s.openTime,s.timeframe||'',s.entryPrice??'',s.expiryAt||'',s.status,s.outcome||'PENDING'])].map(r=>r.map(x=>'"'+String(x??'').replace(/"/g,'""')+'"').join(',')).join('\n');const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([csv],{type:'text/csv'}));a.download='vortex-signals.csv';a.click();URL.revokeObjectURL(a.href);};await load();
}
async function secretsPage() {
 layout('Secrets & Data','Manage provider keys through the authenticated server API. Secret values are sent directly to the worker, encrypted there, and never saved in this browser.',card('Secure provider key vault',`<p class="page-note">Enter the admin bearer token configured on your private worker. It is held in this page’s memory only and is not saved to local storage. Provider keys are encrypted at rest by the worker using VORTEX_SECRET_KEY.</p><label>Worker API base URL<input id="api-base" placeholder="https://your-private-worker.example"></label><label>Admin bearer token<input id="admin-token" type="password" autocomplete="off" placeholder="VORTEX_ADMIN_TOKEN"></label><form id="key-form"><div class="row-fields"><label>Provider label<input id="key-label" required value="twelvedata-primary" placeholder="twelvedata-primary"></label><label>Provider API key<input id="provider-key" type="password" required minlength="16" autocomplete="off" placeholder="Paste provider key"></label></div><div class="row-fields"><label>Daily credit limit (optional)<input id="day-limit" type="number" min="1" placeholder="e.g. 800"></label><label>Per-minute limit (optional)<input id="minute-limit" type="number" min="1" placeholder="e.g. 8"></label></div><label><span><input id="verify-key" type="checkbox" style="width:auto"> Verify key with provider after saving</span></label><button type="submit">Encrypt & save to database</button></form><div id="key-status"></div><button id="load-keys" type="button">Load saved key inventory</button><div id="key-list"></div>`)+card('Server-only configuration',`<p class="page-note">DATABASE_URL, DATABASE_URL_DIRECT, VORTEX_SECRET_KEY and VORTEX_ADMIN_TOKEN must be configured in the private worker / GitHub Actions environment. A public GitHub Pages page cannot securely change server environment secrets. Never paste database passwords or the encryption key into this page.</p><p class="page-note">The public dashboard uses read-only database views. This form uses the worker’s authenticated <code>/admin/keys</code> API, not a privileged database credential in the browser.</p>`));
 const token=()=>document.getElementById('admin-token').value.trim();const apiBase=()=>document.getElementById('api-base').value.trim().replace(/\/$/,'')||base;
 document.getElementById('key-form').addEventListener('submit',async e=>{e.preventDefault();const out=document.getElementById('key-status');out.innerHTML=status('Sending key to the authenticated worker…');try{const data=await fetch(apiBase()+'/admin/keys',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token()},body:JSON.stringify({label:document.getElementById('key-label').value.trim(),apiKey:document.getElementById('provider-key').value,dayLimit:Number(document.getElementById('day-limit').value)||undefined,minuteLimit:Number(document.getElementById('minute-limit').value)||undefined,verify:document.getElementById('verify-key').checked})});const d=await data.json();if(!data.ok)throw new Error(d.message||'HTTP '+data.status);document.getElementById('provider-key').value='';out.innerHTML=status('Saved '+(d.key?.label||'provider key')+' to the database. Stored value is masked; raw key cleared from the form. '+(d.verification?.note||''),'success');await loadKeys();}catch(err){out.innerHTML=status('Save failed: '+err.message,'error');}});
 async function loadKeys(){const out=document.getElementById('key-list');out.innerHTML=status('Loading key inventory…');try{const d=await fetch(apiBase()+'/admin/keys',{headers:{Authorization:'Bearer '+token()}});const j=await d.json();if(!d.ok)throw new Error(j.message||'HTTP '+d.status);out.innerHTML=(j.keys||[]).length?'<div class="table-scroll"><table><thead><tr><th>Label</th><th>Masked key</th><th>Status</th><th>Enabled</th><th>Last verified</th></tr></thead><tbody>'+(j.keys||[]).map(k=>'<tr><td>'+esc(k.label)+'</td><td>'+esc(k.maskedKey||k.masked_key||'••••')+'</td><td>'+esc(k.status)+'</td><td>'+esc(k.enabled)+'</td><td>'+utc(k.lastVerifiedAt||k.last_verified_at)+'</td></tr>').join('')+'</tbody></table></div>':status('No provider keys configured.');}catch(e){out.innerHTML=status('Could not load inventory: '+e.message,'error');}}
 document.getElementById('load-keys').onclick=loadKeys;
}
async function marketsPage(){
 layout('Markets','Live market-data health and the newest persisted candles. Provider, freshness and missing data are reported honestly.',`
  <div class="feature-grid">
   <article class="feature-card"><p class="eyebrow">FEED STATUS</p><h2 id="market-feed-status">Checking…</h2><p id="market-feed-detail" class="feature-lede">Reading saved market-data quality.</p></article>
   <article class="feature-card"><p class="eyebrow">PROVIDER CAPACITY</p><h2 id="market-budget">—</h2><p id="market-budget-detail" class="feature-lede">Checking configured provider keys.</p></article>
   <article class="feature-card"><p class="eyebrow">MARKET SESSION</p><h2 id="market-session">—</h2><p id="market-session-detail" class="feature-lede">Session status comes from the data source.</p></article>
  </div>
  ${card('Pair data quality',`<div id="market-quality-status">${status('Loading persisted market-data quality…')}</div><div class="table-scroll"><table><thead><tr><th>Pair</th><th>Feed status</th><th>Age</th><th>Last candle (UTC)</th><th>Details</th></tr></thead><tbody id="market-quality-body"><tr><td colspan="5">Loading…</td></tr></tbody></table></div>`)}
  ${card('Latest candles',`<div class="row-fields"><label>Currency pair<select id="market-pair"><option value="">Select a pair after quality loads</option></select></label><label>Timeframe<input value="M1 · closed candles only" readonly></label></div><div id="market-candle-status">${status('Waiting for pair selection…')}</div><div class="table-scroll"><table><thead><tr><th>Open time (UTC)</th><th>Open</th><th>High</th><th>Low</th><th>Close</th><th>Volume</th><th>Source</th></tr></thead><tbody id="market-candle-body"><tr><td colspan="7">No candle request made yet.</td></tr></tbody></table></div><p class="page-note">Only stored closed candles are displayed. If candle history is unavailable for the selected data-source mode, this page says so instead of creating sample prices.</p><button id="markets-refresh" type="button">Refresh market data</button>`)}
 `);
 const qualityStatus=document.getElementById('market-quality-status');
 const ageLabel=(n)=>n==null?'—':n<60?Math.round(n)+'s':n<3600?Math.round(n/60)+'m':Math.round(n/3600)+'h';
 async function loadCandles(){
  const pair=document.getElementById('market-pair').value;
  const body=document.getElementById('market-candle-body');
  const out=document.getElementById('market-candle-status');
  if(!pair){out.innerHTML=status('Select a pair to inspect candles.');return;}
  if(typeof relay.candles!=='function'){out.innerHTML=status('Candle history is not available in this configured source mode. Connect the relay or Supabase public_candles view to enable it.','error');body.innerHTML='<tr><td colspan="7">No candle-history endpoint available.</td></tr>';return;}
  out.innerHTML=status('Loading stored closed candles for '+pair+'…');
  try{
   const res=await relay.candles(pair,30);
   if(!res.ok||!res.data)throw new Error(res.error||'Candle query failed');
   const rows=res.data.candles||[];
   out.innerHTML=status(rows.length+' stored closed M1 candles · '+(rows[0]?.provider||'source not reported')+'.','success');
   body.innerHTML=rows.length?rows.slice().reverse().map(c=>'<tr><td>'+utc(c.openTime)+'</td><td>'+esc(c.open)+'</td><td>'+esc(c.high)+'</td><td>'+esc(c.low)+'</td><td><strong>'+esc(c.close)+'</strong></td><td>'+esc(c.volume??'—')+'</td><td>'+esc(c.provider)+(c.provider==='simulated'?' · SYNTHETIC':'')+'</td></tr>').join(''):'<tr><td colspan="7">No stored final candles for this pair. Check the worker, provider key, ingestion job and database migrations.</td></tr>';
  }catch(e){out.innerHTML=status('Candle history unavailable: '+e.message,'error');body.innerHTML='<tr><td colspan="7">No fabricated prices shown.</td></tr>';}
 }
 async function load(){
  qualityStatus.innerHTML=status('Refreshing market-data summary…');
  try{
   const res=await relay.summary();
   if(!res.ok||!res.data)throw new Error(res.error||'Market summary could not be read');
   const d=res.data, rows=d.marketData||[];
   const fresh=rows.filter(r=>String(r.status||'').toUpperCase()==='CONNECTED'&&!r.stale).length;
   const disconnected=rows.filter(r=>String(r.status||'').toUpperCase()==='DISCONNECTED'||r.stale).length;
   document.getElementById('market-feed-status').textContent=rows.length?(disconnected?'DEGRADED':'CONNECTED'):'NO DATA';
   document.getElementById('market-feed-detail').textContent=rows.length?fresh+' fresh pair(s), '+disconnected+' stale/disconnected out of '+rows.length+'.':'No market-data quality rows have been recorded yet.';
   const b=d.providerBudget;
   document.getElementById('market-budget').textContent=b?b.usableKeys+' usable key(s)':'NOT VERIFIED';
   document.getElementById('market-budget-detail').textContent=b?b.dayUsed+' / '+b.dayCapacity+' daily credits used. '+(b.warnings||[]).join(' '):'Provider budget is unavailable from this source.';
   document.getElementById('market-session').textContent=d.marketOpen===true?'OPEN':d.marketOpen===false?'CLOSED':'UNKNOWN';
   document.getElementById('market-session-detail').textContent=d.generatedAt?'Summary checked '+utc(d.generatedAt)+'.':'Market session timestamp not supplied.';
   qualityStatus.innerHTML=status(rows.length+' persisted pair quality record(s).','success');
   document.getElementById('market-quality-body').innerHTML=rows.length?rows.map(r=>'<tr><td><strong>'+esc(r.pair)+'</strong></td><td>'+esc(r.status||'NOT VERIFIED')+'</td><td>'+ageLabel(r.ageSeconds)+'</td><td>'+utc(r.lastCandleAt)+'</td><td>'+esc(r.detail||'—')+'</td></tr>').join(''):'<tr><td colspan="5">No quality records yet. Confirm database migrations, provider API key and a successful ingestion run.</td></tr>';
   const select=document.getElementById('market-pair'), previous=select.value, pairs=[...new Set(rows.map(r=>r.pair).filter(Boolean))];
   select.innerHTML=pairs.length?pairs.map(p=>'<option value="'+esc(p)+'">'+esc(p)+'</option>').join(''):'<option value="">No configured pairs</option>';
   if(pairs.includes(previous))select.value=previous;
   if(pairs.length)await loadCandles();else{document.getElementById('market-candle-status').innerHTML=status('No pairs available to query.','error');}
  }catch(e){
   qualityStatus.innerHTML=status('Market data unavailable: '+e.message,'error');
   document.getElementById('market-feed-status').textContent='UNAVAILABLE';
   document.getElementById('market-feed-detail').textContent='Check data-source URL, migrations and backend availability.';
   document.getElementById('market-quality-body').innerHTML='<tr><td colspan="5">No data was fabricated.</td></tr>';
   document.getElementById('market-candle-status').innerHTML=status('Connect the configured data source before candle history can load.','error');
  }
 }
 document.getElementById('market-pair').addEventListener('change',()=>void loadCandles());
 document.getElementById('markets-refresh').addEventListener('click',()=>void load());
 await load();
}
async function overviewPage(){layout('Overview','Your VORTEX command centre. Each workspace has its own page; no long single-page dashboard.',`<section class="cosmic-hero"><div class="hero-copy"><p class="eyebrow">VORTEX SIGNAL INTELLIGENCE</p><h2>Predict the market.<br><em>Learn. Adapt. Evolve.</em></h2><p class="hero-description">Signals, system health, secure data configuration, and operating instructions — organized into separate workspaces.</p><div class="hero-actions"><a class="primary-link" href="./signals.html">Open Signals ↗</a><a class="quiet-link" href="./instructions.html">Instructions</a></div><p class="hero-footnote">INFORMATIONAL ONLY · NO ORDERS ARE PLACED</p></div><div class="planet-art" aria-hidden="true"><div class="planet-ring"></div><div class="planet"></div><span class="orbit-dot"></span></div></section><div class="feature-grid"><article class="feature-card"><h2>Signals</h2><p class="feature-lede">Pair, direction, open time, timeframe, entry, expiry, status and result in a dedicated registry.</p><a class="primary-link" href="./signals.html">View signals ↗</a></article><article class="feature-card"><h2>Secrets & Data</h2><p class="feature-lede">Secure provider-key entry connected to the authenticated worker API.</p><a class="primary-link" href="./secrets.html">Manage keys ↗</a></article><article class="feature-card"><h2>Instructions</h2><p class="feature-lede">Clear setup, operating and troubleshooting steps.</p><a class="primary-link" href="./instructions.html">Read instructions ↗</a></article></div>`);}
async function performancePage(){layout('Performance','Measured outcomes only; unresolved signals are not counted as wins.',card('Performance by pair and strategy',`<p id="performance-status">${status('Loading persisted performance…')}</p><div id="performance-summary" class="feature-grid"></div><h3>By pair</h3><div class="table-scroll"><table><thead><tr><th>Pair</th><th>Settled</th><th>Wins</th><th>Losses</th><th>Draws</th><th>Accuracy</th><th>Avg pips</th></tr></thead><tbody id="performance-pairs"></tbody></table></div><h3>By strategy</h3><div class="table-scroll"><table><thead><tr><th>Strategy</th><th>Settled</th><th>Wins</th><th>Losses</th><th>Draws</th><th>Accuracy</th><th>Avg pips</th></tr></thead><tbody id="performance-strategies"></tbody></table></div><button id="performance-refresh">Refresh performance</button>`));const load=async()=>{const out=document.getElementById('performance-status');out.innerHTML=status('Loading persisted performance…');try{if(typeof relay.performance!=='function')throw new Error('Performance data is not supported by this configured source. Configure the worker endpoint or public performance views.');const r=await relay.performance();if(!r.ok||!r.data)throw new Error(r.error||'Performance endpoint unavailable');const d=r.data;const fmtPct=v=>v==null?'—':(Number(v)<=1?(Number(v)*100):Number(v)).toFixed(1)+'%';const fmtNum=v=>v==null?'—':Number(v).toFixed(2);const render=(rows,id)=>{document.getElementById(id).innerHTML=rows.length?rows.map(x=>'<tr><td>'+esc(x.key)+'</td><td>'+esc(x.settled)+'</td><td>'+esc(x.wins)+'</td><td>'+esc(x.losses)+'</td><td>'+esc(x.draws)+'</td><td>'+esc(fmtPct(x.accuracy))+'</td><td>'+esc(fmtNum(x.avgPips))+'</td></tr>').join(''):'<tr><td colspan="7">No persisted outcomes available. Unresolved signals are not counted as wins or losses.</td></tr>';};render(d.byPair||[],'performance-pairs');render(d.byStrategy||[],'performance-strategies');document.getElementById('performance-summary').innerHTML='<article class="feature-card"><p class="eyebrow">SAMPLE SIZE</p><h2>'+esc(d.sampleSize??'—')+'</h2><p class="feature-lede">Persisted outcomes</p></article><article class="feature-card"><p class="eyebrow">PAIR BREAKDOWNS</p><h2>'+esc((d.byPair||[]).length)+'</h2><p class="feature-lede">In stored results</p></article><article class="feature-card"><p class="eyebrow">STRATEGIES</p><h2>'+esc((d.byStrategy||[]).length)+'</h2><p class="feature-lede">In stored results</p></article>';out.innerHTML=status(d.note||'Loaded persisted performance. Accuracy is based on decisive settled outcomes.', 'success');}catch(e){out.innerHTML=status('Performance unavailable: '+String(e?.message||e),'error');document.getElementById('performance-summary').innerHTML='';for(const id of ['performance-pairs','performance-strategies'])document.getElementById(id).innerHTML='<tr><td colspan="7">No placeholder data shown. Check the configured source and settled-outcome views.</td></tr>';}};document.getElementById('performance-refresh').onclick=load;await load();}
async function genericPage(title,desc,path,headers){layout(title,desc,card(title,`<div id="generic-status">${status('Connecting…')}</div><div class="table-scroll"><table><thead><tr>${headers.map(h=>'<th>'+esc(h)+'</th>').join('')}</tr></thead><tbody id="generic-body"></tbody></table></div><button id="generic-refresh">Refresh</button>`));const load=async()=>{const out=document.getElementById('generic-status'),body=document.getElementById('generic-body');try{let rows=[],note='';
   if(path==='/health'){const r=await relay.health();if(!r.ok||!r.data)throw new Error(r.error||'Health endpoint unavailable');const d=r.data;rows=[{service:d.service,status:d.status,version:d.version,timestamp:d.timestamp}];note=d.ready?'Health endpoint responded.':(d.reasons||[]).join(' ');}
   else if(path==='/api/summary'){const r=await relay.summary();if(!r.ok||!r.data)throw new Error(r.error||'Summary endpoint unavailable');const learning=r.data.learning;if(!learning)throw new Error('Learning history is not available from the configured data source. Configure the public_learning_runs view or worker summary endpoint.');rows=learning.lastRun?[learning.lastRun]:[];note=learning.note||'Learning-run history';}
   else if(path==='/api/performance'){if(typeof relay.performance!=='function')throw new Error('Performance data is not supported by the configured source. Configure the worker performance endpoint or public performance views.');const r=await relay.performance();if(!r.ok||!r.data)throw new Error(r.error||'Performance endpoint unavailable');rows=[...(r.data.byPair||[]).map(x=>({...x,scope:'pair'})),...(r.data.byStrategy||[]).map(x=>({...x,scope:'strategy'}))];note=r.data.note||'Persisted performance records';}
   else if(path==='/admin/status'){const [h,s]=await Promise.all([relay.health(),relay.summary()]);if(!h.ok||!h.data)throw new Error(h.error||'Worker health endpoint unavailable');const d=h.data;const summary=s.ok?s.data:null;rows=[{status:d.status,service:d.service,database:d.database?.detail,workerStatus:summary?.workerStatus||summary?.worker?.liveness||'NOT VERIFIED',lastSuccessfulJob:summary?.lastSuccessfulJob?.jobName||summary?.worker?.lastJob||'—'}];note='Read-only worker status. Delivery-specific configuration requires the authenticated admin API and is not exposed on this public page.';}
   else {throw new Error('Unsupported page data source.');}
   out.innerHTML=status(note||rows.length+' persisted record(s) loaded.',rows.length?'success':'');body.innerHTML=rows.length?rows.map(r=>'<tr>'+headers.map(h=>'<td>'+esc(r[h]??r[h.replace(/ /g,'')]??'—')+'</td>').join('')+'</tr>').join(''):'<tr><td colspan="'+headers.length+'">No persisted records are available. No sample data was fabricated.</td></tr>';
  }catch(e){out.innerHTML=status('Data unavailable: '+String(e?.message||e),'error');body.innerHTML='<tr><td colspan="'+headers.length+'">No placeholder data shown. Check the configured data source and required database views.</td></tr>';}};document.getElementById('generic-refresh').onclick=load;await load();}
function instructionsPage(){layout('Instructions','A dedicated operating guide for safe configuration and reliable signal review.',card('1 · Configure the private worker',`<ol class="instruction-list"><li>Deploy the VORTEX worker/relay on a private server or trusted host; GitHub Pages is a public static site.</li><li>Configure <code>DATABASE_URL</code> using the Supabase session pooler connection string.</li><li>Set <code>VORTEX_SECRET_KEY</code> (32-byte encryption key), <code>VORTEX_ADMIN_TOKEN</code>, and the provider credential in GitHub Actions / worker environment secrets.</li><li>Apply all migrations in <code>supabase/migrations</code>. The provider key table and public read-only views must exist.</li><li>Set the dashboard relay URL to the worker endpoint. Do not place privileged keys in <code>VITE_*</code> variables.</li></ol>`)+card('2 · Save a provider key',`<ol class="instruction-list"><li>Open Secrets & Data.</li><li>Enter the private worker API URL and its admin bearer token.</li><li>Enter a label and provider API key; optionally select verification.</li><li>Save. The worker encrypts the key before inserting it into the database and returns only a masked representation.</li><li>If you see configuration required, configure <code>VORTEX_SECRET_KEY</code> on the server first.</li></ol><a class="primary-link" href="./secrets.html">Open Secrets & Data ↗</a>`)+card('3 · Read and operate signals',`<ol class="instruction-list"><li>Open Signals to view persisted records. An empty table means no qualifying signal has been published; no sample signal is fabricated.</li><li>Review pair, direction, scheduled open time (UTC), status and outcome. Timeframe, entry price or expiry show only if the engine API returns them.</li><li>Use the repository’s GitHub Actions workflow to request a scan. A workflow run is a one-shot job, not a persistent daemon.</li><li>Do not treat ranking confidence as win probability or informational signals as financial advice.</li></ol><a class="primary-link" href="./signals.html">Open Signals ↗</a>`)+card('4 · Troubleshooting',`<ul class="instruction-list"><li><strong>401/403:</strong> check the admin bearer token and permissions.</li><li><strong>503 encryption configuration:</strong> set <code>VORTEX_SECRET_KEY</code> on the worker.</li><li><strong>Database table missing:</strong> apply migrations before retrying.</li><li><strong>No signals:</strong> inspect market-data freshness, provider quota, scan logs and qualification gates. Never enable synthetic signals to fill the page.</li><li><strong>Browser can’t connect:</strong> verify relay URL, HTTPS, CORS and worker availability.</li></ul>`));}
async function integrationsPage() {
 layout('Plugins & MCP','Connect the AI Operator to server-configured integrations. Privileged access is session-only; no token is saved in browser storage.',card('Authenticated backend',`<label>VORTEX admin bearer token (kept only in this page session)<input id="integrations-token" type="password" autocomplete="off" placeholder="Enter VORTEX_ADMIN_TOKEN"></label><p class="page-note">The token is sent only to the configured VORTEX relay over HTTPS. Never paste it into prompts or share it. MCP server URLs and credentials are configured on the backend, not here.</p><button id="integrations-load">Load plugins and commands</button><p id="integrations-status">${status('Enter the backend admin token to load integrations.')}</p>`) +
 card('Plugin registry',`<div id="integrations-plugins" class="page-note">Not loaded.</div>`) +
 card('Allowlisted commands',`<label>Read-only command<select id="integrations-command"><option value="">Load commands first</option></select></label><button id="integrations-run-command" disabled>Run selected read-only command</button><pre id="integrations-command-result" class="code-panel">No command run.</pre>`) +
 card('MCP tools',`<div class="row-fields"><label>Configured server<select id="integrations-server"><option value="">Load plugins first</option></select></label><button id="integrations-discover" disabled>Discover tools</button></div><label>Allowlisted read-only tool<select id="integrations-tool"><option value="">Discover tools first</option></select></label><label>Tool arguments (JSON object)<textarea id="integrations-args" rows="4">{}</textarea></label><button id="integrations-call" disabled>Call selected read-only tool</button><pre id="integrations-tool-result" class="code-panel">No tool call.</pre><p class="page-note">Only tools explicitly allowlisted as read-only by the server administrator can be called. Discovery does not grant permission. Review upstream tool behavior before allowlisting.</p>`));
 const tokenEl=document.getElementById('integrations-token');
 const statusEl=document.getElementById('integrations-status');
 const pluginsEl=document.getElementById('integrations-plugins');
 const commandSelect=document.getElementById('integrations-command');
 const serverSelect=document.getElementById('integrations-server');
 const toolSelect=document.getElementById('integrations-tool');
 const commandButton=document.getElementById('integrations-run-command');
 const discoverButton=document.getElementById('integrations-discover');
 const callButton=document.getElementById('integrations-call');
 const adminApi=(path,opts={})=>{const token=tokenEl.value.trim();if(!token)throw new Error('Enter the VORTEX admin token first.');return api(path,{...opts,token});};
 const option=(select,value,label)=>{const el=document.createElement('option');el.value=value;el.textContent=label;select.appendChild(el);};
 document.getElementById('integrations-load').addEventListener('click',async()=>{
  statusEl.textContent='Loading backend registry…';
  try{
   const [pluginData,commandData]=await Promise.all([adminApi('/admin/operator/plugins'),adminApi('/admin/operator/commands')]);
   pluginsEl.textContent=JSON.stringify(pluginData,null,2);
   commandSelect.replaceChildren();option(commandSelect,'','Choose a read-only command');
   for(const command of commandData.commands||[])option(commandSelect,command.id,command.label+' ('+command.id+')');
   commandButton.disabled=!(commandData.commands||[]).length;
   serverSelect.replaceChildren();option(serverSelect,'','Choose a configured MCP server');
   for(const server of pluginData.mcpServers||[])option(serverSelect,server.id,server.name+' — '+(server.enabled?'enabled':'disabled'));
   discoverButton.disabled=!(pluginData.mcpServers||[]).some(server=>server.enabled);
   statusEl.textContent='Loaded '+(pluginData.plugins||[]).length+' plugin descriptors and '+(pluginData.mcpServers||[]).length+' configured MCP servers.';
  }catch(e){statusEl.textContent='Could not load registry: '+String(e?.message||e);}
 });
 commandButton.addEventListener('click',async()=>{
  const id=commandSelect.value;if(!id)return;
  if(!confirm('Run '+id+'? This command is allowlisted as read-only.'))return;
  commandButton.disabled=true;
  try{const result=await adminApi('/admin/operator/commands/'+encodeURIComponent(id)+'/run',{method:'POST',body:'{}'});document.getElementById('integrations-command-result').textContent=JSON.stringify(result,null,2);}
  catch(e){document.getElementById('integrations-command-result').textContent='Command failed: '+String(e?.message||e);}
  finally{commandButton.disabled=false;}
 });
 discoverButton.addEventListener('click',async()=>{
  const id=serverSelect.value;if(!id)return;
  discoverButton.disabled=true;toolSelect.replaceChildren();option(toolSelect,'','Discovering…');callButton.disabled=true;
  try{
   const result=await adminApi('/admin/operator/mcp/'+encodeURIComponent(id)+'/tools');
   toolSelect.replaceChildren();option(toolSelect,'','Choose an allowlisted read-only tool');
   const allowed=new Set(result.allowedReadOnlyTools||[]);
   for(const tool of result.tools||[])if(allowed.has(tool.name))option(toolSelect,tool.name,tool.name+' — allowlisted');
   document.getElementById('integrations-tool-result').textContent=JSON.stringify({server:result.server,discovered:(result.tools||[]).map(t=>({name:t.name,description:t.description,allowlisted:allowed.has(t.name)})),allowedReadOnlyTools:result.allowedReadOnlyTools||[]},null,2);
   callButton.disabled=!allowed.size;
   if(!allowed.size)statusEl.textContent='Tools discovered, but no tool is allowlisted. Review tool descriptions and configure readOnlyTools on the server.';
  }catch(e){toolSelect.replaceChildren();option(toolSelect,'','Discovery failed');document.getElementById('integrations-tool-result').textContent='Tool discovery failed: '+String(e?.message||e);}
  finally{discoverButton.disabled=false;}
 });
 toolSelect.addEventListener('change',()=>{callButton.disabled=!toolSelect.value;});
 callButton.addEventListener('click',async()=>{
  const server=serverSelect.value,toolName=toolSelect.value;if(!server||!toolName)return;
  let args;try{args=JSON.parse(document.getElementById('integrations-args').value||'{}');if(!args||typeof args!=='object'||Array.isArray(args))throw new Error('Arguments must be a JSON object.');}catch(e){statusEl.textContent='Invalid arguments: '+String(e?.message||e);return;}
  if(!confirm('Call allowlisted read-only tool '+server+':'+toolName+'?'))return;
  callButton.disabled=true;
  try{const result=await adminApi('/admin/operator/mcp/'+encodeURIComponent(server)+'/call',{method:'POST',body:JSON.stringify({toolName,arguments:args})});document.getElementById('integrations-tool-result').textContent=JSON.stringify(result,null,2);}
  catch(e){document.getElementById('integrations-tool-result').textContent='Tool call failed: '+String(e?.message||e);}
  finally{callButton.disabled=false;}
 });
}
if(page==='signals.html') void signalsPage();
else if(page==='secrets.html') void secretsPage();
else if(page==='instructions.html') instructionsPage();
else if(page==='markets.html') void marketsPage();
else if(page==='learning.html') void genericPage('AI Learning','Recorded learning runs and model registry data.','/api/summary',['lastJob','workerStatus','generatedAt']);

else if(page==='performance.html') void performancePage();
else if(page==='system.html') void genericPage('System Health','Health checks from the configured VORTEX worker.','/health',['service','status','version','timestamp']);
else if(page==='operator.html') layout('AI Operator','A root-level assistant for read-only VORTEX diagnostics and reviewed engineering plans.',card('Local model setup',`<p class="page-note">Open the AI Operator button in the lower corner from any workspace. On Android, a 4B quantized model is a sensible first test with 16 GB RAM, but sustained speed depends on the phone chipset and memory pressure.</p><ol class="instruction-list"><li>Install a trusted Android inference runtime or use Termux with a llama.cpp OpenAI-compatible server.</li><li>Download a Qwen3 4B instruct GGUF in a quantization that fits your device (Q4 is a reasonable starting point).</li><li>Run the server bound to loopback only, not 0.0.0.0, and use its chat-completions endpoint.</li><li>Set the endpoint and exact model identifier in the AI Operator panel.</li><li>Test with “Inspect VORTEX status” and then ask for an explanation. If the browser blocks requests, do not expose the model port publicly; use a trusted same-origin private backend bridge.</li></ol><p class="page-note">The model is advisory by default. If you provide the backend admin token for this session, it can request the built-in read-only diagnostics and MCP tools explicitly allowlisted on the server; every tool call requires confirmation. It cannot run shell commands, merge PRs, dispatch workflows, modify files, trade, or access secret-management endpoints. Configure integrations in the <a href="./integrations.html">Plugins &amp; MCP Manager</a>. The backend enforces allowlists and audit logging.</p><p><a href="https://github.com/ggerganov/llama.cpp" target="_blank" rel="noreferrer">llama.cpp server documentation ↗</a></p>`));
else if(page==='integrations.html') void integrationsPage();
else if(page==='settings.html') { layout('Settings','Connection state and configuration guidance.',card('Public data connection',`<p class="page-note">The dashboard reads public, secret-free views through the configured relay, Supabase, or snapshot source. Privileged credentials must never be embedded in the public frontend.</p><p id="settings-status">${status('Checking configured data source…')}</p><div id="settings-details"></div><button id="settings-refresh">Refresh connection</button>`));const load=async()=>{const out=document.getElementById('settings-status'),details=document.getElementById('settings-details');out.innerHTML=status('Checking configured data source…');details.textContent='';try{const r=await relay.health();if(!r.ok||!r.data)throw new Error(r.error||'No health response from the configured data source.');const d=r.data;const healthy=Boolean(d.ready)||String(d.status||'').toLowerCase()==='ok'||String(d.status||'').toLowerCase()==='healthy';out.innerHTML=status('Data source reachable: '+(d.status||'response received')+'. '+(d.note||''),healthy?'success':'');details.innerHTML='<p class="page-note">Source: '+esc(r.kind||'configured relay')+' · Service: '+esc(d.service||'VORTEX')+' · Database: '+esc(d.database?.status||d.database?.detail||'not reported')+'</p>'+(Array.isArray(d.reasons)&&d.reasons.length?'<ul>'+d.reasons.map(x=>'<li>'+esc(x)+'</li>').join('')+'</ul>':'');}catch(e){out.innerHTML=status('Connection unavailable: '+String(e?.message||e),'error');details.innerHTML='<p class="page-note">Verify the relay URL, Supabase public credentials/views, or the generated snapshot artifact. Do not add admin tokens or database passwords to this public page.</p>';}};document.getElementById('settings-refresh').onclick=load;void load();}
else if(page==='index.html') void overviewPage();
