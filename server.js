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
      device_token TEXT
    );
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
      `INSERT INTO links (id, video_id, created_at, activated_at, device_token)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (id) DO UPDATE SET video_id=$2, created_at=$3, activated_at=$4, device_token=$5`,
      [id, link.videoId, link.createdAt, link.activatedAt || null, link.deviceToken || null]
    );
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
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><title>Admin</title><style>body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{background:#1a1a1a;padding:40px;border-radius:12px;width:320px}h2{margin:0 0 24px;text-align:center}input{width:100%;padding:12px;margin-bottom:16px;border:1px solid #333;background:#111;color:#fff;border-radius:8px;box-sizing:border-box;font-size:14px}button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}</style></head><body><div class="box"><h2>Admin</h2><form method="POST" action="/admin/login"><input type="text" name="username" placeholder="ÐÑÐ²ÑÑÑÑ Ð½ÑÑ" required><input type="password" name="password" placeholder="ÐÑÑÑ Ò¯Ð³" required><button type="submit">ÐÑÐ²ÑÑÑÑ</button></form></div></body></html>');
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USER || 'admin') && password === (process.env.ADMIN_PASS || 'Admin1234!')) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.setAdminSession(token);
    res.setHeader('Set-Cookie', 'admin_session=' + token + '; HttpOnly; Path=/; Max-Age=86400');
    return res.redirect('/admin/dashboard');
  }
  res.send('<script>alert("ÐÑÐ²ÑÑÑÑ Ð½ÑÑ ÑÑÐ²ÑÐ» Ð½ÑÑÑ Ò¯Ð³ Ð±ÑÑÑÑ"); history.back();<\/script>');
});

