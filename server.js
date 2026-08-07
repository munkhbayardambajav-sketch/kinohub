const express = require('express');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { nanoid } = require('nanoid');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;

const s3 = new S3Client({
  region: 'auto',
  endpoint: `https://${process.env.CF_ACCOUNT_ID}.r2.cloudflarestorage.com`,
  credentials: {
    accessKeyId: process.env.R2_ACCESS_KEY_ID,
    secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
  },
});
const BUCKET = process.env.R2_BUCKET_NAME || 'videos';

// PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL ? { rejectUnauthorized: false } : false
});

async function initDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS videos (
      id TEXT PRIMARY KEY,
      key TEXT,
      filename TEXT,
      size BIGINT,
      content_type TEXT,
      uploaded_at BIGINT
    );
    CREATE TABLE IF NOT EXISTS links (
      id TEXT PRIMARY KEY,
      video_id TEXT,
      created_at BIGINT,
      activated_at BIGINT,
      device_token TEXT,
      sender_psid TEXT
    );
    ALTER TABLE links ADD COLUMN IF NOT EXISTS sender_psid TEXT;
    CREATE TABLE IF NOT EXISTS admin_sessions (
      id INTEGER PRIMARY KEY DEFAULT 1,
      token TEXT
    );
    INSERT INTO admin_sessions (id, token) VALUES (1, NULL) ON CONFLICT DO NOTHING;
  `);
  console.log('PostgreSQL DB initialized');
}

const db = {
  async saveVideo(id, video) {
    await pool.query(
      `INSERT INTO videos (id, key, filename, size, content_type, uploaded_at)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET key=$2, filename=$3, size=$4, content_type=$5, uploaded_at=$6`,
      [id, video.key, video.filename, video.size, video.contentType, video.uploadedAt]
    );
  },
  async getVideo(id) {
    const r = await pool.query('SELECT * FROM videos WHERE id=$1', [id]);
    if (!r.rows[0]) return null;
    const v = r.rows[0];
    return { id: v.id, key: v.key, filename: v.filename, size: v.size, contentType: v.content_type, uploadedAt: Number(v.uploaded_at) };
  },
  async getLatestVideo() {
    const r = await pool.query('SELECT * FROM videos ORDER BY uploaded_at DESC LIMIT 1');
    if (!r.rows[0]) return null;
    const v = r.rows[0];
    return { id: v.id, key: v.key, filename: v.filename, size: v.size, contentType: v.content_type, uploadedAt: Number(v.uploaded_at) };
  },
  async getAllVideos() {
    const r = await pool.query('SELECT * FROM videos ORDER BY uploaded_at ASC');
    return r.rows.map(v => ({ id: v.id, key: v.key, filename: v.filename, size: v.size, contentType: v.content_type, uploadedAt: Number(v.uploaded_at) }));
  },
  async saveLink(id, link) {
    await pool.query(
      `INSERT INTO links (id, video_id, created_at, activated_at, device_token, sender_psid)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (id) DO UPDATE SET video_id=$2, created_at=$3, activated_at=$4, device_token=$5, sender_psid=$6`,
      [id, link.videoId, link.createdAt, link.activatedAt || null, link.deviceToken || null, link.senderPsid || null]
    );
  },
  async getLinkBySender(psid) {
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const r = await pool.query(
      'SELECT * FROM links WHERE sender_psid=$1 AND created_at > $2 ORDER BY created_at DESC LIMIT 1',
      [psid, cutoff]
    );
    if (!r.rows[0]) return null;
    const l = r.rows[0];
    return { id: l.id, videoId: l.video_id, createdAt: Number(l.created_at), activatedAt: l.activated_at ? Number(l.activated_at) : null, deviceToken: l.device_token, senderPsid: l.sender_psid };
  },
  async getLink(id) {
    const r = await pool.query('SELECT * FROM links WHERE id=$1', [id]);
    if (!r.rows[0]) return null;
    const l = r.rows[0];
    return { id: l.id, videoId: l.video_id, createdAt: Number(l.created_at), activatedAt: l.activated_at ? Number(l.activated_at) : null, deviceToken: l.device_token };
  },
  async getAllLinks() {
    const r = await pool.query('SELECT * FROM links ORDER BY created_at ASC');
    return r.rows.map(l => ({ id: l.id, videoId: l.video_id, createdAt: Number(l.created_at), activatedAt: l.activated_at ? Number(l.activated_at) : null, deviceToken: l.device_token }));
  },
  async setAdminSession(token) {
    await pool.query('UPDATE admin_sessions SET token=$1 WHERE id=1', [token]);
  },
  async getAdminSession() {
    const r = await pool.query('SELECT token FROM admin_sessions WHERE id=1');
    return r.rows[0] ? r.rows[0].token : null;
  },
  async updateLink(id, fields) {
    await pool.query(
      'UPDATE links SET activated_at=$2, device_token=$3 WHERE id=$1',
      [id, fields.activatedAt || null, fields.deviceToken || null]
    );
  }
};

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function parseCookies(req) {
  const cookies = {};
  (req.headers.cookie || '').split(';').forEach(part => {
    const [k, ...v] = part.trim().split('=');
    if (k) cookies[k.trim()] = v.join('=');
  });
  return cookies;
}

async function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const session = await db.getAdminSession();
  if (session && cookies.admin_session === session) return next();
  res.redirect('/admin');
}

app.get('/admin', async (req, res) => {
  const cookies = parseCookies(req);
  const session = await db.getAdminSession();
  if (session && cookies.admin_session === session) return res.redirect('/admin/dashboard');
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><title>Admin</title><style>body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{background:#1a1a1a;padding:40px;border-radius:12px;width:320px}h2{margin:0 0 24px;text-align:center}input{width:100%;padding:12px;margin-bottom:16px;border:1px solid #333;background:#111;color:#fff;border-radius:8px;box-sizing:border-box;font-size:14px}button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}</style></head><body><div class="box"><h2>Admin</h2><form method="POST" action="/admin/login"><input type="text" name="username" placeholder="\u041d\u044d\u0432\u0442\u0440\u044d\u0445 \u043d\u044d\u0440" required><input type="password" name="password" placeholder="\u041d\u0443\u0443\u0446 \u04af\u0433" required><button type="submit">\u041d\u044d\u0432\u0442\u0440\u044d\u0445</button></form></div></body></html>');
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USER || 'admin') && password === (process.env.ADMIN_PASS || 'Admin1234!')) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.setAdminSession(token);
    res.setHeader('Set-Cookie', 'admin_session=' + token + '; HttpOnly; Path=/; Max-Age=86400');
    return res.redirect('/admin/dashboard');
  }
  res.send('<script>alert("\u041d\u044d\u0432\u0442\u0440\u044d\u0445 \u043d\u044d\u0440 \u044d\u0441\u0432\u044d\u043b \u043d\u0443\u0443\u0446 \u04af\u0433 \u0431\u0443\u0440\u0443\u0443"); history.back();<\/script>');
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const videos = await db.getAllVideos();
  const links = await db.getAllLinks();
  const latestVideo = videos.length ? videos[videos.length - 1] : null;
  const activeCount = links.filter(l => l.activatedAt && Date.now() - l.activatedAt < 24*3600*1000).length;
  const unusedCount = links.filter(l => !l.activatedAt).length;
  const rows = links.slice(-20).reverse().map(l => {
    const a = l.activatedAt && Date.now() - l.activatedAt < 24*3600*1000;
    const u = !l.activatedAt;
    const badge = u ? '<span style="background:#451a03;color:#fcd34d;padding:2px 8px;border-radius:4px;font-size:12px">\u0410\u0448\u0438\u0433\u043b\u0430\u0430\u0433\u04af\u0439</span>' : a ? '<span style="background:#064e3b;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:12px">\u0418\u0434\u044d\u0432\u0445\u0442\u044d\u0439</span>' : '<span style="background:#450a0a;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:12px">\u0414\u0443\u0443\u0441\u0441\u0430\u043d</span>';
    return '<tr><td><a href="/watch/' + l.id + '" target="_blank" style="color:#a5b4fc">' + l.id + '</a></td><td>' + new Date(l.createdAt).toLocaleString('mn-MN') + '</td><td>' + badge + '</td><td>' + (l.activatedAt ? new Date(l.activatedAt).toLocaleString('mn-MN') : '-') + '</td></tr>';
  }).join('');
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Dashboard</title><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;margin:0;padding:20px}h1{color:#6366f1;margin-bottom:24px}.card{background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:20px}.card h2{margin:0 0 16px;font-size:18px;color:#a5b4fc}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;margin:4px}.btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#4f46e5}input[type=file]{width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:8px;font-size:14px;margin-bottom:12px}.stat{display:inline-block;background:#111;padding:12px 20px;border-radius:8px;margin:4px;text-align:center}.stat-num{font-size:28px;font-weight:bold;color:#6366f1}.stat-label{font-size:12px;color:#9ca3af}#progress-bar{width:0%;height:8px;background:#6366f1;border-radius:4px;transition:width 0.3s}#progress-wrap{background:#222;border-radius:4px;margin-top:8px;display:none}#status-msg{margin-top:8px;font-size:14px;color:#9ca3af}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #222}th{color:#9ca3af;font-weight:normal}</style></head><body><h1>Admin Dashboard</h1><div class="card"><h2>\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a</h2><div class="stat"><div class="stat-num">' + videos.length + '</div><div class="stat-label">\u041d\u0438\u0439\u0442 \u0432\u0438\u0434\u0435\u043e</div></div><div class="stat"><div class="stat-num">' + links.length + '</div><div class="stat-label">\u041d\u0438\u0439\u0442 \u043b\u0438\u043d\u043a</div></div><div class="stat"><div class="stat-num">' + activeCount + '</div><div class="stat-label">\u0418\u0434\u044d\u0432\u0445\u0442\u044d\u0439</div></div><div class="stat"><div class="stat-num">' + unusedCount + '</div><div class="stat-label">\u0410\u0448\u0438\u0433\u043b\u0430\u0430\u0433\u04af\u0439</div></div></div><div class="card"><h2>\u0412\u0438\u0434\u0435\u043e \u043e\u0440\u0443\u0443\u043b\u0430\u0445</h2>' + (latestVideo ? '<p style="color:#6ee7b7;font-size:14px;margin-bottom:12px">\u041e\u0434\u043e\u043e\u0433\u0438\u0439\u043d \u0432\u0438\u0434\u0435\u043e: <strong>' + (latestVideo.filename||latestVideo.id) + '</strong></p>' : '') + '<input type="file" id="video-file" accept="video/*"><div id="progress-wrap"><div id="progress-bar"></div></div><div id="status-msg"></div><button class="btn btn-primary" onclick="uploadVideo()" style="margin-top:8px">\u0411\u0430\u0439\u0440\u0448\u0443\u0443\u043b\u0430\u0445</button></div><div class="card"><h2>\u041b\u0438\u043d\u043a \u04af\u04af\u0441\u0433\u044d\u0445</h2><button class="btn btn-primary" onclick="createLink()">\u0428\u0438\u043d\u044d \u043b\u0438\u043d\u043a \u04af\u04af\u0441\u0433\u044d\u0445</button><div id="link-result" style="margin-top:12px"></div></div><div class="card"><h2>\u041b\u0438\u043d\u043a\u04af\u04af\u0434</h2><table><tr><th>\u041b\u0438\u043d\u043a ID</th><th>\u04ae\u04af\u0441\u0433\u044d\u0441\u044d\u043d</th><th>\u0421\u0442\u0430\u0442\u0443\u0441</th><th>\u041d\u044d\u044d\u0441\u044d\u043d</th></tr>' + rows + '</table></div><script>async function uploadVideo(){const file=document.getElementById("video-file").files[0];if(!file)return alert("\u0424\u0430\u0439\u043b \u0441\u043e\u043d\u0433\u043e\u043d\u043e \u0443\u0443");const s=document.getElementById("status-msg"),pw=document.getElementById("progress-wrap"),pb=document.getElementById("progress-bar");s.textContent="URL \u0430\u0432\u0447 \u0431\u0430\u0439\u043d\u0430...";pw.style.display="block";try{const r1=await fetch("/admin/get-upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type})});const{uploadUrl,key}=await r1.json();s.textContent="\u0411\u0430\u0439\u0440\u0448\u0443\u0443\u043b\u0436 \u0431\u0430\u0439\u043d\u0430...";await new Promise((res,rej)=>{const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable)pb.style.width=(e.loaded/e.total*100)+"%"};x.onload=()=>x.status<300?res():rej(new Error(x.status));x.onerror=rej;x.open("PUT",uploadUrl);x.setRequestHeader("Content-Type",file.type);x.send(file)});s.textContent="\u0411\u04af\u0440\u0442\u0433\u044d\u0436 \u0431\u0430\u0439\u043d\u0430...";await fetch("/admin/register-video",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,filename:file.name,size:file.size,contentType:file.type})});s.textContent="\u0410\u043c\u0436\u0438\u043b\u0442\u0442\u0430\u0439!";pb.style.background="#10b981";setTimeout(()=>location.reload(),1500)}catch(e){s.textContent="\u0410\u043b\u0434\u0430\u0430: "+e.message;pb.style.background="#ef4444"}}async function createLink(){const r=await fetch("/admin/create-link",{method:"POST"});const d=await r.json();if(d.linkUrl){document.getElementById("link-result").innerHTML="<div style=\\"background:#111;padding:12px;border-radius:8px;word-break:break-all\\"><a href=\\""+d.linkUrl+"\\" target=\\"_blank\\" style=\\"color:#6ee7b7\\">"+d.linkUrl+"</a></div>"}else{document.getElementById("link-result").innerHTML="<p style=\\"color:#f87171\\">"+(d.error||"\u0410\u043b\u0434\u0430\u0430")+"</p>"}}<\/script></body></html>');
});

app.post('/admin/get-upload-url', requireAdmin, async (req, res) => {
  try {
    const { filename, contentType } = req.body;
    const ext = path.extname(filename) || '.mp4';
    const key = 'videos/' + nanoid(16) + ext;
    const command = new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType || 'video/mp4' });
    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.json({ uploadUrl, key });
  } catch (err) { console.error('get-upload-url error:', err); res.status(500).json({ error: err.message }); }
});

app.post('/admin/register-video', requireAdmin, async (req, res) => {
  try {
    const { key, filename, size, contentType } = req.body;
    const id = nanoid(10);
    await db.saveVideo(id, { id, key, filename, size, contentType, uploadedAt: Date.now() });
    res.json({ id, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/create-link', requireAdmin, async (req, res) => {
  const video = await db.getLatestVideo();
  if (!video) return res.json({ error: '\u0412\u0438\u0434\u0435\u043e \u0431\u0430\u0439\u0445\u0433\u04af\u0439 \u0431\u0430\u0439\u043d\u0430' });
  const linkId = nanoid(10);
  await db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
  const baseUrl = process.env.BASE_URL || ('https://' + req.headers.host);
  res.json({ linkId, linkUrl: baseUrl + '/watch/' + linkId });
});

app.get('/admin/videos', requireAdmin, async (req, res) => res.json(await db.getAllVideos()));
app.get('/admin/links', requireAdmin, async (req, res) => res.json(await db.getAllLinks()));

app.get('/watch/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const link = await db.getLink(linkId);
    if (!link) {
      return res.status(404).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:Arial"><h2>\u041b\u0438\u043d\u043a \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439</h2></body></html>');
    }
    const age = Date.now() - link.createdAt;
    if (age > 24 * 60 * 60 * 1000) {
      return res.status(410).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:Arial"><h2>\u23f0 \u041b\u0438\u043d\u043a\u0438\u0439\u043d \u0445\u0443\u0433\u0430\u0446\u0430\u0430 \u0434\u0443\u0443\u0441\u0441\u0430\u043d</h2><p style="color:#9ca3af;margin-top:12px">24 \u0446\u0430\u0433\u0438\u0439\u043d \u0445\u0443\u0433\u0430\u0446\u0430\u0430 \u04e9\u043d\u0433\u04e9\u0440\u0441\u04e9\u043d \u0431\u0430\u0439\u043d\u0430</p></body></html>');
    }
    const video = await db.getVideo(link.videoId);
    if (!video) {
      return res.status(404).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:Arial"><h2>\u0412\u0438\u0434\u0435\u043e \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439</h2></body></html>');
    }
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.key || video.filename });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const html = '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>\u0412\u0438\u0434\u0435\u043e</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;justify-content:center;align-items:center;min-height:100vh}video{max-width:100%;width:100%}</style></head><body><video controls autoplay controlsList="nodownload" oncontextmenu="return false"><source src="' + signedUrl + '" type="video/mp4"></video></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Watch error:', err);
    res.status(500).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:Arial"><h2>\u0410\u043b\u0434\u0430\u0430 \u0433\u0430\u0440\u043b\u0430\u0430</h2><p>' + (err.message || '') + '</p></body></html>');
  }
});

app.get('/stream/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const link = await db.getLink(linkId);
  if (!link) return res.status(404).json({ error: '\u041b\u0438\u043d\u043a \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439' });
  const cookies = parseCookies(req);
  const cookieToken = cookies['v_' + linkId];
  if (!link.activatedAt || Date.now() - link.activatedAt > 72 * 3600 * 1000) return res.status(403).json({ error: '\u0425\u0443\u0433\u0430\u0446\u0430\u0430 \u0434\u0443\u0443\u0441\u0441\u0430\u043d' });
  if (!link.deviceToken || cookieToken !== link.deviceToken) return res.status(403).json({ error: '\u0417\u04e9\u0432\u0448\u04e9\u04e9\u0440\u04e9\u043b\u0433\u04af\u0439' });
  const video = await db.getVideo(link.videoId);
  if (!video) return res.status(404).json({ error: '\u0412\u0438\u0434\u0435\u043e \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439' });
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.key || video.filename });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.redirect(signedUrl);
  } catch (err) { console.error('stream error:', err); res.status(500).json({ error: err.message }); }
});

function playerPage(linkId) {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>\u0412\u0438\u0434\u0435\u043e</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Arial,sans-serif;user-select:none}#player{width:100%;max-width:900px;aspect-ratio:16/9;background:#111;border-radius:8px;overflow:hidden}video{width:100%;height:100%}.info{margin-top:14px;font-size:13px;color:#6b7280;text-align:center}.warn{margin-top:6px;font-size:12px;color:#f59e0b;text-align:center}</style><script>document.addEventListener("contextmenu",e=>e.preventDefault());document.addEventListener("keydown",e=>{if(e.key==="F12"||(e.ctrlKey&&e.shiftKey&&["I","J","C","K"].includes(e.key))||(e.ctrlKey&&e.key==="U"))e.preventDefault();});<\/script></head><body><div id="player"><video controls autoplay controlsList="nodownload" disablePictureInPicture oncontextmenu="return false"><source src="/stream/' + linkId + '" type="video/mp4">\u0414\u044d\u043c\u0436\u0438\u0445\u0433\u04af\u0439 \u0431\u0430\u0439\u043d\u0430.</video></div><div class="info">72 \u0446\u0430\u0433\u0438\u0439\u043d \u0434\u043e\u0442\u043e\u0440 \u04af\u0437\u044d\u0445 \u0431\u043e\u043b\u043e\u043c\u0436\u0442\u043e\u0439</div><div class="warn">\u041b\u0438\u043d\u043a \u0437\u04e9\u0432\u0445\u04e9\u043d \u0442\u0430\u043d\u044b \u0442\u04e9\u0445\u04e9\u04e9\u0440\u04e9\u043c\u0436\u0438\u0434 \u0430\u0436\u0438\u043b\u043b\u0430\u043d\u0430 \u2014 \u0434\u0430\u043c\u0436\u0443\u0443\u043b\u0431\u0430\u043b \u0430\u0436\u0438\u043b\u043b\u0430\u0445\u0433\u04af\u0439</div></body></html>';
}

// Facebook Messenger Bot
app.get('/webhook', (req, res) => {
  const mode = req.query['hub.mode'];
  const token = req.query['hub.verify_token'];
  const challenge = req.query['hub.challenge'];
  if (mode === 'subscribe' && token === process.env.FB_VERIFY_TOKEN) {
    res.status(200).send(challenge);
  } else { res.status(403).end(); }
});

app.post('/webhook', async (req, res) => {
  const body = req.body;
  if (body.object !== 'page') return res.status(404).end();
  res.status(200).send('EVENT_RECEIVED');
  for (const entry of (body.entry || [])) {
    const pageToken = getPageToken(entry.id);
    for (const event of (entry.messaging || [])) {
      const senderId = event.sender && event.sender.id;
      if (!senderId || senderId === entry.id) continue;
      if (event.message) {
        const isRealImage = (event.message.attachments || []).some(a => a.type === 'image' && !(a.payload && a.payload.sticker_id));
        if (isRealImage) {
          const imgAtt = (event.message.attachments || []).find(a => a.type === 'image' && !(a.payload && a.payload.sticker_id));
          const imageUrl = imgAtt && imgAtt.payload && imgAtt.payload.url;
          await handlePaymentScreenshot(senderId, imageUrl, pageToken);
        } else if (event.message.text && !event.message.is_echo) {
          await sendBankInfo(senderId, pageToken);
        }
      }
    }
    for (const change of (entry.changes || [])) {
      console.log('CHANGE:', JSON.stringify(change).slice(0, 300));
      if (change.field === 'feed' && change.value) {
        const item = change.value.item;
        const comment = (change.value.message || '').trim();
        const commentId = change.value.comment_id;
        console.log('FEED item:', item, 'comment:', comment, 'commentId:', commentId);
        if (item === 'comment' && commentId) {
          if (comment === '1' || /\u0430\u0432\u043d\u0430|\u04af\u0437\u043d\u044d|\u0430\u0432\u043c\u0430\u0430\u0440/i.test(comment)) {
            await sendPrivateReply(commentId, pageToken);
          }
        }
      }
    }
  }
});

function getPageToken(pageId) {
  const tokens = {};
  if (process.env.FB_PAGE_ID_1 && process.env.FB_PAGE_TOKEN_1) tokens[process.env.FB_PAGE_ID_1] = process.env.FB_PAGE_TOKEN_1;
  if (process.env.FB_PAGE_ID_2 && process.env.FB_PAGE_TOKEN_2) tokens[process.env.FB_PAGE_ID_2] = process.env.FB_PAGE_TOKEN_2;
  return tokens[pageId] || process.env.FB_PAGE_TOKEN || null;
}

async function sendBankInfo(recipientId, pageToken) {
      await sendFbMessage(recipientId, `Кино үзэхийг хүсвэл доорх зааврыг дагаарай:\nТөлбөр шилжүүлэх мэдээлэл:\n\nБанк: Хаан банк\nДансны дугаар: mn 54000 500 5300692947\nДанс эзэмшигч: Дамбажав Мөнхбаяр\nТөлбөрийн дүн: 5000 төгрөг\n\nГүйлгээний утга (заавал бичнэ!):\n→ Өөрийн Facebook нэрээ бичээрэй\nДараагийн алхам:\n\nГүйлгээ амжилттай болсны скриншотыг авна уу\nЭнэ чат руу явуулна уу\n\nХугацаа:\n\nТөлбөр баталгаажсаны дараа линк автоматаар ирнэ\nЛинк 24 цаг (1 хоног) хүчинтэй байна`);
}

async function handlePaymentScreenshot(senderId, imageUrl, pageToken) {
  try {
    console.log('imageUrl:', imageUrl ? 'present' : 'missing');

    if (!imageUrl) {
      await sendFbMessage(senderId, '\u0417\u0443\u0440\u0430\u0433\u043d\u044b \u043b\u0438\u043d\u043a \u0430\u043b\u0434\u0441\u0430\u043d. \u0414\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.', pageToken);
      return;
    }

    const imgRes = await fetch(imageUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64Img = Buffer.from(imgBuffer).toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: base64Img } },
          { type: 'text', text: 'This is a bank transfer screenshot. Does it contain the account number 5300692947 anywhere (including in IBAN format like MN54 000500 5300692947, or with spaces/dashes between digits)? Reply with only YES or NO.' }
        ]}]
      })
    });
    const claudeData = await claudeRes.json();
    const rawText = ((claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '').trim().toUpperCase();
    console.log('Claude account check:', rawText);

    const accountOk = rawText.startsWith('YES');

    if (!accountOk) {
      await sendFbMessage(senderId, '\u274c \u0414\u0430\u043d\u0441\u043d\u044b \u0434\u0443\u0433\u0430\u0430\u0440 \u0442\u0430\u0430\u0440\u0441\u0430\u043d\u0433\u04af\u0439.\n\n\u0428\u0438\u043b\u0436\u04af\u04af\u043b\u044d\u0445 \u0434\u0430\u043d\u0441: MN54 000500 5300692947 (\u0425\u0430\u0430\u043d \u0431\u0430\u043d\u043a)\n\n\u0417\u04e9\u0432 \u0434\u0430\u043d\u0441\u0430\u043d\u0434 \u0448\u0438\u043b\u0436\u04af\u04af\u043b\u044d\u044d\u0434 screenshot \u0434\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.', pageToken);
      return;
    }

    // \u0425\u044d\u0440\u044d\u0432 \u044d\u043d\u044d \u0445\u04af\u043d 24 \u0446\u0430\u0433\u0442 \u0430\u043b\u044c \u0445\u044d\u0434\u0438\u0439\u043d \u043b\u0438\u043d\u043a \u0430\u0432\u0441\u0430\u043d \u0431\u043e\u043b \u0434\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430
    const existingLink = await db.getLinkBySender(senderId);
    if (existingLink) {
      const existingUrl = process.env.BASE_URL + '/watch/' + existingLink.id;
      await sendFbMessage(senderId, '\u2705 \u0422\u0430\u043d\u044b \u043b\u0438\u043d\u043a \u0430\u043b\u044c \u0445\u044d\u0434\u0438\u0439\u043d \u04af\u04af\u0441\u0441\u044d\u043d \u0431\u0430\u0439\u043d\u0430!\n\n' + existingUrl + '\n\n\u23f0 24 \u0446\u0430\u0433\u0438\u0439\u043d \u0434\u043e\u0442\u043e\u0440 \u04af\u0437\u043d\u044d \u04af\u04af.', pageToken);
      return;
    }
    const video = await db.getLatestVideo();
    if (!video) { await sendFbMessage(senderId, '\u041e\u0434\u043e\u043e\u0433\u043e\u043e\u0440 \u0438\u0434\u044d\u0432\u0445\u0442\u044d\u0439 \u0432\u0438\u0434\u0435\u043e \u0431\u0430\u0439\u0445\u0433\u04af\u0439.', pageToken); return; }
    const linkId = nanoid(10);
    await db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now(), senderPsid: senderId });
    const linkUrl = process.env.BASE_URL + '/watch/' + linkId;
    await sendFbMessage(senderId, '\u2705 \u0422\u04e9\u043b\u0431\u04e9\u0440 \u0431\u0430\u0442\u0430\u043b\u0433\u0430\u0430\u0436\u043b\u0430\u0430!\n\n\u0422\u0430\u043d\u044b \u0432\u0438\u0434\u0435\u043e \u043b\u0438\u043d\u043a:\n' + linkUrl + '\n\n\u23f0 24 \u0446\u0430\u0433\u0438\u0439\u043d \u0434\u043e\u0442\u043e\u0440 \u04af\u0437\u043d\u044d \u04af\u04af.', pageToken);
  } catch(err) {
    console.error('Screenshot error:', err);
    await sendFbMessage(senderId, '\u0421\u043a\u0440\u0438\u0439\u043d\u0448\u043e\u0442 \u0431\u043e\u043b\u043e\u0432\u0441\u0440\u0443\u0443\u043b\u0430\u0445\u0430\u0434 \u0430\u043b\u0434\u0430\u0430 \u0433\u0430\u0440\u043b\u0430\u0430. \u0414\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.', pageToken);
  }
}

async function sendFbMessage(recipientId, text, pageToken) {
  pageToken = pageToken || process.env.FB_PAGE_TOKEN;
  if (!pageToken) return;
  try {
    const r = await fetch('https://graph.facebook.com/v19.0/me/messages?access_token=' + pageToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ recipient: { id: recipientId }, message: { text } }),
    });
    const data = await r.json();
    if (data.error) console.error('FB send error:', JSON.stringify(data.error));
  } catch (err) { console.error('sendFbMessage error:', err); }
}

async function sendPrivateReply(commentId, pageToken) {
  pageToken = pageToken || process.env.FB_PAGE_TOKEN;
  if (!pageToken) return;
  const message = `✅ Кино үзэхийг хүсвэл дараах мэдээллээр төлбөр төлнө үү:

