const express = require('express');
const path    = require('path');
const fs      = require('fs');
const { nanoid } = require('nanoid');
const db      = require('./db');
const { S3Client, PutObjectCommand, GetObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'changeme123';
const EXPIRY_MS  = 72 * 60 * 60 * 1000;

// ── Cloudflare R2 ─────────────────────────────────────────────────────────────
const r2 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId:     process.env.R2_ACCESS_KEY_ID     || '',
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
  },
});
const R2_BUCKET = process.env.R2_BUCKET_NAME || '';

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function getCookie(req, name) {
  const cookies = req.headers.cookie || '';
  const found = cookies.split(';').map(c => c.trim()).find(c => c.startsWith(name + '='));
  return found ? found.slice(name.length + 1) : null;
}

const sessions = new Set();

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Нэвтрэх шаардлагатай' });
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN
// ══════════════════════════════════════════════════════════════════════════════

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

// Presigned PUT URL — browser шууд R2-р уу хуулна
app.post('/admin/get-upload-url', requireAdmin, async (req, res) => {
  const { filename } = req.body;
  const key = `videos/${Date.now()}-${filename}`;
  try {
    const url = await getSignedUrl(r2, new PutObjectCommand({
      Bucket: R2_BUCKET, Key: key, ContentType: 'video/mp4'
    }), { expiresIn: 7200 });
    res.json({ uploadUrl: url, key });
  } catch (err) {
    console.error('Presign error:', err);
    res.status(500).json({ error: 'URL үүсгэхэд алдаа гарлаа' });
  }
});

// R2-д хуулсны дараа видео бүртгэнэ
app.post('/admin/register-video', requireAdmin, (req, res) => {
  const { key, filename } = req.body;
  const videoId = nanoid(16);
  db.saveVideo(videoId, { id: videoId, key, originalName: filename, uploadedAt: Date.now() });
  res.json({ videoId, name: filename });
});

app.get('/admin/videos', requireAdmin, (req, res) => {
  const raw    = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const videos = Object.values(raw.videos || {}).map(v => ({ id: v.id, name: v.originalName }));
  res.json(videos);
});

app.post('/admin/generate-links', requireAdmin, (req, res) => {
  const { videoId, count = 1 } = req.body;
  if (!db.getVideo(videoId)) return res.status(404).json({ error: 'Видео олдсонгүй' });
  const links = [];
  for (let i = 0; i < Math.min(count, 500); i++) {
    const linkId = nanoid(12);
    db.saveLink(linkId, { id: linkId, videoId, createdAt: Date.now() });
    links.push(linkId);
  }
  res.json({ links });
});

app.get('/admin/links', requireAdmin, (req, res) => {
  const links = Object.values(db.getAllLinks()).sort((a, b) => b.createdAt - a.createdAt);
  res.json(links);
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC
// ══════════════════════════════════════════════════════════════════════════════

app.get('/buy/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Линк олдсонгүй', 'Энэ линк байхгүй эсвэл буруу байна.'));

  const cookieName = 'v_' + link.id;
  const existing   = getCookie(req, cookieName);

  if (existing) {
    const expiresAt = parseInt(existing, 10);
    if (Date.now() < expiresAt) return res.redirect('/v/' + link.id + '?t=' + existing);
    else return res.status(410).send(errorPage('Хугацаа дууссан', 'Энэ төхөөрөмж дээр 72 цагийн хугацаа дуусжээ.'));
  }

  const expiresAt = Date.now() + EXPIRY_MS;
  const expires   = new Date(expiresAt).toUTCString();
  res.setHeader('Set-Cookie', `${cookieName}=${expiresAt}; Expires=${expires}; Path=/; HttpOnly; SameSite=Strict`);
  res.redirect('/v/' + link.id + '?t=' + expiresAt);
});