app.get('/admin/dashboard', requireAdmin, async (req, res) => {
  const videos = await db.getAllVideos();
  const links = await db.getAllLinks();
  const latestVideo = videos.length ? videos[videos.length - 1] : null;
  const activeCount = links.filter(l => l.activatedAt && Date.now() - l.activatedAt < 72*3600*1000).length;
  const unusedCount = links.filter(l => !l.activatedAt).length;
  const rows = links.slice(-20).reverse().map(l => {
    const a = l.activatedAt && Date.now() - l.activatedAt < 72*3600*1000;
    const u = !l.activatedAt;
    const badge = u ? '<span style="background:#451a03;color:#fcd34d;padding:2px 8px;border-radius:4px;font-size:12px">ÐÑÐ¸Ð³Ð»Ð°Ð°Ð³Ò¯Ð¹</span>' : a ? '<span style="background:#064e3b;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:12px">ÐÐ´ÑÐ²ÑÑÑÐ¹</span>' : '<span style="background:#450a0a;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:12px">ÐÑÑÑÑÐ°Ð½</span>';
    return '<tr><td><a href="/watch/' + l.id + '" target="_blank" style="color:#a5b4fc">' + l.id + '</a></td><td>' + new Date(l.createdAt).toLocaleString('mn-MN') + '</td><td>' + badge + '</td><td>' + (l.activatedAt ? new Date(l.activatedAt).toLocaleString('mn-MN') : '-') + '</td></tr>';
  }).join('');
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Dashboard</title><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;margin:0;padding:20px}h1{color:#6366f1;margin-bottom:24px}.card{background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:20px}.card h2{margin:0 0 16px;font-size:18px;color:#a5b4fc}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;margin:4px}.btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#4f46e5}input[type=file]{width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:8px;font-size:14px;margin-bottom:12px}.stat{display:inline-block;background:#111;padding:12px 20px;border-radius:8px;margin:4px;text-align:center}.stat-num{font-size:28px;font-weight:bold;color:#6366f1}.stat-label{font-size:12px;color:#9ca3af}#progress-bar{width:0%;height:8px;background:#6366f1;border-radius:4px;transition:width 0.3s}#progress-wrap{background:#222;border-radius:4px;margin-top:8px;display:none}#status-msg{margin-top:8px;font-size:14px;color:#9ca3af}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #222}th{color:#9ca3af;font-weight:normal}</style></head><body><h1>Admin Dashboard</h1><div class="card"><h2>Ð¡ÑÐ°ÑÐ¸ÑÑÐ¸Ðº</h2><div class="stat"><div class="stat-num">' + videos.length + '</div><div class="stat-label">ÐÐ¸Ð¹Ñ Ð²Ð¸Ð´ÐµÐ¾</div></div><div class="stat"><div class="stat-num">' + links.length + '</div><div class="stat-label">ÐÐ¸Ð¹Ñ Ð»Ð¸Ð½Ðº</div></div><div class="stat"><div class="stat-num">' + activeCount + '</div><div class="stat-label">ÐÐ´ÑÐ²ÑÑÑÐ¹</div></div><div class="stat"><div class="stat-num">' + unusedCount + '</div><div class="stat-label">ÐÑÐ¸Ð³Ð»Ð°Ð°Ð³Ò¯Ð¹</div></div></div><div class="card"><h2>ÐÐ¸Ð´ÐµÐ¾ Ð¾ÑÑÑÐ»Ð°Ñ</h2>' + (latestVideo ? '<p style="color:#6ee7b7;font-size:14px;margin-bottom:12px">ÐÐ´Ð¾Ð¾Ð³Ð¸Ð¹Ð½ Ð²Ð¸Ð´ÐµÐ¾: <strong>' + (latestVideo.filename||latestVideo.id) + '</strong></p>' : '') + '<input type="file" id="video-file" accept="video/*"><div id="progress-wrap"><div id="progress-bar"></div></div><div id="status-msg"></div><button class="btn btn-primary" onclick="uploadVideo()" style="margin-top:8px">ÐÐ°Ð¹ÑÑÑÑÐ»Ð°Ñ</button></div><div class="card"><h2>ÐÐ¸Ð½Ðº Ò¯Ò¯ÑÐ³ÑÑ</h2><button class="btn btn-primary" onclick="createLink()">Ð¨Ð¸Ð½Ñ Ð»Ð¸Ð½Ðº Ò¯Ò¯ÑÐ³ÑÑ</button><div id="link-result" style="margin-top:12px"></div></div><div class="card"><h2>ÐÐ¸Ð½ÐºÒ¯Ò¯Ð´</h2><table><tr><th>ÐÐ¸Ð½Ðº ID</th><th>Ò®Ò¯ÑÐ³ÑÑÑÐ½</th><th>Ð¡ÑÐ°ÑÑÑ</th><th>ÐÑÑÑÑÐ½</th></tr>' + rows + '</table></div><script>async function uploadVideo(){const file=document.getElementById("video-file").files[0];if(!file)return alert("Ð¤Ð°Ð¹Ð» ÑÐ¾Ð½Ð³Ð¾Ð½Ð¾ ÑÑ");const s=document.getElementById("status-msg"),pw=document.getElementById("progrest-wrap"),pb=document.getElementById("progress-bar");s.textContent="URL Ð°Ð²Ñ Ð±Ð°Ð¹Ð½Ð°...";pw.style.display="block";try{const r1=await fetch("/admin/get-upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type})});const{uploadUrl,key}=await r1.json();s.textContent="ÐÐ°Ð¹ÑÑÑÑÐ»Ð¶ Ð±Ð°Ð¹Ð½Ð°...";await new Promise((res,rej)=>{const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable)pb.style.width=(e.loaded/e.total*100)+"%"};x.onload=()=>x.status<300?res():rej(new Error(x.status));x.onerror=rej;x.open("PUT",uploadUrl);x.setRequestHeader("Content-Type",file.type);x.send(file)});s.textContent="ÐÒ¯ÑÑÐ³ÑÐ¶ Ð±Ð°Ð¹Ð½Ð°...";await fetch("/admin/register-video",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,filename:file.name,size:file.size,contentType:file.type})});s.textContent="ÐÐ¼Ð¶Ð¸Ð»ÑÑÐ°Ð¹!";pb.style.background="#10b981";setTimeout(()=>location.reload(),1500)}catch(e){s.textContent="ÐÐ»Ð´Ð°Ð°: "+e.message;pb.style.background="#ef4444"}}async function createLink(){const r=await fetch("/admin/create-link",{method:"POST"});const d=await r.json();if(d.linkUrl){document.getElementById("link-result").innerHTML="<div style=\\"background:#111;padding:12px;border-radius:8px;word-break:break-all\\"><a href=\\""+d.linkUrl+"\\" target=\\"_blank\\" style=\\"color:#6ee7b7\\">"+d.linkUrl+"</a></div>"}else{document.getElementById("link-result").innerHTML="<p style=\\"color:#f87171\\">"+(d.error||"ÐÐ»Ð´Ð°Ð°")+"</p>"}}<\/script></body></html>');
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
  if (!video) return res.json({ error: 'ÐÐ¸Ð´ÐµÐ¾ Ð±Ð°Ð¹ÑÐ³Ò¯Ð¹ Ð±Ð°Ð¹Ð½Ð°' });
  const linkId = nanoid(10);
  await db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
  const baseUrl = process.env.BASE_URL || ('https://' + req.headers.host);
  res.json({ linkId, linkUrl: baseUrl + '/watch/' + linkId });
});

