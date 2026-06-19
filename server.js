const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { nanoid } = require('nanoid');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER    = process.env.ADMIN_USER    || 'admin';
const ADMIN_PASS    = process.env.ADMIN_PASS    || 'changeme123';
const BASE_URL      = process.env.BASE_URL      || `http://localhost:${PORT}`;
const VIDEO_PRICE   = parseInt(process.env.VIDEO_PRICE || '5000');
const BANK_NAME     = process.env.BANK_NAME     || 'Хаан банк';
const BANK_ACCOUNT  = process.env.BANK_ACCOUNT  || '0000000000';
const BANK_HOLDER   = process.env.BANK_HOLDER   || 'КИНОХАБ ХХК';

const EXPIRY_MS = 72 * 60 * 60 * 1000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const sessions = new Set();

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Нэвтрэх шаардлагатай' });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, nanoid(16) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Зөвхөн видео'))
});

app.get('/admin', (req, res) => res.send(adminLoginPage()));

app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = nanoid(32);
    sessions.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Буруу мэдээлэл' });
  }
});

app.get('/admin/dashboard', (req, res) => res.send(adminDashboardPage()));

app.post('/admin/upload', requireAdmin, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл байхгүй' });
  const videoId = nanoid(16);
  db.saveVideo(videoId, {
    id: videoId,
    filename:     req.file.filename,
    originalName: req.file.originalname,
    size:         req.file.size,
    mimetype:     req.file.mimetype,
    uploadedAt:   Date.now()
  });
  res.json({ videoId, name: req.file.originalname });
});

app.get('/admin/videos', requireAdmin, (req, res) => {
  const raw    = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const videos = Object.values(raw.videos || {}).map(v => ({ id: v.id, name: v.originalName, size: v.size }));
  res.json(videos);
});

app.post('/admin/generate-links', requireAdmin, (req, res) => {
  const { videoId, count = 1, price } = req.body;
  if (!db.getVideo(videoId)) return res.status(404).json({ error: 'Видео олдсонгүй' });
  const links = [];
  for (let i = 0; i < Math.min(count, 500); i++) {
    const linkId = nanoid(12);
    db.saveLink(linkId, {
      id:              linkId,
      videoId,
      price:           price || VIDEO_PRICE,
      createdAt:       Date.now(),
      paidAt:          null,
      expiresAt:       null,
      pendingApproval: false
    });
    links.push(linkId);
  }
  res.json({ links });
});

app.get('/admin/links', requireAdmin, (req, res) => {
  const links = Object.values(db.getAllLinks()).sort((a, b) => b.createdAt - a.createdAt);
  res.json(links);
});

app.post('/admin/approve/:linkId', requireAdmin, (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).json({ error: 'Линк олдсонгүй' });
  if (link.paidAt) return res.json({ ok: true, msg: 'Аль хэдийн баталгаажсан' });
  const now = Date.now();
  db.updateLink(link.id, { paidAt: now, expiresAt: now + EXPIRY_MS, pendingApproval: false });
  res.json({ ok: true });
});

app.get('/buy/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Линк олдсонгүй', 'Энэ линк байхгүй эсвэл буруу байна.'));
  if (link.paidAt) {
    if (link.expiresAt > Date.now()) return res.redirect(`/v/${link.id}`);
    return res.status(410).send(errorPage('Хугацаа дууссан', 'Энэ линкийн 72 цагийн хугацаа дуусжээ.'));
  }
  res.send(paymentPage(link));
});

app.post('/buy/:linkId/notify', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).json({ error: 'Олдсонгүй' });
  if (link.paidAt) return res.json({ status: 'paid' });
  db.updateLink(link.id, { pendingApproval: true });
  res.json({ status: 'pending' });
});

app.get('/buy/:linkId/status', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.json({ status: 'not_found' });
  if (link.paidAt) return res.json({ status: link.expiresAt > Date.now() ? 'paid' : 'expired' });
  res.json({ status: link.pendingApproval ? 'pending_approval' : 'pending' });
});

