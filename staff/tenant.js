/* CBS Employee Management (staff app): multi-tenant layer.
   Loaded as the LAST script in staff/index.html. It replaces local/Supabase-auth storage with the cbs-biz edge function.
   Business comes from the link: /staff/?b=<business-id>. Sign-in = staff key (once per device) + ID/PIN.
   Settings (owner only): "Send payslips from your own email" (own mailbox, saved on the server)
                          "Automatic backup" (every 30 minutes to a folder the owner chooses on their PC). */
(()=>{
const URL0='https://hrnrmojaaxyfmdnmsokc.supabase.co',ANON='';/* ANON optional: anon key of the NEW project */
const FN=URL0+'/functions/v1/cbs-biz';
document.title='CBS Employee Management';
const P=new URLSearchParams(location.search);
const BIZ=(P.get('b')||localStorage.cbs_biz||'').toLowerCase().replace(/[^a-z0-9-]/g,'');
if(P.get('b')&&BIZ)localStorage.cbs_biz=BIZ;
const KEYK='cbs_key_'+BIZ;
let TOK=null,INFO=null,NAME='';
let MB,MBL=0;/* MB: undefined = not loaded yet, null = no mailbox saved, object = saved mailbox (never contains the password) */
const BKMS=30*60e3,KEEP=200,PFX='cbsystem-'+BIZ+'-',BKK='cbs_bk_'+BIZ;
let BK={h:null,last:0,need:false,err:'',busy:0};/* BK.h = the backup folder the owner chose; BK.need = browser wants the owner to click once to allow it again */
/* lets the main page know a session is active, so auto-sync runs */
window.cbsLive=()=>!!TOK;

/* never show another business's cached data */
const blank=()=>({cfg:{...CFG0,code:BIZ,sb:{on:0,url:'',key:''}},rows:[]});
if(localStorage.cbs_tenant!==BIZ)localStorage.removeItem(LS);
localStorage.cbs_tenant=BIZ;
D=blank();

async function call(body){
  let r,j={};
  try{r=await fetch(FN,{method:'POST',headers:{'Content-Type':'application/json',...(ANON?{apikey:ANON}:{})},body:JSON.stringify(body)})}
  catch(e){throw new Error('No connection')}
  try{j=await r.json()}catch(e){}
  if(!r.ok){
    if(r.status==401&&TOK){TOK=null;me=null;toast('Session expired, sign in again');login()}
    throw new Error(j.error||'Error '+r.status)}
  return j}

/* storage */
initSB=function(){sb=null};
pull=async function(){
  const j=await call({a:'pull',token:TOK});
  D.rows=j.rows.map(x=>({...x.data,id:x.id,t:x.tbl}));
  const c=R('cfg')[0];
  D.cfg={...CFG0,...(c?c.cfg:D.cfg),code:BIZ,sb:{on:0,url:'',key:''}};
  if(!c&&NAME)D.cfg.venue=NAME;
  save()};
put=function(r){
  D.rows=D.rows.filter(x=>x.id!=r.id);D.rows.push(r);save();
  call({a:'put',token:TOK,row:r}).catch(e=>toast(e.message))};
rm=function(id){
  D.rows=D.rows.filter(x=>x.id!=id);save();
  call({a:'del',token:TOK,id}).catch(e=>toast(e.message))};
mail=async function(sl){
  const c=C().mail,pdf=c.attach?slipPdf(sl).split(',')[1]:null,
  html=`<p>Hi ${esc(sl.name.split(' ')[0])},</p><p>Your payslip for ${esc(sl.lbl)} is ready${pdf?' (attached)':''}. Net pay: <b>${gbp(sl.net)}</b>.</p><p>You can download it any time in CBS Employee Management under Pay.</p>`;
  await call({a:'mail',token:TOK,to:sl.pe,replyTo:(c.replyTo||'').trim()||undefined,subject:'Your payslip: '+sl.lbl,html,pdf,name:'payslip-'+sl.lbl.replace(/\W+/g,'-')+'.pdf'})};

/* sign-in screens */
function keyScreen(){
  A(`<div class=lgn>${brand(1)}<h2 style="text-align:center">Staff key</h2><p class=mu style="text-align:center">Enter the staff key from your manager. You only do this once on this device.</p><input id=sk placeholder="Staff key" autocapitalize=characters autocomplete=off><button onclick="tSaveKey()">Continue</button></div>`)}
login=function(){
  if(!BIZ)return A(`<div class=lgn><h2>No business selected</h2><p class=mu>Open the staff link your supplier sent you. It ends in <b>?b=your-business</b>.</p></div>`);
  if(INFO===null){
    INFO={};
    call({a:'info',b:BIZ}).then(j=>{INFO=j;NAME=j.name;C().venue=j.name;C().logo=j.logo||'';if($('#lid')&&!$('#lid').value||$('#sk')&&!$('#sk').value)login()})
      .catch(e=>{INFO={err:1};toast(e.message)})}
  if(!localStorage[KEYK])return keyScreen();
  A(`<div class=lgn>${brand(1)}<select id=lr onchange="$('#lid').style.display=this.value=='s'?'':'none'"><option value=s>Staff</option><option value=m>Manager</option><option value=o>Owner</option></select><input id=lid inputmode=numeric maxlength=4 placeholder="4-digit ID" autocomplete=username><input id=pw type=password inputmode=numeric maxlength=6 placeholder="6-digit PIN" autocomplete=current-password><button onclick="tLogin()">Sign in</button><a class=mu onclick="localStorage.removeItem('${KEYK}');login()">Change staff key</a></div>`)};
window.tSaveKey=()=>{const k=$('#sk').value.trim().toUpperCase();if(k.length<20)return toast('Check the staff key');localStorage[KEYK]=k;login()};
window.tLogin=async()=>{
  const role=$('#lr').value,id=$('#lid').value.trim(),pin=$('#pw').value;
  if(role=='s'&&!/^\d{4}$/.test(id))return toast('ID is 4 digits');
  if(!/^\d{6}$/.test(pin))return toast('PIN is 6 digits');
  try{
    const j=await call({a:'login',b:BIZ,key:localStorage[KEYK],role,id,pin});
    TOK=j.token;NAME=j.name;MB=undefined;await pull();start(j.user,0);bkInit()}
  catch(e){
    if(/staff key/i.test(e.message)){localStorage.removeItem(KEYK);toast(e.message);return keyScreen()}
    toast(e.message)}};
out=function(){TOK=null;me=null;INFO=null;MB=undefined;BK={h:null,last:0,need:false,err:'',busy:0};D=blank();localStorage.removeItem(LS);login()};

/* Owner/Manager: Settings is owner-only; hide cloud/demo bits that don't apply */
const F0=frame;
frame=function(){
  if(me&&me.role=='m'&&!me.owner&&tab=='set')tab='home';
  F0();
  if(!me)return;
  bkTop();
  const top=$('.top');
  if(top&&!$('#rf')){const b=document.createElement('button');b.id='rf';b.className='s sm';b.textContent='↻';b.title='Refresh';
    b.onclick=()=>pull().then(frame).catch(e=>toast(e.message));top.insertBefore(b,top.lastElementChild)}
  if(me.role=='m'&&!me.owner)document.querySelectorAll('.tabs a').forEach(a=>{if(a.textContent.trim()=='Settings')a.remove()});
  document.querySelectorAll('#v .card').forEach(c=>{
    const b=c.querySelector(':scope>b'),t=b?b.textContent:'';
    if(/^(Database|Security)/.test(t))c.remove();
    if(/^Backup/.test(t))c.querySelectorAll('button,input').forEach(x=>{if(/^(Import|Reset demo)/.test(x.textContent)||x.id=='imp')x.remove()});
    if(/^Venue/.test(t))c.querySelectorAll('.f').forEach(f=>{if(/^(Login email domain|Venue code)/.test(f.textContent))f.remove()})});
  /* owner on Settings: load the saved-mailbox status once, then redraw */
  if(me.owner&&tab=='set'){
    if(MB===undefined&&!MBL){MBL=1;
      call({a:'smtpinfo',token:TOK}).then(j=>{MB=j.smtp||null}).catch(()=>{MB=null})
        .finally(()=>{MBL=0;if(me&&tab=='set')frame()})}
    /* keep the old "sent through our mail service" note truthful once a mailbox is connected */
    if(MB)document.querySelectorAll('#v p.mu').forEach(p=>{
      if(/through our mail service/i.test(p.textContent))
        p.textContent='Payslips are sent from '+MB.user+' (your own mailbox) under the name "'+C().venue+'". When staff reply, it goes to the reply-to address above, or to '+MB.user+' if that is blank. Staff need a personal email on their record.'})}};

/* ---------- Settings: payslip mailbox (owner only; the password never comes back to the browser) ---------- */
const bad=e=>alert(e&&e.message?e.message:String(e));
function mbCard(){
  const head=`<div class=card style="margin-top:12px"><b>Send payslips from your own email</b>`;
  if(MB===undefined)return head+`<p class=mu style="margin:6px 0">Loading…</p></div>`;
  if(MB)return head+`<p class=mu style="margin:6px 0">Connected. Payslips are sent from <b>${esc(MB.user)}</b> (${esc(MB.host)}, port ${esc(MB.port)}).</p>
  <div class=f><span>Send a test to</span><input id=mt type=email placeholder="you@example.com"><button class="s sm" onclick="tMbTest()">Test</button></div>
  <p style="margin-top:10px"><button class="s sm" onclick="tMbDel()">Remove mailbox</button></p></div>`;
  return head+`<p class=mu style="margin:6px 0">Connect your own mailbox so payslips arrive from your address. Use an <b>app password</b>, not your normal password. Gmail: turn on 2-step verification, then create an app password in your Google account. Outlook / Hotmail: Security &gt; App passwords. Your password is stored encrypted on the server.</p>
  <div class=f><span>Provider</span><select onchange="tMbPreset(this.value)"><option value="">Choose…</option><option value=g>Gmail</option><option value=o>Outlook / Hotmail</option><option value=y>Yahoo</option><option value=x>Other / own domain</option></select></div>
  <div class=f><span>Mail server</span><input id=mh placeholder="smtp.gmail.com" autocomplete=off></div>
  <div class=f><span>Port (465 or 587)</span><input id=mp type=number value=465></div>
  <div class=f><span>Email address</span><input id=mu type=email placeholder="you@gmail.com" autocomplete=off></div>
  <div class=f><span>App password</span><input id=mw type=password autocomplete=new-password></div>
  <p style="margin-top:10px"><button onclick="tMbSave()">Save &amp; check</button></p></div>`}
window.tMbPreset=v=>{
  const p={g:['smtp.gmail.com',465],o:['smtp-mail.outlook.com',587],y:['smtp.mail.yahoo.com',465]}[v];
  if(p){$('#mh').value=p[0];$('#mp').value=p[1]}};
window.tMbSave=async()=>{
  const host=$('#mh').value.trim(),port=+$('#mp').value,user=$('#mu').value.trim(),pass=$('#mw').value;
  if(!host||!port||!user||!pass)return toast('Fill in every box');
  toast('Checking your mailbox…');
  try{await call({a:'smtpset',token:TOK,host,port,user,pass});MB={host,port,user};toast('Mailbox connected');frame()}
  catch(e){bad(e)}};
window.tMbTest=async()=>{
  const to=$('#mt').value.trim();if(!to)return toast('Enter an email to send the test to');
  toast('Sending test…');
  try{await call({a:'smtptest',token:TOK,to});toast('Test sent. Check that inbox')}catch(e){bad(e)}};
window.tMbDel=async()=>{
  if(!confirm('Remove this mailbox? Payslips will stop sending from it.'))return;
  try{await call({a:'smtpset',token:TOK,clear:1});MB=null;toast('Mailbox removed');frame()}catch(e){bad(e)}};

/* ---------- Automatic backup: every 30 minutes to a folder chosen on this PC (owner only) ----------
   Uses the browser's folder access (Chrome / Edge on a computer). The page must stay open and the owner signed in.
   Choose a folder inside OneDrive / Google Drive / Dropbox to get a cloud copy as well. */
const bkOK=()=>'showDirectoryPicker' in window;
const idb=()=>new Promise((res,rej)=>{const r=indexedDB.open('cbs_bk',1);r.onupgradeneeded=()=>r.result.createObjectStore('h');r.onsuccess=()=>res(r.result);r.onerror=()=>rej(r.error)});
const idbGet=async k=>{const d=await idb();return new Promise((res,rej)=>{const q=d.transaction('h').objectStore('h').get(k);q.onsuccess=()=>res(q.result);q.onerror=()=>rej(q.error)})};
const idbSet=async(k,v)=>{const d=await idb();return new Promise((res,rej)=>{const t=d.transaction('h','readwrite');t.objectStore('h').put(v,k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error)})};
const idbDel=async k=>{const d=await idb();return new Promise((res,rej)=>{const t=d.transaction('h','readwrite');t.objectStore('h').delete(k);t.oncomplete=()=>res();t.onerror=()=>rej(t.error)})};
const bkName=()=>{const d=new Date();return PFX+d.getFullYear()+pad(d.getMonth()+1)+pad(d.getDate())+'-'+pad(d.getHours())+pad(d.getMinutes())+'.json'};
const bkJson=()=>JSON.stringify({app:'cbsystem-clock',v:1,biz:BIZ,venue:C().venue,at:new Date().toISOString(),rows:D.rows});
async function bkInit(){
  try{BK.last=(JSON.parse(localStorage[BKK]||'{}')).last||0;
    if(bkOK()){BK.h=(await idbGet('dir_'+BIZ))||null;
      if(BK.h)BK.need=(await BK.h.queryPermission({mode:'readwrite'}))!=='granted'}}
  catch(e){BK.h=null}
  bkUi()}
async function bkPrune(){const names=[];for await(const[n,e] of BK.h.entries())if(e.kind==='file'&&n.startsWith(PFX)&&n.endsWith('.json'))names.push(n);
  names.sort();while(names.length>KEEP)await BK.h.removeEntry(names.shift())}
async function bkRun(manual){
  if(!BK.h||BK.busy)return;BK.busy=1;
  try{
    let p=await BK.h.queryPermission({mode:'readwrite'});
    if(p!=='granted'&&manual)p=await BK.h.requestPermission({mode:'readwrite'});
    if(p!=='granted'){BK.need=true;if(manual)toast('Allow access to the backup folder to continue');return}
    BK.need=false;
    const f=await BK.h.getFileHandle(bkName(),{create:true}),w=await f.createWritable();
    await w.write(bkJson());await w.close();
    BK.last=Date.now();BK.err='';localStorage[BKK]=JSON.stringify({last:BK.last});
    await bkPrune();
    if(manual)toast('Backup saved')}
  catch(e){BK.err='Backup failed: '+(e&&e.message?e.message:e)}
  finally{BK.busy=0;bkUi()}}
function bkTick(){if(!TOK||!me||!me.owner||!BK.h||BK.busy)return;if(Date.now()-BK.last<BKMS)return;bkRun(0)}
function bkStatus(){
  if(!bkOK())return 'This browser cannot save to a folder automatically. Use Chrome or Edge on a computer. You can still download a backup file with the button below.';
  if(!BK.h)return 'Automatic backup is <b>off</b>. Choose a folder to switch it on.';
  const when=BK.last?new Date(BK.last).toLocaleString('en-GB',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'not yet';
  return 'Automatic backup is <b>on</b>. Folder: <b>'+esc(BK.h.name)+'</b> · Last backup: <b>'+when+'</b>'
    +(BK.need?'<br><span style="color:var(--ac2)">Paused: click Back up now once to let the browser use this folder again.</span>':'')
    +(BK.err?'<br><span style="color:var(--rd)">'+esc(BK.err)+'</span>':'')}
function bkUi(){const e=$('#bkst');if(e)e.innerHTML=bkStatus();bkTop()}
function bkTop(){const top=$('.top');if(!top)return;let b=$('#bkp');const show=!!(me&&me.owner&&BK.h&&BK.need);
  if(show&&!b){b=document.createElement('button');b.id='bkp';b.className='s sm';b.textContent='💾 Resume backup';b.onclick=()=>tBkNow();top.insertBefore(b,top.lastElementChild)}
  else if(!show&&b)b.remove()}
function bkCard(){return `<div class=card style="margin-top:12px"><b>Automatic backup</b>
  <p class=mu style="margin:6px 0">Saves a full copy of your staff, hours, holidays, payslips and settings to a folder on this computer every 30 minutes, while this page is open and you are signed in as Owner. For a cloud copy, choose a folder inside OneDrive, Google Drive or Dropbox. The newest ${KEEP} files are kept. Backups contain staff PINs and pay details, so pick a private folder.</p>
  <p class=mu id=bkst style="margin:6px 0">${bkStatus()}</p>
  <p style="margin-top:8px;display:flex;gap:8px;flex-wrap:wrap">${bkOK()?'<button class="s sm" onclick="tBkPick()">Choose backup folder</button>':''}${BK.h?'<button class="s sm" onclick="tBkNow()">Back up now</button><button class="s sm" onclick="tBkStop()">Stop</button>':''}<button class="s sm" onclick="tBkDl()">Download backup file</button><button class="s sm" onclick="tBkRestore()">Restore from file</button></p></div>`}
window.tBkPick=async()=>{
  try{const h=await showDirectoryPicker({id:'cbsbackup',mode:'readwrite'});BK.h=h;await idbSet('dir_'+BIZ,h);BK.need=false;BK.err='';await bkRun(1);if(tab=='set')frame()}
  catch(e){if(e&&e.name!=='AbortError')bad(e)}};
window.tBkNow=()=>bkRun(1);
window.tBkStop=async()=>{
  if(!confirm('Stop automatic backups? Files already saved in the folder are not deleted.'))return;
  try{await idbDel('dir_'+BIZ)}catch(e){}
  BK.h=null;BK.need=false;BK.err='';if(tab=='set')frame();else bkUi()};
window.tBkDl=()=>{dl(bkName(),bkJson(),'application/json');toast('Backup downloaded')};
window.tBkRestore=()=>{
  const i=document.createElement('input');i.type='file';i.accept='.json,application/json';
  i.onchange=async()=>{const f=i.files[0];if(!f)return;let j;
    try{j=JSON.parse(await f.text())}catch(e){return bad('That file is not a valid backup.')}
    if(!j||j.app!=='cbsystem-clock'||!Array.isArray(j.rows))return bad('That is not a CBS Employee Management backup file.');
    if(j.biz&&j.biz!==BIZ)return bad('This backup belongs to a different business ('+j.biz+').');
    const rows=j.rows.filter(r=>r&&r.id&&r.t);
    if(!confirm('Restore '+rows.length+' records from the backup made '+(j.at?new Date(j.at).toLocaleString('en-GB'):'earlier')+'?\n\nRecords with the same ID are overwritten with the backup version. Nothing is deleted.'))return;
    let done=0,fail=0;toast('Restoring…');
    for(let k=0;k<rows.length;k+=6)await Promise.all(rows.slice(k,k+6).map(r=>call({a:'put',token:TOK,row:r}).then(()=>done++).catch(()=>fail++)));
    try{await pull()}catch(e){}
    frame();toast('Restored '+done+(fail?' · '+fail+' failed':''))};
  i.click()};

const S0=V.set;
V.set=function(){
  return S0().replace('?clock=','?b='+BIZ+'&amp;clock=')+
  (me&&me.owner?mbCard()+bkCard():'')+
  `<div class=card style="margin-top:12px"><b>Owner &amp; Manager PINs</b><p class=mu style="margin:4px 0">6 digits each. Change both when you first sign in.</p>
  <div class=f><span>Owner PIN</span><input id=po type=password inputmode=numeric maxlength=6 placeholder="new 6 digits"><button class="s sm" onclick="tPin('owner','po')">Change</button></div>
  <div class=f><span>Manager PIN</span><input id=pm type=password inputmode=numeric maxlength=6 placeholder="new 6 digits"><button class="s sm" onclick="tPin('manager','pm')">Change</button></div></div>`};
window.tPin=async(w,id)=>{
  const p=$('#'+id).value.trim();if(!/^\d{6}$/.test(p))return toast('PIN must be 6 digits');
  try{await call({a:'setpin',token:TOK,which:w,pin:p});$('#'+id).value='';toast('PIN changed')}catch(e){toast(e.message)}};

setInterval(bkTick,60e3);
login();
})();