app.get('/admin/videos', requireAdmin, async (req, res) => res.json(await db.getAllVideos()));
app.get('/admin/links', requireAdmin, async (req, res) => res.json(await db.getAllLinks()));

// Watch: Ð½ÑÐ³ Ð»Ð¸Ð½Ðº = Ð½ÑÐ³ ÑÒ¯Ð½ = Ð½ÑÐ³ ÑÓ©ÑÓ©Ó©ÑÓ©Ð¼Ð¶
app.get('/watch/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const link = await db.getLink(linkId);
    if (!link) {
      return res.status(404).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>ÐÐ¸Ð½Ðº Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹</h2></body></html>');
    }
    const age = Date.now() - link.createdAt;
    if (age > 72 * 60 * 60 * 1000) {
      return res.status(410).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>ÐÐ¸Ð½ÐºÐ¸Ð¹Ð½ ÑÑÐ³Ð°ÑÐ°Ð° Ð´ÑÑÑÑÐ°Ð½</h2></body></html>');
    }
    const video = await db.getVideo(link.videoId);
    if (!video) {
      return res.status(404).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>ÐÐ¸Ð´ÐµÐ¾ Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹</h2></body></html>');
    }
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.key || video.filename });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const html = '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>ÐÐ¸Ð´ÐµÐ¾</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;justify-content:center;align-items:center;min-height:100vh}video{max-width:100%;width:100%}</style></head><body><video controls autoplay controlsList="nodownload" oncontextmenu="return false"><source src="' + signedUrl + '" type="video/mp4"></video></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Watch error:', err);
    res.status(500).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>ÐÐ»Ð´Ð°Ð° Ð³Ð°ÑÐ»Ð°Ð°</h2><p>' + (err.message || '') + '</p></body></html>');
  }
});

app.get('/stream/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const link = await db.getLink(linkId);
  if (!link) return res.status(404).json({ error: 'ÐÐ¸Ð½Ðº Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹' });
  const cookies = parseCookies(req);
  const cookieToken = cookies['v_' + linkId];
  if (!link.activatedAt || Date.now() - link.activatedAt > 72 * 3600 * 1000) return res.status(403).json({ error: 'Ð¥ÑÐ³Ð°ÑÐ°Ð° Ð´ÑÑÑÑÐ°Ð½' });
  if (!link.deviceToken || cookieToken !== link.deviceToken) return res.status(403).json({ error: 'ÐÓ©Ð²ÑÓ©Ó©ÑÓ©Ð»Ð³Ò¯Ð¹' });
  const video = await db.getVideo(link.videoId);
  if (!video) return res.status(404).json({ error: 'ÐÐ¸Ð´ÐµÐ¾ Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹' });
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.key });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.redirect(signedUrl);
  } catch (err) { console.error('stream error:', err); res.status(500).json({ error: err.message }); }
});