💰 Төлбөр шилжүүлэх мэдээлэл:
• Банк: Хаан банк 🏦
• Дансны дугаар: MN54 000500 5300692947
• Төлбөрийн дүн: 5000 төгрөг

📸 Гүйлгээний screenshot-г энэ чатруу явуулна уу — линк автоматаар ирнэ!
⏰ Линк 24 цаг хүчинтэй байна.`;
  try {
    const r = await fetch('https://graph.facebook.com/v19.0/' + commentId + '/private_replies?access_token=' + pageToken, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await r.json();
    if (data.error) console.error('Private reply error:', JSON.stringify(data.error));
    else console.log('Private reply sent to comment:', commentId);
  } catch (err) { console.error('sendPrivateReply error:', err); }
}

app.get('/admin/backfill-preview', requireAdmin, async (req, res) => { try { const pageId = req.query.pageId || '61585957412843'; const pageToken = getPageToken(pageId); if (!pageToken) return res.status(400).json({ error: 'no token for pageId' }); const hoursAgo = Number(req.query.hoursAgo || 3); const cutoff = Date.now() - hoursAgo * 3600 * 1000; const sevenDaysAgo = Date.now() - 7 * 24 * 3600 * 1000; const reelsRes = await fetch('https://graph.facebook.com/v19.0/' + pageId + '/videos?fields=id,created_time,description&limit=10&access_token=' + pageToken); const reelsData = await reelsRes.json(); if (reelsData.error) return res.status(400).json({ error: reelsData.error }); const results = []; for (const reel of (reelsData.data || [])) { let url = 'https://graph.facebook.com/v19.0/' + reel.id + '/comments?fields=id,message,created_time,from&limit=200&access_token=' + pageToken; while (url) { const cRes = await fetch(url); const cData = await cRes.json(); if (cData.error) break; for (const c of (cData.data || [])) { const text = (c.message || '').trim(); const created = new Date(c.created_time).getTime(); if (text === '2' && created < cutoff && created > sevenDaysAgo) { results.push({ reelId: reel.id, commentId: c.id, name: c.from ? c.from.name : 'unknown', createdTime: c.created_time }); } } url = (cData.paging && cData.paging.next) ? cData.paging.next : null; } } res.json({ pageId: pageId, reelsChecked: (reelsData.data || []).length, matchCount: results.length, results: results }); } catch (err) { res.status(500).json({ error: err.message }); } }); app.post('/admin/backfill-send', requireAdmin, async (req, res) => { try { const commentIds = req.body.commentIds; const pageId = req.body.pageId || '61585957412843'; if (!Array.isArray(commentIds) || !commentIds.length) return res.status(400).json({ error: 'commentIds required' }); const pageToken = getPageToken(pageId); let sent = 0; for (const commentId of commentIds) { await sendPrivateReply(commentId, pageToken); sent++; await new Promise(r => setTimeout(r, 350)); } res.json({ sent: sent }); } catch (err) { res.status(500).json({ error: err.message }); } });
initDb().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