app.get('/v/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link)          return res.status(404).send(errorPage('Линк олдсонгүй', 'Энэ линк байхгүй.'));
  if (!link.paidAt)   return res.redirect(`/buy/${link.id}`);
  if (link.expiresAt <= Date.now()) return res.status(410).send(errorPage('Хугацаа дууссан', 'Энэ линкийн 72 цагийн хугацаа дуусчээ.'));
  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).send(errorPage('Видео олдсонгүй', 'Видео серверт байхгүй байна.'));
  const remaining = Math.round((link.expiresAt - Date.now()) / 3600000 * 10) / 10;
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  res.send(videoPage(link, video, remaining, ip));
});

app.get('/stream/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link || !link.paidAt || link.expiresAt <= Date.now()) return res.status(403).end();
  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).end();
  const filePath = path.join(UPLOAD_DIR, video.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();
  const stat     = fs.statSync(filePath);
  const fileSize = stat.size;
  const range    = req.headers.range;
  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end   = endStr ? parseInt(endStr, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range':  `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges':  'bytes',
      'Content-Length': end - start + 1,
      'Content-Type':   video.mimetype
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': video.mimetype });
    fs.createReadStream(filePath).pipe(res);
  }
});

function paymentPage(link) {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Кино худалдаж авах</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}.card{background:#1a1a1a;border:1px solid #333;border-radius:16px;padding:32px 24px;width:100%;max-width:400px;text-align:center}h1{font-size:20px;margin-bottom:6px}.price{font-size:32px;font-weight:700;color:#a78bfa;margin:12px 0 24px}.bank-box{background:#111;border:1px solid #2a2a2a;border-radius:12px;padding:20px;text-align:left;margin-bottom:20px}.bank-row{display:flex;justify-content:space-between;align-items:center;padding:8px 0;border-bottom:1px solid #1e1e1e}.bank-row:last-child{border-bottom:none}.bank-label{font-size:12px;color:#666}.bank-value{font-size:15px;font-weight:600;color:#fff}.ref-box{background:#1a1240;border:1px solid #6c47ff;border-radius:10px;padding:14px;margin-bottom:20px}.ref-label{font-size:12px;color:#a78bfa;margin-bottom:4px}.ref-code{font-size:20px;font-weight:700;letter-spacing:2px;color:#fff}.hint{font-size:13px;color:#888;margin-bottom:20px;line-height:1.6}.btn{width:100%;padding:14px;border:none;border-radius:10px;font-size:15px;font-weight:600;cursor:pointer;margin-bottom:10px}.btn-main{background:#22c55e;color:#fff}.btn-main:disabled{background:#333;color:#666;cursor:not-allowed}.status{font-size:13px;color:#888;margin-top:10px;min-height:20px}.spinner{display:inline-block;width:13px;height:13px;border:2px solid #555;border-top-color:#a78bfa;border-radius:50%;animation:spin .8s linear infinite;vertical-align:middle;margin-right:5px}@keyframes spin{to{transform:rotate(360deg)}}.copy-btn{background:none;border:none;cursor:pointer;color:#a78bfa;font-size:12px;padding:2px 6px}</style></head><body><div class="card"><h1>🎬 Кино үзэх эрх</h1><div class="price">${link.price.toLocaleString()}₮</div><div class="bank-box"><div class="bank-row"><span class="bank-label">Банк</span><span class="bank-value">${BANK_NAME}</span></div><div class="bank-row"><span class="bank-label">Дансны дугаар</span><span class="bank-value">${BANK_ACCOUNT} <button class="copy-btn" onclick="cp('${BANK_ACCOUNT}',this)">📋</button></span></div><div class="bank-row"><span class="bank-label">Хүлээн авагч</span><span class="bank-value">${BANK_HOLDER}</span></div><div class="bank-row"><span class="bank-label">Дүн</span><span class="bank-value" style="color:#a78bfa">${link.price.toLocaleString()}₮</span></div></div><div class="ref-box"><div class="ref-label">⚠️ Гүйлгээний утга (заавал бичнэ)</div><div class="ref-code">${link.id}</div></div><div class="hint">Гүйлгээний утга хэсэгт дээрх кодыг <strong>заавал</strong> бичнэ үү.<br>Баталгаажсаны дараа 72 цаг үзэх эрх нээгдэнэ.</div><button class="btn btn-main" id="paidBtn" onclick="notifyPaid()">✅ Би төлсөн</button><div class="status" id="status"></div></div><script>function cp(t,btn){navigator.clipboard.writeText(t).then(()=>{btn.textContent='✓';setTimeout(()=>btn.textContent='📋',1500)});}let polling=false;async function notifyPaid(){const btn=document.getElementById('paidBtn');btn.disabled=true;btn.textContent='Илгээж байна...';await fetch('/buy/${link.id}/notify',{method:'POST'});document.getElementById('status').innerHTML='<span class="spinner"></span>Админ баталгаажуулахыг хүлээж байна...';startPolling();}function startPolling(){if(polling)return;polling=true;(function poll(){fetch('/buy/${link.id}/status').then(r=>r.json()).then(d=>{if(d.status==='paid'){document.getElementById('status').textContent='✅ Баталгаажлаа!';setTimeout(()=>location.href='/v/${link.id}',1000);}else{setTimeout(poll,4000);}}).catch(()=>setTimeout(poll,6000));})();}<\/script></body></html>`;
}