function playerPage(linkId) {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ÐÐ¸Ð´ÐµÐ¾</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Arial,sans-serif;user-select:none}#player{width:100%;max-width:900px;aspect-ratio:16/9;background:#111;border-radius:8px;overflow:hidden}video{width:100%;height:100%}.info{margin-top:14px;font-size:13px;color:#6b7280;text-align:center}.warn{margin-top:6px;font-size:12px;color:#f59e0b;text-align:center}</style><script>document.addEventListener("contextmenu",e=>e.preventDefault());document.addEventListener("keydown",e=>{if(e.key==="F12"||(e.ctrlKey&&e.shiftKey&&["I","J","C","K"].includes(e.key))||(e.ctrlKey&&e.key==="U"))e.preventDefault();});<\/script></head><body><div id="player"><video controls autoplay controlsList="nodownload" disablePictureInPicture oncontextmenu="return false"><source src="/stream/' + linkId + '" type="video/mp4">ÐÑÐ¼Ð¶Ð¸ÑÐ³Ò¯Ð¹ Ð±Ð°Ð¹Ð½Ð°.</video></div><div class="info">72 ÑÐ°Ð³Ð¸Ð¹Ð½ Ð´Ð¾ÑÐ¾Ñ Ò¯Ð·ÑÑ Ð±Ð¾Ð»Ð¾Ð¼Ð¶ÑÐ¾Ð¹</div><div class="warn">ÐÐ¸Ð½Ðº Ð·Ó©Ð²ÑÓ©Ð½ ÑÐ°Ð½Ñ ÑÓ©ÑÓ©Ó©ÑÓ©Ð¼Ð¶Ð¸Ð´ Ð°Ð¶Ð¸Ð»Ð»Ð°Ð½Ð° â Ð´Ð°Ð¼Ð¶ÑÑÐ»Ð±Ð°Ð» Ð°Ð¶Ð¸Ð»Ð»Ð°ÑÐ³Ò¯Ð¹</div></body></html>';
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
    for (const event of (entry.messaging || [])) {
      const senderId = event.sender && event.sender.id;
      if (!senderId || senderId === entry.id) continue;
      if (event.message) {
        const hasImage = (event.message.attachments || []).some(a => a.type === 'image');
        if (hasImage) {
          const imgAtt = (event.message.attachments || []).find(a => a.type === 'image');
          const imageUrl = imgAtt && imgAtt.payload && imgAtt.payload.url;
          await handlePaymentScreenshot(senderId, imageUrl);
        } else if (event.message.text) {
          await sendBankInfo(senderId);
        }
      }
    }
    for (const change of (entry.changes || [])) {
      if (change.field === 'feed' && change.value && change.value.item === 'comment') {
        const comment = (change.value.message || '').trim();
        const commenterId = change.value.from && change.value.from.id;
        if (!commenterId) continue;
        if (comment === '1' || /Ð°Ð²Ð½Ð°|Ò¯Ð·Ð½Ñ|Ð°Ð²Ð¼Ð°Ð°Ñ/i.test(comment)) {
          await sendBankInfo(commenterId);
        }
      }
    }
  }
});

async function sendBankInfo(recipientId) {
  await sendFbMessage(recipientId, `â "ÐÐ°Ð²ÑÐ½ Ð½Ð°Ð¹Ð· Ð¾ÑÐ¸Ð½" ÐºÐ¸Ð½Ð¾ Ò¯Ð·ÑÑÐ¸Ð¹Ð³ ÑÒ¯ÑÐ²ÑÐ»
ð¿ ÐÐ¸Ð½Ð¾ Ò¯Ð·ÑÑÐ¸Ð¹Ð³ ÑÒ¯ÑÐ²ÑÐ» Ð´Ð¾Ð¾ÑÑ Ð·Ð°Ð°Ð²ÑÑÐ³ Ð´Ð°Ð³Ð°Ð°ÑÐ°Ð¹:

ð° Ð¢Ó©Ð»Ð±Ó©Ñ ÑÐ¸Ð»Ð¶Ò¯Ò¯Ð»ÑÑ Ð¼ÑÐ´ÑÑÐ»ÑÐ»:
â¢ ÐÐ°Ð½Ðº: Ð¥Ð°Ð°Ð½ Ð±Ð°Ð½Ðº ð¦
â¢ ÐÐ°Ð½ÑÐ½Ñ Ð´ÑÐ³Ð°Ð°Ñ: MN54 000500 5300692947
â¢ ÐÐ°Ð½Ñ ÑÐ·ÑÐ¼ÑÐ¸Ð³Ñ: ÐÐ°Ð¼Ð±Ð°Ð¶Ð°Ð² ÐÓ©Ð½ÑÐ±Ð°ÑÑ
â¢ Ð¢Ó©Ð»Ð±Ó©ÑÐ¸Ð¹Ð½ Ð´Ò¯Ð½: 5000 ÑÓ©Ð³ÑÓ©Ð³

ð ÐÒ¯Ð¹Ð»Ð³ÑÑÐ½Ð¸Ð¹ ÑÑÐ³Ð° (Ð·Ð°Ð°Ð²Ð°Ð» Ð±Ð¸ÑÐ½Ñ!): â Ó¨Ó©ÑÐ¸Ð¹Ð½ Facebook Ð½ÑÑÑÑ Ð±Ð¸ÑÑÑÑÑÐ¹

ð¸ ÐÐ°ÑÐ°Ð°Ð³Ð¸Ð¹Ð½ Ð°Ð»ÑÐ°Ð¼:
1. ÐÒ¯Ð¹Ð»Ð³ÑÑ Ð°Ð¼Ð¶Ð¸Ð»ÑÑÐ°Ð¹ Ð±Ð¾Ð»ÑÐ½Ñ ÑÐºÑÐ¸Ð½ÑÐ¾ÑÑÐ³ Ð°Ð²Ð½Ð° ÑÑ
2. Ð­Ð½Ñ ÑÐ°Ñ ÑÑÑ ÑÐ²ÑÑÐ»Ð½Ð° ÑÑ

â° Ð¥ÑÐ³Ð°ÑÐ°Ð°:
â¢ Ð¢Ó©Ð»Ð±Ó©Ñ Ð±Ð°ÑÐ°Ð»Ð³Ð°Ð°Ð¶ÑÐ°Ð½Ñ Ð´Ð°ÑÐ°Ð° Ð»Ð¸Ð½Ðº Ð°Ð²ÑÐ¾Ð¼Ð°ÑÐ°Ð°Ñ Ð¸ÑÐ½Ñ
â¢ ÐÐ¸Ð½Ðº 72 ÑÐ°Ð³ (3 ÑÐ¾Ð½Ð¾Ð³) ÑÒ¯ÑÐ¸Ð½ÑÑÐ¹ Ð±Ð°Ð¹Ð½Ð°

â¡ ÐÓ©Ð²Ð»Ó©Ð¼Ð¶: ÐÒ¯Ð¹Ð»Ð³ÑÑ ÑÐ¸Ð¹ÑÐ´ÑÑ Ð¼ÑÐ´ÑÑÐ»Ð»Ð¸Ð¹Ð³ ÑÐ³ ÑÐ°Ñ ÑÐ°Ð»Ð³Ð°Ð°ÑÐ°Ð¹!
ÐÐ¸Ð½Ð¾ Ò¯Ð·ÑÑÑÐ´ Ð±ÑÐ»ÑÐ½ Ð±Ð¾Ð»ÑÐ¾Ð½ ÑÑ? ð`);
}

