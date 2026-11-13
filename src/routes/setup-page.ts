/** Self-contained setup wizard (no external assets). All data goes through the admin JSON API. */
export function setupPage(): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>hermesQ · Setup</title>
<style>
body{font-family:system-ui,sans-serif;max-width:52rem;margin:2rem auto;padding:0 1rem;color:#1d1d1f}
h1{font-size:1.5rem}h2{font-size:1.1rem;margin-top:2rem;border-bottom:1px solid #ddd;padding-bottom:.3rem}
code,input{font-family:ui-monospace,monospace;font-size:.85rem}input[type=password],input[type=text]{width:100%;padding:.35rem;box-sizing:border-box}
table{border-collapse:collapse;width:100%}td,th{text-align:left;padding:.3rem;border-bottom:1px solid #eee;vertical-align:top}
button{padding:.35rem .8rem;margin:.15rem;cursor:pointer}.ok{color:#127a2e}.warn{color:#b26a00}.err{color:#b3261e}
#msg{min-height:1.2rem}
</style></head><body>
<h1>hermesQ · Setup</h1>
<p>Enter the <code>ADMIN_TOKEN</code> you set when you deployed. It stays in this browser tab only.</p>
<form id="login"><input id="token" type="password" placeholder="ADMIN_TOKEN" autocomplete="off"><button>Open</button></form>
<p id="msg"></p>
<div id="app" hidden>
<h2>1. Hermes poller</h2>
<p>Point the Hermes plugin at <code id="hermesUrl"></code> and give it the shared secret below.</p>
<p>Shared secret: <span id="hermesState"></span> <button id="genHermes" type="button">Generate new secret</button></p>
<p id="hermesValue" hidden>Copy now, it is shown once: <code id="hermesSecret"></code></p>
<h2>2. Webhooks</h2>
<p>Paste each URL into the provider and save the signing secret it gives you. A Worker secret with the same name overrides what you type here.</p>
<table id="hooks"><tr><th>Service</th><th>Webhook URL</th><th>Signing secret</th></tr></table>
<h2>3. OAuth connections</h2>
<p>Create an OAuth app at the provider with the redirect URL <code id="callback"></code>, then save its client id and secret and connect.</p>
<table id="oauth"><tr><th>Service</th><th>Client</th><th>Status</th><th></th></tr></table>
</div>
<script>
const $=(id)=>document.getElementById(id);
const HOOKS={github:'GITHUB_WEBHOOK_SECRET',linear:'LINEAR_WEBHOOK_SECRET',stripe:'STRIPE_WEBHOOK_SECRET',slack:'SLACK_SIGNING_SECRET'};
let token=sessionStorage.getItem('wt_admin')||'';
function say(t,cls){const m=$('msg');m.textContent=t;m.className=cls||'';}
async function api(path,opts={}){
  const r=await fetch(path,{...opts,headers:{'authorization':'Bearer '+token,'content-type':'application/json'}});
  const j=await r.json().catch(()=>({}));
  if(!r.ok)throw new Error(j.detail||j.error||('HTTP '+r.status));
  return j;
}
function el(tag,text,cls){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;}
function srcLabel(s){return s?('set ('+s+')'):'not set';}
async function save(name,value){await api('/setup/secrets',{method:'POST',body:JSON.stringify({[name]:value})});say(name+' saved','ok');await load();}
function secretCell(name,source){
  const td=el('td');td.appendChild(el('div',srcLabel(source),source?'ok':'warn'));
  const i=el('input');i.type='password';i.placeholder=name;td.appendChild(i);
  const b=el('button','Save');b.type='button';b.onclick=()=>save(name,i.value).catch(e=>say(e.message,'err'));td.appendChild(b);return td;
}
async function load(){
  const s=await api('/setup/state');
  $('app').hidden=false;
  const src=Object.fromEntries(s.secrets.map(x=>[x.name,x.source]));
  $('hermesUrl').textContent=s.urls.hermes;$('callback').textContent=s.urls.oauthCallback;
  $('hermesState').textContent=srcLabel(src.HERMES_WEBHOOK_SECRET);$('hermesState').className=src.HERMES_WEBHOOK_SECRET?'ok':'warn';
  const hooks=$('hooks');while(hooks.rows.length>1)hooks.deleteRow(1);
  for(const [svc,name] of Object.entries(HOOKS)){const tr=hooks.insertRow();tr.appendChild(el('td',svc));tr.appendChild(el('td')).appendChild(el('code',s.urls[svc]));tr.appendChild(secretCell(name,src[name]));}
  const oa=$('oauth');while(oa.rows.length>1)oa.deleteRow(1);
  for(const h of s.oauth){
    const up=h.service.toUpperCase();const tr=oa.insertRow();tr.appendChild(el('td',h.service));
    const c=el('td');c.appendChild(secretCell(up+'_CLIENT_ID',src[up+'_CLIENT_ID']));c.appendChild(secretCell(up+'_CLIENT_SECRET',src[up+'_CLIENT_SECRET']));tr.appendChild(c);
    const st=h.connected?(h.needs_reconnect?'reconnect needed':(h.last_refresh_error?('error: '+h.last_refresh_error):'connected')):'not connected';
    const td=el('td',st,h.connected&&!h.needs_reconnect&&!h.last_refresh_error?'ok':'warn');
    if(h.expires_at)td.appendChild(el('div','expires '+new Date(h.expires_at).toLocaleString()));tr.appendChild(td);
    const act=el('td');
    const go=async(p)=>{const r=await api(p,{method:'POST',body:JSON.stringify({service:h.service})});if(r.authorizeUrl)location.href=r.authorizeUrl;else{say(h.service+': done','ok');await load();}};
    const btn=(t,p)=>{const b=el('button',t);b.type='button';b.onclick=()=>go(p).catch(e=>say(e.message,'err'));act.appendChild(b);};
    if(!h.connected)btn('Connect','/setup/start');else{btn('Refresh','/oauth/refresh?service='+h.service);btn('Reconnect','/oauth/reconnect?service='+h.service);btn('Disconnect','/oauth/disconnect?service='+h.service);}
    tr.appendChild(act);
  }
}
$('genHermes').onclick=async()=>{try{const r=await api('/setup/generate',{method:'POST',body:JSON.stringify({name:'HERMES_WEBHOOK_SECRET'})});$('hermesSecret').textContent=r.value;$('hermesValue').hidden=false;await load();}catch(e){say(e.message,'err');}};
$('login').onsubmit=async(e)=>{e.preventDefault();token=$('token').value;sessionStorage.setItem('wt_admin',token);try{await load();say('');}catch(err){say(err.message,'err');}};
if(token)load().catch(e=>say(e.message,'err'));
</script></body></html>`;
}