function videoPage(link, video, remaining, ip) {
  const watermark = `${link.id} · ${new Date().toLocaleDateString('mn-MN')}`;
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Кино үзэх</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;overflow:hidden;user-select:none;-webkit-user-select:none}.wrap{position:relative;width:100%;max-width:100vw}video{max-width:100vw;max-height:90vh;width:100%;display:block}.wm{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;display:flex;flex-direction:column;justify-content:space-between;padding:12px}.wm-text{font-family:monospace;font-size:13px;color:rgba(255,255,255,0.18);font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.8)}.wm-text.bottom{align-self:flex-end}.guard{position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:9999;display:none;align-items:center;justify-content:center;color:#fff;font-size:18px;font-family:system-ui,sans-serif}.notice{color:#555;font-family:system-ui,sans-serif;font-size:12px;padding:8px;text-align:center}</style></head><body><div class="guard" id="guard">⛔ Хамгаалагдсан агуулга</div><div class="wrap"><video controls autoplay controlsList="nodownload nofullscreen noremoteplayback" disablePictureInPicture oncontextmenu="return false" id="vid"><source src="/stream/${link.id}" type="${video.mimetype}"></video><div class="wm"><span class="wm-text">${watermark}</span><span class="wm-text bottom">${watermark}</span></div></div><p class="notice">⏱ ${remaining} цаг үлдсэн | 🔒 Хуулбарлахыг хориглоно</p><script>document.addEventListener('contextmenu',e=>e.preventDefault());document.addEventListener('keydown',e=>{if(e.key==='F12'||(e.ctrlKey&&['u','s','p','c'].includes(e.key.toLowerCase())))e.preventDefault();});document.addEventListener('visibilitychange',()=>{const g=document.getElementById('guard');const v=document.getElementById('vid');if(document.hidden){v.pause();g.style.display='flex';}else{g.style.display='none';}});document.getElementById('vid').addEventListener('enterpictureinpicture',()=>{document.exitPictureInPicture();});<\/script></body></html>`;
}

function adminLoginPage() {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:100%;max-width:360px}h1{font-size:20px;margin-bottom:24px;text-align:center}input{width:100%;padding:12px 14px;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;margin-bottom:12px}button{width:100%;padding:12px;background:#6c47ff;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.err{color:#ff5c5c;font-size:13px;margin-top:10px;text-align:center;display:none}</style></head><body><div class="card"><h1>🔐 Admin</h1><input type="text" id="u" placeholder="Нэвтрэх нэр" /><input type="password" id="p" placeholder="Нууц үг" /><button onclick="login()">Нэвтрэх</button><p class="err" id="err">Буруу мэдээлэл</p></div><script>async function login(){const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});const d=await r.json();if(d.token){localStorage.setItem('token',d.token);location.href='/admin/dashboard';}else document.getElementById('err').style.display='block';}document.addEventListener('keydown',e=>e.key==='Enter'&&login());<\/script></body></html>`;
}

