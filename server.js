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
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><title>Admin</title><style>body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{background:#1a1a1a;padding:40px;border-radius:12px;width:320px}h2{margin:0 0 24px;text-align:center}input{width:100%;padding:12px;margin-bottom:16px;border:1px solid #333;background:#111;color:#fff;border-radius:8px;box-sizing:border-box;font-size:14px}button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}</style></head><body><div class="box"><h2>Admin</h2><form method="POST" action="/admin/login"><input type="text" name="username" placeholder="\u041d\u044d\u0432\u0442\u0440\u044d\u0445 \u043d\u044e\u0440" required><input type="password" name="password" placeholder="\u041d\u0443\u0443\u0446 \u04af\u0433" required><button type="submit">\u041d\u044d\u0432\u0442\u0440\u044d\u0445</button></form></div></body></html>');
});

app.post('/admin/login', async (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USER || 'admin') && password === (process.env.ADMIN_PASS || 'Admin1234!')) {
    const token = crypto.randomBytes(32).toString('hex');
    await db.setAdminSession(token);
    res.setHeader('Set-Cookie', 'admin_session=' + token + '; HttpOnly; Path=/; Max-Age=86400');
    return res.redirect('/admin/dashboard');
  }
  res.send('<script>alert("\u041d\u044e\u0432\u0442\u0440\u044d\u0445 \u043d\u044d\u0440 \u044d\u0441\u0432\u044d\u043b \u043d\u0443\u0443\u0446 \u04af\u0433 \u0431\u0443\u0440\u0443\u0443"); history.back();<\/script>');
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
    const badge = u ? '<span style="background:#451a03;color:#fcd34d;padding:2px 8px;border-radius:4px;font-size:12px">\u0410\u0448\u0438\u0433\u043b\u0430\u0430\u0433\u04af\u0439</span>' : a ? '<span style="background:#064e3b;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:12px">\u0418\u0434\u044d\u0432\u0445\u0442\u044d\u0439</span>' : '<span style="background:#450a0a;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:12px">\u0414\u0443\u0443\u0441\u0441\u0430\u043d</span>';
    return '<tr><td><a href="/watch/' + l.id + '" target="_blank" style="color:#a5b4fc">' + l.id + '</a></td><td>' + new Date(l.createdAt).toLocaleString('mn-MN') + '</td><td>' + badge + '</td><td>' + (l.activatedAt ? new Date(l.activatedAt).toLocaleString('mn-MN') : '-') + '</td></tr>';
  }).join('');
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Dashboard</title><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;margin:0;padding:20px}h1{color:#6366f1;margin-bottom:24px}.card{background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:20px}.card h2{margin:0 0 16px;font-size:18px;color:#a5b4fc}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;margin:4px}.btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#4f46e5}input[type=file]{width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:8px;font-size:14px;margin-bottom:12px}.stat{display:inline-block;background:#111;padding:12px 20px;border-radius:8px;margin:4px;text-align:center}.stat-num{font-size:28px;font-weight:bold;color:#6366f1}.stat-label{font-size:12px;color:#9ca3af}#progress-bar{width:0%;height:8px;background:#6366f1;border-radius:4px;transition:width 0.3s}#progress-wrap{background:#222;border-radius:4px;margin-top:8px;display:none}#status-msg{margin-top:8px;font-size:14px;color:#9ca3af}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #222}th{color:#9ca3af;font-weight:normal}</style></head><body><h1>Admin Dashboard</h1><div class="card"><h2>\u0421\u0442\u0430\u0442\u0438\u0441\u0442\u0438\u043a</h2><div class="stat"><div class="stat-num">' + videos.length + '</div><div class="stat-label">\u041d\u0438\u0439\u0442 \u0432\u0438\u0434\u0435\u043e</div></div><div class="stat"><div class="stat-num">' + links.length + '</div><div class="stat-label">\u041d\u0438\u0439\u0442 \u043b\u0438\u043d\u043a</div></div><div class="stat"><div class="stat-num">' + activeCount + '</div><div class="stat-label">\u0418\u0434\u044d\u0432\u0445\u0442\u044d\u0439</div></div><div class="stat"><div class="stat-num">' + unusedCount + '</div><div class="stat-label">\u0410\u0448\u0438\u0433\u043b\u0430\u0430\u0433\u04af\u0439</div></div></div><div class="card"><h2>\u0412\u0438\u0434\u0435\u043e \u043e\u0440\u0443\u0443\u043b\u0430\u0445</h2>' + (latestVideo ? '<p style="color:#6ee7b7;font-size:14px;margin-bottom:12px">\u041e\u0434\u043e\u043e\u0433\u0438\u0439\u043d \u0432\u0438\u0434\u0435\u043e: <strong>' + (latestVideo.filename||latestVideo.id) + '</strong></p>' : '') + '<input type="file" id="video-file" accept="video/*"><div id="progress-wrap"><div id="progress-bar"></div></div><div id="status-msg"></div><button class="btn btn-primary" onclick="uploadVideo()" style="margin-top:8px">\u0411\u0430\u0439\u0440\u0448\u0443\u0443\u043b\u0430\u0445</button></div><div class="card"><h2>\u041b\u0438\u043d\u043a \u04af\u04af\u0441\u0433\u044d\u0445</h2><button class="btn btn-primary" onclick="createLink()">\u0428\u0438\u043d\u044d \u043b\u0438\u043d\u043a \u04af\u04af\u0441\u0433\u044d\u0445</button><div id="link-result" style="margin-top:12px"></div></div><div class="card"><h2>\u041b\u0438\u043d\u043a\u04af\u04af\u0434</h2><table><tr><th>\u041b\u0438\u043d\u043a ID</th><th>\u04ae\u04af\u0441\u0433\u044d\u0441\u044d\u043d</th><th>\u0421\u0442\u0430\u0442\u0443\u0441</th><th>\u041d\u044d\u044d\u0441\u044d\u043d</th></tr>' + rows + '</table></div><script>async function uploadVideo(){const file=document.getElementById("video-file").files[0];if(!file)return alert("\u0424\u0430\u0439\u043b \u0441\u043e\u043d\u0433\u043e\u043d\u043a \u0443\u0443");const s=document.getElementById("status-msg"),pw=document.getElementById("progress-wrap"),pb=document.getElementById("progress-bar");s.textContent="URL \u0430\u0432\u0447 \u0431\u0430\u0439\u043d\u0430...";pw.style.display="block";try{const r1=await fetch("/admin/get-upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type})});const{uploadUrl,key}=await r1.json();s.textContent="\u0411\u0430\u0439\u0440\u0448\u0443\u0443\u043b\u0436 \u0431\u0430\u0439\u043d\u0430...";await new Promise((res,rej)=>{const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable)pb.style.width=(e.loaded/e.total*100)+"%"};x.onload=()=>x.status<300?res():rej(new Error(x.status));x.onerror=rej;x.open("PUT",uploadUrl);x.setRequestHeader("Content-Type",file.type);x.send(file)});s.textContent="\u0411\u04af\u0440\u0442\u0433\u044e\u0436 \u0431\u0430\u0439\u043d\u0430...";await fetch("/admin/register-video",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,filename:file.name,size:file.size,contentType:file.type})});s.textContent="\u0410\u043c\u0436\u0438\u043b\u0442\u0442\u0430\u0439!";pb.style.background="#10b981";setTimeout(()=>location.reload(),1500)}catch(e){s.textContent="\u0410\u043b\u0434\u0430\u0430: "+e.message;pb.style.background="#ef4444"}}async function createLink(){const r=await fetch("/admin/create-link",{method:"POST"});const d=await r.json();if(d.linkUrl){document.getElementById("link-result").innerHTML="<div style=\\"background:#111;padding:12px;border-radius:8px;word-break:break-all\\"><a href=\\""+d.linkUrl+"\\" target=\\"_blank\\" style=\\"color:#6ee7b7\\">"+d.linkUrl+"</a></div>"}else{document.getElementById("link-result").innerHTML="<p style=\\"color:#f87171\\">"+(d.error||"\u0410\u043b\u0434\u0430\u0430")+"</p>"}}<\/script></body></html>');
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

// Watch: one link = one person = one device
app.get('/watch/:linkId', async (req, res) => {
  try {
    const { linkId } = req.params;
    const link = await db.getLink(linkId);
    if (!link) {
      return res.status(404).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>\u041b\u0438\u043d\u043a \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439</h2></body></html>');
    }
    const age = Date.now() - link.createdAt;
    if (age > 72 * 60 * 60 * 1000) {
      return res.status(410).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>\u041b\u0438\u043d\u043a\u0438\u0439\u043d \u0445\u0443\u0433\u0430\u0446\u0430\u0430 \u0434\u0443\u0443\u0441\u0441\u0430\u043d</h2></body></html>');
    }
    const video = await db.getVideo(link.videoId);
    if (!video) {
      return res.status(404).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>\u0412\u0438\u0434\u0435\u043e \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439</h2></body></html>');
    }
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.key || video.filename });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    const html = '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"><title>\u0412\u0438\u0434\u0435\u043e</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;justify-content:center;align-items:center;min-height:100vh}video{max-width:100%;width:100%}</style></head><body><video controls autoplay controlsList="nodownload" oncontextmenu="return false"><source src="' + signedUrl + '" type="video/mp4"></video></body></html>';
    res.send(html);
  } catch (err) {
    console.error('Watch error:', err);
    res.status(500).send('<html><body style="background:#000;color:#fff;text-align:center;padding:50px"><h2>\u0410\u043b\u0434\u0430\u0430 \u0433\u0430\u0440\u043b\u0430\u0430</h2><p>' + (err.message || '') + '</p></body></html>');
  }
});