app.get('/v/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Линк олдсонгүй', 'Энэ линк байхгүй.'));

  const cookieName = 'v_' + link.id;
  const existing   = getCookie(req, cookieName);
  if (!existing || Date.now() >= parseInt(existing, 10)) return res.redirect('/buy/' + link.id);

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).send(errorPage('Видео олдсонгүй', 'Видео байхгүй байна.'));

  const expiresAt = parseInt(existing, 10);
  const remaining = Math.round((expiresAt - Date.now()) / 3600000 * 10) / 10;
  const watermark = link.id + ' · ' + new Date().toLocaleDateString('mn-MN');

  res.send(`<!DOCTYPE html>
<html lang="mn"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Кино үзэх</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;user-select:none;-webkit-user-select:none}
.wrap{position:relative;width:100%;max-width:100vw}
video{max-width:100vw;max-height:90vh;width:100%;display:block}
.wm{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;display:flex;flex-direction:column;justify-content:space-between;padding:12px}
.wm-text{font-family:monospace;font-size:13px;color:rgba(255,255,255,0.15);font-weight:600;text-shadow:0 1px 3px rgba(0,0,0,.8)}
.wm-text.b{align-self:flex-end}
.guard{position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:9999;display:none;align-items:center;justify-content:center;color:#fff;font-size:18px;font-family:system-ui}
.notice{color:#444;font-family:system-ui,sans-serif;font-size:12px;padding:8px;text-align:center}
</style>
</head><body>
<div class="guard" id="guard">⛔ Хамгаалагдсан агуулга</div>
<div class="wrap">
  <video controls autoplay controlsList="nodownload nofullscreen noremoteplayback" disablePictureInPicture oncontextmenu="return false" id="vid">
    <source src="/stream/${link.id}" type="video/mp4">
  </video>
  <div class="wm">
    <span class="wm-text">${watermark}</span>
    <span class="wm-text b">${watermark}</span>
  </div>
</div>
<p class="notice">⏱ ${remaining} цаг үлдсэн &nbsp;|&nbsp; 🔒 Хуулбарлахыг хориглоно</p>
<script>
document.addEventListener('contextmenu', e => e.preventDefault());
document.addEventListener('keydown', e => {
  if (e.key === 'F12' || (e.ctrlKey && ['u','s','p','c'].includes(e.key.toLowerCase()))) e.preventDefault();
});
document.addEventListener('visibilitychange', () => {
  const g = document.getElementById('guard'), v = document.getElementById('vid');
  if (document.hidden) { v.pause(); g.style.display = 'flex'; }
  else g.style.display = 'none';
});
document.getElementById('vid').addEventListener('enterpictureinpicture', () => document.exitPictureInPicture());
</script>
</body></html>`);
});