function adminDashboardPage() {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Dashboard</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;padding:24px;max-width:960px;margin:0 auto}h1{font-size:22px;margin-bottom:24px}.section{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px;margin-bottom:20px}h2{font-size:15px;color:#aaa;margin-bottom:16px}input[type=file],input[type=number],input[type=text]{background:#111;border:1px solid #333;border-radius:8px;color:#fff;padding:10px 12px;font-size:14px;width:100%;margin-bottom:10px}button{padding:10px 20px;background:#6c47ff;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}button:hover{background:#5a38e0}button.sec{background:#333}button.approve{background:#22c55e;padding:5px 14px;font-size:12px}button.approve:hover{background:#16a34a}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:8px 10px;color:#666;border-bottom:1px solid #222}td{padding:8px 10px;border-bottom:1px solid #1a1a1a;vertical-align:middle}.badge{display:inline-block;padding:2px 8px;border-radius:20px;font-size:11px;font-weight:600}.unpaid{background:#1e1e2a;color:#888}.pending{background:#2a2010;color:#f59e0b}.paid{background:#1e3a1e;color:#4caf50}.expired{background:#2a1a1a;color:#ef5350}.copy-btn{padding:3px 8px;font-size:11px;background:#222;border-radius:6px;cursor:pointer;border:none;color:#fff}.progress{background:#222;border-radius:6px;height:6px;margin-top:6px}.progress-bar{background:#6c47ff;height:6px;border-radius:6px}.video-item{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin-bottom:6px}.video-item.sel{border-color:#6c47ff;background:#1a1240}label{font-size:13px;color:#aaa;display:block;margin-bottom:4px}.row{display:flex;gap:10px}.row>*{flex:1}.pending-alert{background:#2a2010;border:1px solid #f59e0b;border-radius:8px;padding:10px 14px;margin-bottom:12px;font-size:13px;color:#f59e0b}</style></head><body><h1>🎬 Кино борлуулалтын систем</h1><div class="section"><h2>Видео байршуулах</h2><input type="file" id="vFile" accept="video/*" /><div class="progress" id="prog" style="display:none"><div class="progress-bar" id="progFill" style="width:0%"></div></div><button onclick="uploadVideo()">Байршуулах</button><div id="uploadMsg"></div></div><div class="section"><h2>Худалдааны линк үүсгэх</h2><div id="videoList"><p style="color:#555;font-size:13px">Байршуулсан видео энд харагдана</p></div><br><div class="row"><div><label>Үнэ (₮)</label><input type="number" id="price" value="5000" min="100" /></div><div><label>Хэдэн линк үүсгэх</label><input type="number" id="lCount" value="1" min="1" max="500" /></div></div><button onclick="genLinks()">Линк үүсгэх</button><div id="genResult" style="margin-top:14px"></div></div><div class="section"><h2>Бүх линк <button class="sec" onclick="loadLinks()" style="font-size:11px;padding:4px 10px;margin-left:10px">🔄 Шинэчлэх</button></h2><div id="pendingAlert"></div><div id="linksTable"></div></div><script>const token=localStorage.getItem('token');if(!token)location.href='/admin';const H={'Content-Type':'application/json','x-admin-token':token};let selVideoId=null;const BASE=location.origin;async function uploadVideo(){const file=document.getElementById('vFile').files[0];if(!file)return alert('Видео сонгоно уу');const form=new FormData();form.append('video',file);document.getElementById('prog').style.display='block';document.getElementById('uploadMsg').innerHTML='<span style="color:#aaa;font-size:13px">Байршуулж байна...</span>';const xhr=new XMLHttpRequest();xhr.open('POST','/admin/upload');xhr.setRequestHeader('x-admin-token',token);xhr.upload.onprogress=e=>{if(e.lengthComputable)document.getElementById('progFill').style.width=(e.loaded/e.total*100)+'%';};xhr.onload=()=>{document.getElementById('prog').style.display='none';const d=JSON.parse(xhr.responseText);if(d.videoId){document.getElementById('uploadMsg').innerHTML='<p style="color:#7fff7f">✅ Байршлаа!</p>';loadVideos();}else document.getElementById('uploadMsg').innerHTML='<p style="color:#ff5c5c;font-size:13px">❌ '+(d.error||'Алдаа')+'</p>';};xhr.send(form);}async function loadVideos(){const vs=await fetch('/admin/videos',{headers:H}).then(r=>r.json());const el=document.getElementById('videoList');if(!vs.length){el.innerHTML='<p style="color:#555;font-size:13px">Байршуулсан видео байхгүй</p>';return;}el.innerHTML=vs.map(v=>'<div class="video-item '+(selVideoId===v.id?'sel':'')+'" onclick="selVideo(\''+v.id+'\',this)"><span style="font-size:13px">🎬 '+v.name+'</span><span style="color:#555;font-size:11px">'+(v.size/1024/1024).toFixed(1)+' MB</span></div>').join('');}function selVideo(id,el){selVideoId=id;document.querySelectorAll('.video-item').forEach(e=>e.classList.remove('sel'));el.classList.add('sel');}async function genLinks(){if(!selVideoId)return alert('Видео сонгоно уу');const count=parseInt(document.getElementById('lCount').value)||1;const price=parseInt(document.getElementById('price').value)||5000;const d=await fetch('/admin/generate-links',{method:'POST',headers:H,body:JSON.stringify({videoId:selVideoId,count,price})}).then(r=>r.json());if(d.links){document.getElementById('genResult').innerHTML='<p style="font-size:13px;color:#aaa;margin-bottom:10px">✅ '+d.links.length+' линк үүслээ:</p>'+d.links.map((l,i)=>'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="color:#555;font-size:12px;width:24px">'+(i+1)+'.</span><code style="font-size:12px;background:#111;padding:4px 8px;border-radius:6px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+BASE+'/buy/'+l+'</code><button class="copy-btn" onclick="cp(\''+BASE+'/buy/'+l+'\',this)">📋</button></div>').join('')+'<button class="sec" onclick="cpAll([\''+d.links.map(l=>BASE+'/buy/'+l).join('\',\'')+'\'\'])" style="margin-top:8px;font-size:12px">Бүгдийг хуулах</button>';loadLinks();}}function cp(t,btn){navigator.clipboard.writeText(t);btn.textContent='✓';setTimeout(()=>btn.textContent='📋',1500);}function cpAll(ls){navigator.clipboard.writeText(ls.join('\n'));alert('Бүх линк хуулагдлаа!');}async function approve(linkId,btn){btn.disabled=true;btn.textContent='...';await fetch('/admin/approve/'+linkId,{method:'POST',headers:H});loadLinks();}async function loadLinks(){const links=await fetch('/admin/links',{headers:H}).then(r=>r.json());const el=document.getElementById('linksTable');const alertEl=document.getElementById('pendingAlert');if(!links.length){el.innerHTML='<p style="color:#555;font-size:13px">Линк байхгүй</p>';return;}const now=Date.now();const pendingCount=links.filter(l=>l.pendingApproval&&!l.paidAt).length;alertEl.innerHTML=pendingCount>0?'<div class="pending-alert">⚠️ <strong>'+pendingCount+'</strong> төлбөр баталгаажуулах хүлээж байна!</div>':'';el.innerHTML='<table><tr><th>Линк</th><th>Үнэ</th><th>Статус</th><th>Төлсөн</th><th>Дуусах</th><th></th></tr>'+links.map(l=>{let cls,txt;if(!l.paidAt&&l.pendingApproval){cls='pending';txt='Хүлээгдэж байна';}else if(!l.paidAt){cls='unpaid';txt='Төлөөгүй';}else if(l.expiresAt>now){cls='paid';txt='Идэвхтэй';}else{cls='expired';txt='Дууссан';}const showBtn=!l.paidAt&&l.pendingApproval;return'<tr><td><code style="font-size:11px">/buy/'+l.id+'</code> <button class="copy-btn" onclick="cp(\''+BASE+'/buy/'+l.id+'\',this)">📋</button></td><td style="color:#a78bfa">'+(l.price||0).toLocaleString()+'₮</td><td><span class="badge '+cls+'">'+txt+'</span></td><td style="color:#666;font-size:12px">'+(l.paidAt?new Date(l.paidAt).toLocaleString('mn-MN'):'—')+'</td><td style="color:#666;font-size:12px">'+(l.expiresAt?new Date(l.expiresAt).toLocaleString('mn-MN'):'—')+'</td><td>'+(showBtn?'<button class="approve" onclick="approve(\''+l.id+'\',this)">✅ Батлах</button>':'')+'</td></tr>';}).join('')+'</table>';}loadVideos();loadLinks();setInterval(loadLinks,15000);<\/script></body></html>`;
}

function errorPage(title, msg) {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{max-width:400px}h1{font-size:22px;margin-bottom:12px}.icon{font-size:48px;margin-bottom:16px}p{color:#888;font-size:15px}</style></head><body><div class="card"><div class="icon">🔒</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}

app.listen(PORT, () => {
  console.log(`✅ Сервер: http://localhost:${PORT}`);
  console.log(`📋 Admin: http://localhost:${PORT}/admin`);
});