app.get('/stream/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const link = await db.getLink(linkId);
  if (!link) return res.status(404).json({ error: '\u041b\u0438\u043d\u043a \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439'_JN�ۜ�����Y\�H\��P����Y\��\JN�ۜ�����YU��[�H����Y\��ݗ��
�[��YNY�
[[�˘X�]�]Y]]K����
HH[�˘X�]�]Y]�
̈
�͌
�L
H�]\���\˜�]\�
�K���ۊ�\��܎�	�L
�WL

�L
��L
�L


�L
�L
�L
�L

�L

�L

WL

WL
�L
�	�JNY�
[[�˙]�X�U��[�����YU��[�OOH[�˙]�X�U��[�H�]\���\˜�]\�
�K���ۊ�\��܎�	�L
M�L
NWL
̗L

L
NWL
NWL

L
NWL
ؗL
��L
Y�L
�I�JN�ۜ��Y[�H]�Z]���]�Y[�[�˝�Y[�Y
NY�
]�Y[�H�]\���\˜�]\�

K���ۊ�\��܎�	�L
L�L
�L
�L
�WL
�HL
�WL
ؗL
�L

WL
�WL
�L
��L
Y�L
�I�JN�H�ۜ���[X[�H�]��]ؚ�X���[X[�
��X��]��P��U�^N��Y[˚�^HJN�ۜ��YۙY\�H]�Z]�]�YۙY\�
����[X[��^\�\�[��͌JN�\˜�Y\�X�
�YۙY\�
NH�]�
\��H��ۜ��K�\��܊	���X[H\��܎��\��N��\˜�]\�
L
K���ۊ�\��܎�\���Y\��Y�HJN�B�JN��[��[ۈ^Y\�Y�J[��Y
H�]\��	�Q��TH[�[[��H�[���XY�Y]H�\��]H�U�N��Y]H�[YOH��Y]�ܝ��۝[�H��YY]�X�K]�Y[�]X[\��[OLH��]O�L
L�L
�L
�L
�WL
�O�]O��[O���X\��[���Y[�Ό؛�\�^�[�Θ�ܙ\�X��X��^ؘX��ܛ�[������܎�ٙ���ZY��L��\�^N��^ٛ^Y\�X�[ێ���[[��[YۋZ][\Θ�[�\�ڝ\�Y�KX�۝[���[�\�ٛ۝Y�[Z[N�\�X[�[��\�\�Y��\�\�\�[X���ۙ_H�^Y\���Y�L	N�X^]�Y�L�\�X�\�][ΌM��NؘX��ܛ�[���LLN؛ܙ\�\�Y]\Ύ�ݙ\���ΚY[�]�Y[���Y�L	N�ZY��L	_K�[����X\��[�]��Mٛ۝\�^�N�L����܎�͘�̎�^X[Yێ��[�\�K��\���X\��[�]���ٛ۝\�^�N�L����܎�ٍNYL��^X[Yێ��[�\�O��[O��ܚ\���[Y[��Y]�[�\�[�\���۝^Y[�H�OO�K��]�[�Y�][

JN���[Y[��Y]�[�\�[�\���^Y�ۈ�OO��Y�K��^OOOH��L��
K����^I��K��Y��^I��ȒH�����ȋ�ȗK�[��Y\�K��^JJ_
K����^I��K��^OOOH�H�JYK��]�[�Y�][

N�JN���ܚ\��XY���O�]�YH�^Y\����Y[��۝���]]�^H�۝���\�H����ۛ�Y�\�X�TX�\�R[�X�\�Hۘ�۝^Y[�OH��]\���[�H����\��Hܘ�H����X[K��
�[��Y
�	Ȉ\OH��Y[��\
��L
ML

WL
��L
͗L
�L


WL
��L
Y�L
�HL
�WL
�L
�WL
�L
��ݚY[Ϗ�]��]��\��H�[��ȏ�̈L


�L
�L
��L
�L
�WL
�L
�L
�WL

�L
�WL

L
Y�L
��L

WL


HL
�WL
�WL
ؗL
�WL
��L
͗L

�L
�WL
�O�]��]��\��H��\����L
X�L
�L
�L
�HL
��L
NWL
̗L


WL
NWL
�L

�L
�L
�L

�L

�L
NWL


WL
NWL
NWL

L
NWL
��L
͗L
�L
�L
�L
͗L
�L
ؗL
ؗL
�L
�L
�L�ML
�L
�L
��L
͗L

�L

�L
ؗL
�WL
�L
؈L
�L
͗L
�L
ؗL
ؗL
�L


WL
��L
Y�L
�O�]��؛�O��[��B�����X�X����Y\��[��\����\��]
	���X�����
�\K�\�HO��ۜ�[�HH�\K�]Y\�V��X��[�I�N�ۜ���[�H�\K�]Y\�V��X���\�Y�W���[��N�ۜ��[[��HH�\K�]Y\�V��X���[[��I�NY�
[�HOOH	��X��ܚX�I�	����[�OOH���\�˙[�����ՑT�Q�W���S�H�\˜�]\��
K��[�
�[[��JNH[�H��\˜�]\�
�K�[�

N�B�JN�\���
	���X�����\�[��
�\K�\�HO��ۜ���HH�\K���NY�
��K�ؚ�X�OOH	�Y�I�H�]\���\˜�]\�

K�[�

N�\˜�]\��
K��[�
	�U�S�ԑP�RU�Q	�N�܈
�ۜ�[��Hو
��K�[��H�JJH�܈
�ۜ�]�[�و
[��K�Y\��Y�[���JJH�ۜ��[�\�YH]�[���[�\�	��]�[���[�\��YY�
\�[�\�Y�[�\�YOOH[��K�Y
H�۝[�YNY�
]�[��Y\��Y�JH�ۜ�\�[XY�HH
]�[��Y\��Y�K�]X�Y[���JK���YJHO�K�\HOOH	�[XY�I�NY�
\�[XY�JH�ۜ�[Y�]H
]�[��Y\��Y�K�]X�Y[���JK��[�
HO�K�\HOOH	�[XY�I�N�ۜ�[XY�U\�H[Y�]	��[Y�]�^[�Y	��[Y�]�^[�Y�\�]�Z][�T^[Y[��ܙY[���
�[�\�Y[XY�U\�
NH[�HY�
]�[��Y\��Y�K�^
H]�Z]�[��[��[����[�\�Y
NB�B�B��܈
�ۜ��[��Hو
[��K��[��\��JJHY�
�[��K��Y[OOH	ٙYY	�	���[��K��[YH	���[��K��[YK�][HOOH	���[Y[�	�H�ۜ���[Y[�H
�[��K��[YK�Y\��Y�H	��K��[J
N�ۜ���[Y[�\�YH�[��K��[YK����H	���[��K��[YK����K�YY�
X��[Y[�\�Y
H�۝[�YNY�
��[Y[�OOH	�I��L
�L
̗L
�L
�L
Y�L
��L
�L

_L
�L
̗L
��L
�L
�L

�K�\�
��[Y[�
JH]�Z]�[��[��[�����[Y[�\�Y
NB�B�B�B�JN�\�[���[��[ۈ�[��[��[����X�\Y[�Y
H]�Z]�[���Y\��Y�J�X�\Y[�YL��
H�L
LL
�L
̗L

�L
�L
�L
�L
�WL
��L
�WL


WL
�L
��L
�WL
�L
�L
�HL
Y�L
��L

WL


WL
�L
�WL
��L


WL
Y�L

WL
̗L

L
؂�LY��وL
XWL
�L
�L
�HL
Y�L
��L

WL


WL
�L
�WL
��L


WL
Y�L

WL
̗L

WL
؈L
�L
�WL
�WL

L


HL
��L
�L
�L
̗L

L

�L
��L
�L
�L
��L
�L
�L

L
�L
�N���LY��L
��L
NWL
ؗL
�WL
NWL

L

L
�L
ؗL
͗L
Y�L
Y�L
ؗL

WL


HL
��L

L
�L

L

L
ؗL

WL
؎��L���L
LWL
�L
�L
�N�L
�WL
�L
�L
�L
�WL
�L
�L
�HLY��M��L���L
ML
�L
�L

WL
�L

�L
�L

�L
��L
�L
�L

�S�M
L
L�
�L�M
L���L
ML
�L
�L

HL

WL
��L

WL
��L

L
�L
��L


ΈL
ML
�L
��L
�WL
�L
͗L
�L
̈L
X�L
NWL
�L


WL
�WL
�L

�L

�L���L
��L
NWL
ؗL
�WL
NWL

L
�L
�WL
�L
�L
Y�L
��
LL

�L
NWL
��L

L
NWL
��LY�L
L�L
Y�L
�WL
ؗL
��L

L

L
�L
�L
�HL

�L

�L
��L
�
L
��L
�L
�L
̗L
�L
؈L
�WL
�L


�L
�L

HJN�L�NL�L
NL
NWL

L
�L
�WL
��X�X����L
�L

WL

L

WL

HL
�WL
�L


�L

WL

L

L

WL
�B��LY��L
ML
�L

L
�L
�L
��L
�L
�WL
�L
�L
ؗL


WL
�L
�΂�K�L
L�L
Y�L
�WL
ؗL
��L

L

HL
�L
��L
͗L
�L
ؗL

�L

�L
�L
�HL
�WL
�WL
ؗL

WL
�L

�L

WL
�WL

L
�L
�L

L
�WL

�L

�L
��L
�L
̗L
�L
�L

�L

��L
�L
�L

HL


�L
�L

�L

L

�L

�L

�L
̗L

�L

�L
ؗL
�L
�L

�L

�L�ٌL
�WL

�L
��L
�L


�L
�L
���L���L
��L
NWL
ؗL
�WL
NWL

L
�WL
�L

�L
�L
ؗL
��L
�L
�L
͗L

WL
�L
�L

�L
�L
�L

L
�L
�L
ؗL
�L
�L
�HL
�L
̗L

�L
�WL
��L
�L

�L
�L
�L

L
�L

L
�L

B�L���L
X�L
�L
�L
�H
̈L


�L
�L
��
�L


WL
�WL
�L
�WL
��HL


WL
Y�L


�L
�L
�L

�L

WL
�HL
�WL
�L
�WL
�L
���L��LHL
M�L
NWL
̗L
ؗL
NWL
��L
͎�L
L�L
Y�L
�WL
ؗL
��L

L

HL


WL
�L
�WL


WL
�L

WL

HL
��L

L
�L

L

L
ؗL
ؗL
�L
�WL
��L

�L
��L

�L
�L
��L

L
�L
ؗL
��L
�L
�L

L
�L
�B�L
XWL
�L
�L
�HL
Y�L
��L

WL


WL

L
�L
�WL

L
ؗL

L
�L
�WL
�WL
ؗL

WL
�WL
�L

�L

��LY��
NB��\�[���[��[ۈ[�T^[Y[��ܙY[���
�[�\�Y[XY�U\�
H�H�ۜ��ٚ[T�\�H]�Z]�]�
	�΋��ܘ\��X�X���˘��K݌NK���
��[�\�Y
�	�ٚY[�[�[YI�X��\�����[�I�
����\�˙[������Q�W���S�N�ۜ��ٚ[HH]�Z]�ٚ[T�\˚��ۊ
N�ۜ����[YHH
�ٚ[K��[YH	��K����\��\�J
K��[J
N�ۜ��K���	ѐ��[YN�����[YK	�[XY�U\���[XY�U\��	��\�[�	��	�Z\��[���N�Y�
Z[XY�U\�
H]�Z]�[���Y\��Y�J�[�\�Y	�L
M�L

�L

L
�L
��L
�L

�L
ؗL
�L
�L
�HL
�L
ؗL
�L

WL
�L
��L
ML
�L


WL
�L
�L

�L
̗L

�L

�L
ؗL
�L
�L

�L

ˉ�N�]\��B���ۜ�[Yԙ\�H]�Z]�]�
[XY�U\�
N�ۜ�[YНY��\�H]�Z][Yԙ\˘\��^P�Y��\�
N�ۜ��\�M�[Y�H�Y��\�����J[YНY��\�K����[��	ؘ\�M�	�N�ۜ��۝[�\HH[Yԙ\˚XY\�˙�]
	��۝[�]\I�H	�[XY�KڜY����ۜ��]YT�\�H]�Z]�]�
	�΋��\K�[���X˘��K݌K�Y\��Y�\��Y]��	���	��XY\�Έ	��۝[�U\IΈ	�\X�][ۋڜ�ۉ��	�X\KZ�^IΈ���\�˙[���S���P��TW��VK�	�[���X�]�\��[ۉΈ	̌��L
�LIK���N���Ӌ���[��Y�J[�[�	��]YKZZZ�KMMKL��LLI��X^���[�Έ��Y\��Y�\Έ����N�	�\�\���۝[���\N�	�[XY�I���\��N��\N�	ؘ\�M�	�YYXW�\N��۝[�\K]N��\�M�[Y�HK��\N�	�^	�^�	�L
�L
�L

HL
�WL
�L
�L
�WL
�L

�L
��L
Y�L
�WL
ؗL
��L

L

WL
�L
�L
�H�ܙY[����L
ML
�L

L
�L
�L


HL
��L

L
�L

L

L
ؗL
ؗL
�L
�WL
��L
��L
�L

L
��L
���K�L
�WL
Y�L
ؗL

L

WL
�L
�L
̗L
�L
��L


�L
�L
�WL
�L
�L
�L
�L

WL
�L

�L
�L

�L
��L
�L
�L


L
��L
NWL
̗L


WL
NWL
�L

�L
�WL
�JW���L
L�L
Y�L
�WL
ؗL
��L

L

WL
�L
�L
�HL

�L

�L
��L
�L

L

WL
̗L

WL
؈L

�L
�L
�WL
ؗL
�WL
�L

L

�L
�WL
�WL

WL

���L
M�L
NWL
̗L


WL
NWL
���ӈL
NWL
��L
�L
NHL
Y�L
Y��ȘX���[���������\�ܚ\[ۈ�������I�B�_WB�JB�JN�ۜ��]YQ]HH]�Z]�]YT�\˚��ۊ
N�ۜ��]�^H
�]YQ]K��۝[�	���]YQ]K��۝[��H	���]YQ]K��۝[��K�^
H	���ۜ��K���	��]YH�]�^���]�^��X���[���
JN��ۜ�X���[���H�]�^�[��Y\�	�L�
�L�M
��N�]\����\�H	���H�ۜ�HH�]�^�X]�
�\�ܚ\[ۖȗ�J��ȗ�J��׈�J�H��NY�
JH\����\�HV�WK����\��\�J
NH�]�
JH�B��ۜ��[YS��H���[YH	�����[YK��]
	�	�K���YJ\�O�\��[���H	��\����\��[��Y\�\�
JN�Y�
XX���[���H]�Z]�[���Y\��Y�J�[�\�Y	�L���L
ML
�L
�L

WL
�L

�L
�L

�L
��L
�L
�L

L

�L
�L
�L

L

WL
�L
�L
��L
Y�L
�K���L
�L
�L
43b\u0436\u04af\u04af\u043b\u044d\u0445 \u0434\u0430\u043d\u0441: MN54 000500 5300692947 (\u0425\u0430\u0430\u043d \u0431\u0430\u043d\u043a)\n\n\u0417\u04e9\u0432 \u0434\u0430\u043d\u0441\u0430\u043d\u0434 \u0448\u0438\u043b\u0436\u04af\u04af\u043b\u044e\u044e\u0434 screenshot \u0434\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.');
      return;
    }
    if (!nameOk) {
      await sendFbMessage(senderId, '\u274c \u0413\u04af\u0439\u043b\u0433\u044e\u044e\u043d\u0438\u0439 \u0443\u0442\u0433\u0430 \u0434\u044e\u044e\u0440 \u0442\u0430\u043d\u044b \u0444\u044e\u0439\u0441\u0431\u04af\u04af\u043a \u043d\u044e\u0440 ("' + profile.name + '") \u043e\u043b\u0434\u0441\u043e\u043d\u0433\u04af\u0439.\n\n\u0413\u04af\u0439\u043b\u0433\u044e\u044e\u043d\u0438\u0439 \u0443\u0442\u0433\u0430 \u0434\u044e\u044e\u0440 \u04e9\u04e9\u0440\u0438\u0439\u043d \u0444\u044e\u0439\u0441\u0431\u04af\u04af\u043a \u043d\u044e\u0440\u0438\u0439\u0433 \u0431\u0438\u0447\u044e\u044e\u0434 \u0434\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.');
      return;
    }

    const video = await db.getLatestVideo();
    if (!video) { await sendFbMessage(senderId, '\u041e\u0434\u043e\u043e\u0433\u043e\u043e\u0440 \u0438\u0434\u044e\u0432\u0445\u0442\u044e\u0439 \u0432\u0438\u0434\u0435\u043e \u0431\u0430\u0439\u0445\u0433\u04af\u0439.'); return; }
    const linkId = nanoid(10);
    await db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
    const linkUrl = process.env.BASE_URL + '/watch/' + linkId;
    await sendFbMessage(senderId, '\u2705 \u0422\u04e9\u043b\u0431\u04e9\u0440 \u0431\u0430\u0442\u0430\u043b\u0433\u0430\u0430\u0436\u043b\u0430\u0430!\n\n\u0422\u0430\u043d\u044b \u0432\u0438\u0434\u0435\u043e \u043b\u0438\u043d\u043a:\n' + linkUrl + '\n\n\u23f0 72 \u0446\u0430\u0433\u0438\u0439\u043d \u0434\u043e\u0442\u043e\u0440 \u04af\u0437\u043d\u044e \u04af\u04af.\n\u1f512 \u041b\u0438\u043d\u043a \u0437\u04e9\u0432\u0445\u04e9\u043d \u0442\u0430\u043d\u044b \u0442\u04e9\u0445\u04e9\u04e9\u0440\u04e9\u043c\u0436\u0438\u0434 \u0430\u0436\u0438\u043b\u043b\u0430\u043d\u0430.');
  } catch(err) {
    console.error('Screenshot error:', err);
    await sendFbMessage(senderId, '\u0421\u043a\u0440\u0438\u0439\u043d\u0448\u043e\u0442 \u0431\u043e\u043b\u043e\u0432\u0441\u0440\u0443\u0443\u043b\u0430\u0445\u0430\u0434 \u0430\u043b\u0434\u0430\u0430 \u0433\u0430\u0440\u043b\u0430\u0430. \u0414\u0430\u0445\u0438\u043d \u044f\u0432\u0443\u0443\u043b\u043d\u0430 \u0443\u0443.');
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
                         