async function handlePaymentScreenshot(senderId, imageUrl) {
  try {
    const profileRes = await fetch('https://graph.facebook.com/v19.0/' + senderId + '?fields=name&access_token=' + process.env.FB_PAGE_TOKEN);
    const profile = await profileRes.json();
    const fbName = (profile.name || '').toLowerCase().trim();
    console.log('FB name:', fbName, 'imageUrl:', imageUrl ? 'present' : 'missing');

    if (!imageUrl) {
      await sendFbMessage(senderId, 'ÐÑÑÐ°Ð³Ð½Ñ Ð»Ð¸Ð½Ðº Ð°Ð»Ð´ÑÐ°Ð½. ÐÐ°ÑÐ¸Ð½ ÑÐ²ÑÑÐ»Ð½Ð° ÑÑ.');
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
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: base64Img } },
          { type: 'text', text: 'Ð­Ð½Ñ Ð±Ð°Ð½ÐºÐ½Ñ Ð³Ò¯Ð¹Ð»Ð³ÑÑÐ½Ð¸Ð¹ screenshot. ÐÐ°ÑÐ°Ð°Ñ Ð¼ÑÐ´ÑÑÐ»Ð»Ð¸Ð¹Ð³ Ð³Ð°ÑÐ³Ð°:\n1. Ð¥Ò¯Ð»ÑÑÐ½ Ð°Ð²Ð°Ð³ÑÐ¸Ð¹Ð½ Ð´Ð°Ð½ÑÐ½Ñ Ð´ÑÐ³Ð°Ð°Ñ (Ð·Ó©Ð²ÑÓ©Ð½  ÑÐ¾Ð¾)\n2. ÐÒ¯Ð¹Ð»Ð³ÑÑÐ½Ð¸Ð¹ ÑÑÐ³Ð° ÑÑÐ²ÑÐ»Ñ Ð²ÑÐ°Ð¹Ð»Ð±Ð°ÑÐ¸Ð² ÑÑÐºÑÑ\n\nÐÓ©Ð²ÑÓ©Ð½ JSON Ó©Ð³Ð½Ó© Ò¯Ò¯: {"account":"...","description":"..."}' }
        ]}]
      })
    });
    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    console.log('Claude rawText:', rawText.substring(0, 300));

    const accountOk = rawText.includes('5300692947');

    let descLower = '';
    try {
      const m = rawText.match(/description["\s]*:["\s]*"([^"]+)"/);
      if (m) descLower = m[1].toLowerCase();
    } catch(e) {}
    const nameOk = fbName && fbName.split(' ').some(part => part.length > 1 && descLower.includes(part));

    if (!accountOk) {
      await sendFbMessage(senderId, 'â ÐÐ°Ð½ÑÐ½Ñ Ð´ÑÐ³Ð°Ð°Ñ ÑÐ°Ð°ÑÑÐ°Ð½Ð³Ò¯Ð¹.\n\nÐ¨Ð¸Ð»Ð¶Ò¯Ò¯Ð»ÑÑ Ð´Ð°Ð½Ñ: MN54 000500 5300692947 (Ð¥Ð°Ð°Ð½ Ð±Ð°Ð½Ðº)\n\nÐÓ©Ð² Ð´Ð°Ð½ÑÐ°Ð½Ð´ ÑÐ¸Ð»Ð¶Ò¯Ò¯Ð»ÑÑÐ´ screenshot Ð´Ð°ÑÐ¸Ð½ ÑÐ²ÑÑÐ»Ð½Ð° ÑÑ.');
      return;
    }
    if (!nameOk) {
      await sendFbMessage(senderId, 'â ÐÒ¯Ð¹Ð»Ð³ÑÑÐ½Ð¸Ð¹ ÑÑÐ³Ð° Ð´ÑÑÑ ÑÐ°Ð½Ñ ÑÑÐ¹ÑÐ±Ò¯Ò¯Ðº Ð½ÑÑ ("' + profile.name + '") Ð¾Ð»Ð´ÑÐ¾Ð½Ð³Ò¯Ð¹.\n\nÐÒ¯Ð¹Ð»Ð³ÑÑÐ½Ð¸Ð¹ ÑÑÐ³Ð° Ð´ÑÑÑ Ó©Ó©ÑÐ¸Ð¹Ð½ ÑÑÐ¹ÑÐ±Ò¯Ò¯Ðº Ð½ÑÑÐ¸Ð¹Ð³ Ð±Ð¸ÑÑÑÐ´ Ð´Ð°ÑÐ¸Ð½ ÑÐ²ÑÑÐ»Ð½Ð° ÑÑ.');
      return;
    }

    const video = await db.getLatestVideo();
    if (!video) { await sendFbMessage(senderId, 'ÐÐ´Ð¾Ð¾Ð³Ð¾Ð¾Ñ Ð¸Ð´ÑÐ²ÑÑÑÐ¹ Ð²Ð¸Ð´ÐµÐ¾ Ð±Ð°Ð¹ÑÐ³Ò¯Ð¹.'); return; }
    const linkId = nanoid(10);
    await db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
    const linkUrl = process.env.BASE_URL + '/watch/' + linkId;
    await sendFbMessage(senderId, 'â Ð¢Ó©Ð»Ð±Ó©Ñ Ð±Ð°ÑÐ°Ð»Ð³Ð°Ð°Ð¶Ð»Ð°Ð°!\n\nÐ¢Ð°Ð½Ñ Ð²Ð¸Ð´ÐµÐ¾ Ð»Ð¸Ð½Ðº:\n' + linkUrl + '\n\nâ° 72 ÑÐ°Ð³Ð¸Ð¹Ð½ Ð´Ð¾ÑÐ¾Ñ Ò¯Ð·Ð½Ñ Ò¯Ò¯.\nð ÐÐ¸Ð½Ðº Ð·Ó©Ð²ÑÓ©Ð½ ÑÐ°Ð½Ñ ÑÓ©ÑÓ©Ó©ÑÓ©Ð¼Ð¶Ð¸Ð´ Ð°Ð¶Ð¸Ð»Ð»Ð°Ð½Ð°.');
  } catch(err) {
    console.error('Screenshot error:', err);
    await sendFbMessage(senderId, 'Ð¡ÐºÑÐ¸Ð¹Ð½ÑÐ¾Ñ Ð±Ð¾Ð»Ð¾Ð²ÑÑÑÑÐ»Ð°ÑÐ°Ð´ Ð°Ð»Ð´Ð°Ð° Ð³Ð°ÑÐ»Ð°Ð°. ÐÐ°ÑÐ¸Ð½ ÑÐ²ÑÑÐ»Ð½Ð° ÑÑ.');
  }
}

async function sendFbMessage(recipientId, text) {
  const pageToken = process.env.FB_PAGE_TOKEN;
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

initDb().then(() => {
  app.listen(PORT, () => console.log('Server running on port ' + PORT));
}).catch(err => {
  console.error('DB init failed:', err);
  process.exit(1);
});