// Cookie шалгаад R2 presigned GET URL руу redirect
app.get('/stream/:linkId', async (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).end();

  const cookieName = 'v_' + link.id;
  const existing   = getCookie(req, cookieName);
  if (!existing || Date.now() >= parseInt(existing, 10)) return res.status(403).end();

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).end();

  try {
    const signedUrl = await getSignedUrl(r2, new GetObjectCommand({
      Bucket: R2_BUCKET, Key: video.key
    }), { expiresIn: 14400 }); // 4 цаг
    res.redirect(signedUrl);
  } catch (err) {
    console.error('Stream error:', err);
    res.status(500).end();
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// HTML helpers
// ══════════════════════════════════════════════════════════════════════════════

function adminLoginPage() {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title>
<style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:100%;max-width:360px}h1{font-size:20px;margin-bottom:24px;text-align:center}input{width:100%;padding:12px 14px;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;margin-bottom:12px}button{width:100%;padding:12px;background:#6c47ff;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.err{color:#ff5c5c;font-size:13px;margin-top:10px;text-align:center;display:none}</style></head>
<body><div class="card"><h1>🔐 Admin</h1><input type="text" id="u" placeholder="Нэвтрэх нэр"/><input type="password" id="p" placeholder="Нууц үг"/><button onclick="login()">Нэвтрэх</button><p class="err" id="err">Буруу мэдээлэл</p></div>
<script>async function login(){const r=await fetch('/admin/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:document.getElementById('u').value,pass:document.getElementById('p').value})});const d=await r.json();if(d.token){localStorage.setItem('token',d.token);location.href='/admin/dashboard';}else document.getElementById('err').style.display='block';}document.addEventListener('keydown',e=>e.key==='Enter'&&login());</script>
</body></html>`;
}

function adminDashboardPage() {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>KINOHUB Admin</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;padding:24px;max-width:860px;margin:0 auto}
h1{font-size:22px;margin-bottom:24px}
.section{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px;margin-bottom:20px}
h2{font-size:15px;color:#aaa;margin-bottom:16px}
input[type=file],input[type=number]{background:#111;border:1px solid #333;border-radius:8px;color:#fff;padding:10px 12px;font-size:14px;width:100%;margin-bottom:10px}
button{padding:10px 20px;background:#6c47ff;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}
button.sec{background:#333}
button:disabled{opacity:.5;cursor:default}
button:not(:disabled):hover{opacity:.85}
.prog-wrap{margin:10px 0;display:none}
.prog-bar-bg{background:#222;border-radius:6px;height:10px}
.prog-bar{background:#6c47ff;height:10px;border-radius:6px;width:0%;transition:width .15s}
.prog-info{display:flex;justify-content:space-between;margin-top:6px;font-size:12px;color:#888}
.video-item{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin-bottom:6px}
.video-item.sel{border-color:#6c47ff;background:#1a1240}
label{font-size:13px;color:#aaa;display:block;margin-bottom:4px}
table{width:100%;border-collapse:collapse;font-size:13px}
th{text-align:left;padding:8px 10px;color:#666;border-bottom:1px solid #222}
td{padding:8px 10px;border-bottom:1px solid #1a1a1a}
.copy-btn{padding:3px 8px;font-size:11px;background:#222;border-radius:6px;cursor:pointer;border:none;color:#fff}
</style></head>
<body>
<h1>🎬 KINOHUB Admin</h1>

<div class="section">
  <h2>Видео байршуулах (Cloudflare R2)</h2>
  <input type="file" id="vFile" accept="video/*"/>
  <div class="prog-wrap" id="progWrap">
    <div class="prog-bar-bg"><div class="prog-bar" id="progBar"></div></div>
    <div class="prog-info">
      <span id="progPct">0%</span>
      <span id="progSpeed"></span>
      <span id="progEta"></span>
    </div>
  </div>
  <button onclick="uploadVideo()" id="uploadBtn">Байршуулах</button>
  <div id="uploadMsg" style="margin-top:10px"></div>
</div>

<div class="section">
  <h2>Линк үүсгэх</h2>
  <div id="videoList"><p style="color:#555;font-size:13px">Байршуулсан видео энд харагдана</p></div>
  <br>
  <label>Хэдэн линк үүсгэх</label>
  <input type="number" id="lCount" value="1" min="1" max="500" style="max-width:160px"/>
  <button onclick="genLinks()">Линк үүсгэх</button>
  <div id="genResult" style="margin-top:14px"></div>
</div>

<div class="section">
  <h2>Бүх линк <button class="sec" onclick="loadLinks()" style="font-size:11px;padding:4px 10px;margin-left:10px">🔄 Шинэчлэх</button></h2>
  <div id="linksTable"></div>
</div>

<script>
const token = localStorage.getItem('token');
if (!token) location.href = '/admin';
const H = {'Content-Type':'application/json','x-admin-token':token};
let selVideoId = null;
const BASE = location.origin;

async function uploadVideo() {
  const file = document.getElementById('vFile').files[0];
  if (!file) return alert('Видео сонгоно уу');

  const btn = document.getElementById('uploadBtn');
  btn.disabled = true;
  document.getElementById('progWrap').style.display = 'block';
  document.getElementById('progBar').style.width = '0%';
  document.getElementById('progPct').textContent = '0%';
  document.getElementById('progSpeed').textContent = '';
  document.getElementById('progEta').textContent = '';
  document.getElementById('uploadMsg').innerHTML = '<span style="color:#aaa;font-size:13px">R2 холболт тогтоож байна...</span>';

  const startTime = Date.now();

  try {
    // 1. Presigned URL авна
    const urlRes = await fetch('/admin/get-upload-url', {
      method: 'POST', headers: H,
      body: JSON.stringify({ filename: file.name })
    });
    if (!urlRes.ok) throw new Error('URL авахад алдаа гарлаа');
    const { uploadUrl, key } = await urlRes.json();

    document.getElementById('uploadMsg').innerHTML = '<span style="color:#aaa;font-size:13px">Байршуулж байна...</span>';

    // 2. Шууд R2-р уу PUT хийнэ (progress харагдана)
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', 'video/mp4');

      xhr.upload.onprogress = e => {
        if (!e.lengthComputable) return;
        const pct     = Math.round(e.loaded / e.total * 100);
        const elapsed = (Date.now() - startTime) / 1000;
        const speed   = e.loaded / elapsed; // bytes/sec
        const eta     = (e.total - e.loaded) / speed;

        document.getElementById('progBar').style.width   = pct + '%';
        document.getElementById('progPct').textContent   = pct + '%';
        document.getElementById('progSpeed').textContent = (speed / 1048576).toFixed(1) + ' MB/s';
        document.getElementById('progEta').textContent   = eta > 0 ? Math.ceil(eta) + 'с үлдсэн' : '';
      };

      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) resolve();
        else reject(new Error('R2 алдаа: ' + xhr.status));
      };
      xhr.onerror = () => reject(new Error('Сүлжээний алдаа'));
      xhr.send(file);
    });

    // 3. Серверт бүртгэнэ
    const reg = await fetch('/admin/register-video', {
      method: 'POST', headers: H,
      body: JSON.stringify({ key, filename: file.name })
    }).then(r => r.json());

    document.getElementById('progBar').style.width = '100%';
    document.getElementById('progPct').textContent = '100%';
    document.getElementById('progEta').textContent = '';
    document.getElementById('uploadMsg').innerHTML = '<p style="color:#7fff7f;font-size:13px;margin-top:6px">✅ Байршлаа!</p>';
    loadVideos();
  } catch (err) {
    document.getElementById('uploadMsg').innerHTML = '<p style="color:#ff5c5c;font-size:13px;margin-top:6px">❌ ' + err.message + '</p>';
  } finally {
    btn.disabled = false;
  }
}

async function loadVideos() {
  const vs = await fetch('/admin/videos',{headers:H}).then(r=>r.json());
  const el = document.getElementById('videoList');
  if (!vs.length) { el.innerHTML='<p style="color:#555;font-size:13px">Байршуулсан видео байхгүй</p>'; return; }
  el.innerHTML = vs.map(v=>'<div class="video-item '+(selVideoId===v.id?'sel':'')+'" onclick="sel(\\''+v.id+'\\',this)"><span style="font-size:13px">🎬 '+v.name+'</span></div>').join('');
}
function sel(id,el){selVideoId=id;document.querySelectorAll('.video-item').forEach(e=>e.classList.remove('sel'));el.classList.add('sel');}

async function genLinks() {
  if (!selVideoId) return alert('Видео сонгоно уу');
  const count = parseInt(document.getElementById('lCount').value)||1;
  const d = await fetch('/admin/generate-links',{method:'POST',headers:H,body:JSON.stringify({videoId:selVideoId,count})}).then(r=>r.json());
  if (d.links) {
    document.getElementById('genResult').innerHTML = '<p style="font-size:13px;color:#aaa;margin-bottom:10px">✅ '+d.links.length+' линк үүслээ:</p>'
      +d.links.map((l,i)=>'<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px"><span style="color:#555;font-size:12px;width:24px">'+(i+1)+'.</span><code style="font-size:12px;background:#111;padding:4px 8px;border-radius:6px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">'+BASE+'/buy/'+l+'</code><button class="copy-btn" onclick="cp(\\''+BASE+'/buy/'+l+'\\',this)">📋</button></div>').join('')
      +'<button class="sec" onclick="cpAll()" style="margin-top:8px;font-size:12px">Бүгдийг хуулах</button>';
    window._lastLinks = d.links.map(l=>BASE+'/buy/'+l);
    loadLinks();
  }
}

function cp(t,btn){navigator.clipboard.writeText(t);btn.textContent='✓';setTimeout(()=>btn.textContent='📋',1500);}
function cpAll(){navigator.clipboard.writeText((window._lastLinks||[]).join('\\n'));alert('Бүх линк хуулагдлаа!');}

async function loadLinks() {
  const links = await fetch('/admin/links',{headers:H}).then(r=>r.json());
  const el = document.getElementById('linksTable');
  if (!links.length) { el.innerHTML='<p style="color:#555;font-size:13px">Линк байхгүй</p>'; return; }
  el.innerHTML = '<table><tr><th>Линк</th><th>Үүсгэсэн</th></tr>'
    +links.map(l=>'<tr><td><code style="font-size:11px">/buy/'+l.id+'</code> <button class="copy-btn" onclick="cp(\\''+BASE+'/buy/'+l.id+'\\',this)">📋</button></td><td style="color:#666;font-size:12px">'+new Date(l.createdAt).toLocaleString('mn-MN')+'</td></tr>').join('')
    +'</table>';
}

loadVideos();
loadLinks();
</script>
</body></html>`;
}

function errorPage(title, msg) {
  return `<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{max-width:400px}h1{font-size:22px;margin-bottom:12px}.icon{font-size:48px;margin-bottom:16px}p{color:#888;font-size:15px}</style></head>
<body><div class="card"><div class="icon">🔒</div><h1>${title}</h1><p>${msg}</p></div></body></html>`;
}

app.listen(PORT, () => {
  console.log(`✅ Сервер: http://localhost:${PORT}`);
  console.log(`📋 Admin: http://localhost:${PORT}/admin`);
});
