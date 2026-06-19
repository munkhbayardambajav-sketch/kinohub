const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { nanoid } = require('nanoid');
const db      = require('./db');

const app  = express();
const PORT = process.env.PORT || 3000;

const ADMIN_USER  = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS  = process.env.ADMIN_PASS || 'changeme123';
const EXPIRY_MS   = 72 * 60 * 60 * 1000;

const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

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
  res.status(401).json({ error: 'Unauthorized' });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename:    (req, file, cb) => cb(null, nanoid(16) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Video only'))
});

app.get('/admin', (req, res) => res.send(adminLoginPage()));

app.post('/admin/login', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    const token = nanoid(32);
    sessions.add(token);
    res.json({ token });
  } else {
    res.status(401).json({ error: 'Wrong credentials' });
  }
});

app.get('/admin/dashboard', (req, res) => res.send(adminDashboardPage()));

app.post('/admin/upload', requireAdmin, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
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
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const videos = Object.values(raw.videos || {}).map(v => ({ id: v.id, name: v.originalName, size: v.size }));
  res.json(videos);
});

app.post('/admin/generate-links', requireAdmin, (req, res) => {
  const { videoId, count = 1 } = req.body;
  if (!db.getVideo(videoId)) return res.status(404).json({ error: 'Video not found' });
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

app.get('/buy/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Not found', 'Link not found.'));

  const cookieName = 'v_' + link.id;
  const existing   = getCookie(req, cookieName);

  if (existing) {
    const expiresAt = parseInt(existing, 10);
    if (Date.now() < expiresAt) {
      return res.redirect('/v/' + link.id);
    } else {
      return res.status(410).send(errorPage('Expired', '72 hours have passed.'));
    }
  }

  const expiresAt = Date.now() + EXPIRY_MS;
  const expires   = new Date(expiresAt).toUTCString();
  res.setHeader('Set-Cookie', cookieName + '=' + expiresAt + '; Expires=' + expires + '; Path=/; HttpOnly; SameSite=Strict');
  res.redirect('/v/' + link.id);
});

app.get('/v/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Not found', 'Link not found.'));

  const cookieName = 'v_' + link.id;
  const existing   = getCookie(req, cookieName);
  if (!existing || Date.now() >= parseInt(existing, 10)) {
    return res.redirect('/buy/' + link.id);
  }

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).send(errorPage('Not found', 'Video not found.'));

  const expiresAt = parseInt(existing, 10);
  const remaining = Math.round((expiresAt - Date.now()) / 3600000 * 10) / 10;
  const watermark = link.id + ' - ' + new Date().toLocaleDateString('mn-MN');

  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>KINOHUB</title><style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;user-select:none;-webkit-user-select:none}.wrap{position:relative;width:100%;max-width:100vw}video{max-width:100vw;max-height:90vh;width:100%;display:block}.wm{position:absolute;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:10;display:flex;flex-direction:column;justify-content:space-between;padding:12px}.wm-text{font-family:monospace;font-size:13px;color:rgba(255,255,255,0.15);font-weight:600}.wm-text.b{align-self:flex-end}.guard{position:fixed;top:0;left:0;width:100vw;height:100vh;background:#000;z-index:9999;display:none;align-items:center;justify-content:center;color:#fff;font-size:18px;font-family:system-ui}.notice{color:#444;font-family:system-ui;font-size:12px;padding:8px;text-align:center}</style></head><body><div class="guard" id="guard">Protected content</div><div class="wrap"><video controls autoplay controlsList="nodownload nofullscreen noremoteplayback" disablePictureInPicture oncontextmenu="return false" id="vid"><source src="/stream/' + link.id + '" type="' + video.mimetype + '"></video><div class="wm"><span class="wm-text">' + watermark + '</span><span class="wm-text b">' + watermark + '</span></div></div><p class="notice">' + remaining + ' hours left | No recording allowed</p><script>document.addEventListener("contextmenu",e=>e.preventDefault());document.addEventListener("keydown",e=>{if(e.key==="F12"||(e.ctrlKey&&["u","s","p","c"].includes(e.key.toLowerCase())))e.preventDefault();});document.addEventListener("visibilitychange",()=>{const g=document.getElementById("guard"),v=document.getElementById("vid");if(document.hidden){v.pause();g.style.display="flex";}else g.style.display="none";});document.getElementById("vid").addEventListener("enterpictureinpicture",()=>document.exitPictureInPicture());</script></body></html>');
});

app.get('/stream/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).end();

  const cookieName = 'v_' + link.id;
  const existing   = getCookie(req, cookieName);
  if (!existing || Date.now() >= parseInt(existing, 10)) return res.status(403).end();

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).end();

  const filePath = path.join(UPLOAD_DIR, video.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const stat     = fs.statSync(filePath);
  const fileSize = stat.size;
  const range    = req.headers.range;

  if (range) {
    const parts = range.replace(/bytes=/, '').split('-');
    const start = parseInt(parts[0], 10);
    const end   = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range':  'bytes ' + start + '-' + end + '/' + fileSize,
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

function adminLoginPage() {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh}.card{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:40px;width:100%;max-width:360px}h1{font-size:20px;margin-bottom:24px;text-align:center}input{width:100%;padding:12px 14px;background:#111;border:1px solid #333;border-radius:8px;color:#fff;font-size:14px;margin-bottom:12px}button{width:100%;padding:12px;background:#6c47ff;border:none;border-radius:8px;color:#fff;font-size:15px;font-weight:600;cursor:pointer}.err{color:#ff5c5c;font-size:13px;margin-top:10px;text-align:center;display:none}</style></head><body><div class="card"><h1>Admin</h1><input type="text" id="u" placeholder="Username"/><input type="password" id="p" placeholder="Password"/><button onclick="login()">Login</button><p class="err" id="err">Wrong credentials</p></div><script>async function login(){const r=await fetch("/admin/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({user:document.getElementById("u").value,pass:document.getElementById("p").value})});const d=await r.json();if(d.token){localStorage.setItem("token",d.token);location.href="/admin/dashboard";}else document.getElementById("err").style.display="block";}document.addEventListener("keydown",e=>e.key==="Enter"&&login());</script></body></html>';
}

function adminDashboardPage() {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Dashboard</title><style>*{box-sizing:border-box;margin:0;padding:0}body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;padding:24px;max-width:860px;margin:0 auto}h1{font-size:22px;margin-bottom:24px}.section{background:#1a1a1a;border:1px solid #333;border-radius:12px;padding:24px;margin-bottom:20px}h2{font-size:15px;color:#aaa;margin-bottom:16px}input[type=file],input[type=number]{background:#111;border:1px solid #333;border-radius:8px;color:#fff;padding:10px 12px;font-size:14px;width:100%;margin-bottom:10px}button{padding:10px 20px;background:#6c47ff;border:none;border-radius:8px;color:#fff;font-size:14px;font-weight:600;cursor:pointer}button.sec{background:#333}button:hover{opacity:.85}.progress{background:#222;border-radius:6px;height:6px;margin-top:6px}.bar{background:#6c47ff;height:6px;border-radius:6px}.vi{background:#111;border:1px solid #2a2a2a;border-radius:8px;padding:10px 14px;display:flex;justify-content:space-between;align-items:center;cursor:pointer;margin-bottom:6px}.vi.sel{border-color:#6c47ff;background:#1a1240}label{font-size:13px;color:#aaa;display:block;margin-bottom:4px}table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;padding:8px 10px;color:#666;border-bottom:1px solid #222}td{padding:8px 10px;border-bottom:1px solid #1a1a1a}.cb{padding:3px 8px;font-size:11px;background:#222;border-radius:6px;cursor:pointer;border:none;color:#fff}</style></head><body><h1>KINOHUB Admin</h1><div class="section"><h2>Upload Video</h2><input type="file" id="vFile" accept="video/*"/><div class="progress" id="prog" style="display:none"><div class="bar" id="pf" style="width:0%"></div></div><button onclick="uploadVideo()">Upload</button><div id="uploadMsg"></div></div><div class="section"><h2>Generate Links</h2><div id="videoList"><p style="color:#555;font-size:13px">No videos yet</p></div><br><label>Number of links</label><input type="number" id="lCount" value="1" min="1" max="500" style="max-width:160px"/><button onclick="genLinks()">Generate</button><div id="genResult" style="margin-top:14px"></div></div><div class="section"><h2>All Links <button class="sec" onclick="loadLinks()" style="font-size:11px;padding:4px 10px;margin-left:10px">Refresh</button></h2><div id="linksTable"></div></div><script>const token=localStorage.getItem("token");if(!token)location.href="/admin";const H={"Content-Type":"application/json","x-admin-token":token};let selId=null;const BASE=location.origin;async function uploadVideo(){const file=document.getElementById("vFile").files[0];if(!file)return alert("Select video");const form=new FormData();form.append("video",file);document.getElementById("prog").style.display="block";document.getElementById("uploadMsg").innerHTML="Uploading...";const xhr=new XMLHttpRequest();xhr.open("POST","/admin/upload");xhr.setRequestHeader("x-admin-token",token);xhr.upload.onprogress=e=>{if(e.lengthComputable)document.getElementById("pf").style.width=(e.loaded/e.total*100)+"%";};xhr.onload=()=>{document.getElementById("prog").style.display="none";const d=JSON.parse(xhr.responseText);if(d.videoId){document.getElementById("uploadMsg").innerHTML="Done!";loadVideos();}else document.getElementById("uploadMsg").innerHTML="Error: "+(d.error||"");};xhr.send(form);}async function loadVideos(){const vs=await fetch("/admin/videos",{headers:H}).then(r=>r.json());const el=document.getElementById("videoList");if(!vs.length){el.innerHTML="<p style=color:#555;font-size:13px>No videos</p>";return;}el.innerHTML=vs.map(v=>"<div class=\"vi "+(selId===v.id?"sel":"")+"\" onclick=\"sel(\'"+v.id+"\',this)\"><span style=font-size:13px>"+v.name+"</span><span style=color:#555;font-size:11px>"+(v.size/1024/1024).toFixed(1)+" MB</span></div>").join("");}function sel(id,el){selId=id;document.querySelectorAll(".vi").forEach(e=>e.classList.remove("sel"));el.classList.add("sel");}async function genLinks(){if(!selId)return alert("Select video");const count=parseInt(document.getElementById("lCount").value)||1;const d=await fetch("/admin/generate-links",{method:"POST",headers:H,body:JSON.stringify({videoId:selId,count})}).then(r=>r.json());if(d.links){document.getElementById("genResult").innerHTML="<p style=font-size:13px;color:#aaa;margin-bottom:10px>"+d.links.length+" links created:</p>"+d.links.map((l,i)=>"<div style=display:flex;align-items:center;gap:8px;margin-bottom:6px><span style=color:#555;font-size:12px;width:24px>"+(i+1)+".</span><code style=font-size:12px;background:#111;padding:4px 8px;border-radius:6px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap>"+BASE+"/buy/"+l+"</code><button class=cb onclick=\"cp(\'"+BASE+"/buy/"+l+"\',this)\">Copy</button></div>").join("")+"<button class=sec onclick=cpAll() style=margin-top:8px;font-size:12px>Copy All</button>";window._lastLinks=d.links.map(l=>BASE+"/buy/"+l);loadLinks();}}function cp(t,btn){navigator.clipboard.writeText(t);btn.textContent="Copied";setTimeout(()=>btn.textContent="Copy",1500);}function cpAll(){navigator.clipboard.writeText((window._lastLinks||[]).join("\n"));alert("All copied!");}async function loadLinks(){const links=await fetch("/admin/links",{headers:H}).then(r=>r.json());const el=document.getElementById("linksTable");if(!links.length){el.innerHTML="<p style=color:#555;font-size:13px>No links</p>";return;}el.innerHTML="<table><tr><th>Link</th><th>Created</th></tr>"+links.map(l=>"<tr><td><code style=font-size:11px>/buy/"+l.id+"</code> <button class=cb onclick=\"cp(\'"+BASE+"/buy/"+l.id+"\',this)\">Copy</button></td><td style=color:#666;font-size:12px>"+new Date(l.createdAt).toLocaleString()+"</td></tr>").join("")+"</table>";}loadVideos();loadLinks();</script></body></html>';
}

function errorPage(title, msg) {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><title>' + title + '</title><style>body{font-family:system-ui,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;min-height:100vh;text-align:center;padding:24px}.card{max-width:400px}h1{font-size:22px;margin-bottom:12px}p{color:#888;font-size:15px}</style></head><body><div class="card"><h1>' + title + '</h1><p>' + msg + '</p></div></body></html>';
}

app.listen(PORT, () => {
  console.log('Server running on port ' + PORT);
});
