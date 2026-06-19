const express = require('express');
const { S3Client, GetObjectCommand, PutObjectCommand } = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const { nanoid } = require('nanoid');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

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

const DB_PATH = path.join(__dirname, 'db.json');
function loadDb() {
  try { if (fs.existsSync(DB_PATH)) return JSON.parse(fs.readFileSync(DB_PATH, 'utf8')); } catch {}
  return { videos: {}, links: {}, adminSession: null };
}
function saveDb(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

const db = {
  get data() { return loadDb(); },
  saveVideo(id, video) { const d = loadDb(); d.videos[id] = video; saveDb(d); },
  getVideo(id) { return loadDb().videos[id]; },
  getLatestVideo() { const v = Object.values(loadDb().videos || {}); return v.length ? v[v.length-1] : null; },
  saveLink(id, link) { const d = loadDb(); d.links[id] = link; saveDb(d); },
  getLink(id) { return loadDb().links[id]; },
  setAdminSession(token) { const d = loadDb(); d.adminSession = token; saveDb(d); },
  getAdminSession() { return loadDb().adminSession; },
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

function requireAdmin(req, res, next) {
  const cookies = parseCookies(req);
  const session = db.getAdminSession();
  if (session && cookies.admin_session === session) return next();
  res.redirect('/admin');
}

app.get('/admin', (req, res) => {
  const cookies = parseCookies(req);
  const session = db.getAdminSession();
  if (session && cookies.admin_session === session) return res.redirect('/admin/dashboard');
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><title>Admin</title><style>body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}.box{background:#1a1a1a;padding:40px;border-radius:12px;width:320px}h2{margin:0 0 24px;text-align:center}input{width:100%;padding:12px;margin-bottom:16px;border:1px solid #333;background:#111;color:#fff;border-radius:8px;box-sizing:border-box;font-size:14px}button{width:100%;padding:12px;background:#6366f1;color:#fff;border:none;border-radius:8px;font-size:16px;cursor:pointer}</style></head><body><div class="box"><h2>Admin</h2><form method="POST" action="/admin/login"><input type="text" name="username" placeholder="Нэвтрэх нэр" required><input type="password" name="password" placeholder="Нууц үг" required><button type="submit">Нэвтрэх</button></form></div></body></html>');
});

app.post('/admin/login', (req, res) => {
  const { username, password } = req.body;
  if (username === (process.env.ADMIN_USER || 'admin') && password === (process.env.ADMIN_PASS || 'Admin1234!')) {
    const token = crypto.randomBytes(32).toString('hex');
    db.setAdminSession(token);
    res.setHeader('Set-Cookie', 'admin_session=' + token + '; HttpOnly; Path=/; Max-Age=86400');
    return res.redirect('/admin/dashboard');
  }
  res.send('<script>alert("Нэвтрэх нэр эсвэл нууц үг буруу"); history.back();<\/script>');
});

app.get('/admin/dashboard', requireAdmin, (req, res) => {
  const videos = Object.values(db.data.videos || {});
  const links = Object.values(db.data.links || {});
  const latestVideo = videos.length ? videos[videos.length - 1] : null;
  const activeCount = links.filter(l => l.activatedAt && Date.now() - l.activatedAt < 72*3600*1000).length;
  const unusedCount = links.filter(l => !l.activatedAt).length;
  const rows = links.slice(-20).reverse().map(l => {
    const a = l.activatedAt && Date.now() - l.activatedAt < 72*3600*1000;
    const u = !l.activatedAt;
    const badge = u ? '<span style="background:#451a03;color:#fcd34d;padding:2px 8px;border-radius:4px;font-size:12px">Ашиглаагүй</span>' : a ? '<span style="background:#064e3b;color:#6ee7b7;padding:2px 8px;border-radius:4px;font-size:12px">Идэвхтэй</span>' : '<span style="background:#450a0a;color:#fca5a5;padding:2px 8px;border-radius:4px;font-size:12px">Дууссан</span>';
    return '<tr><td><a href="/watch/' + l.id + '" target="_blank" style="color:#a5b4fc">' + l.id + '</a></td><td>' + new Date(l.createdAt).toLocaleString('mn-MN') + '</td><td>' + badge + '</td><td>' + (l.activatedAt ? new Date(l.activatedAt).toLocaleString('mn-MN') : '-') + '</td></tr>';
  }).join('');
  res.send('<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Admin Dashboard</title><style>*{box-sizing:border-box}body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;margin:0;padding:20px}h1{color:#6366f1;margin-bottom:24px}.card{background:#1a1a1a;border-radius:12px;padding:24px;margin-bottom:20px}.card h2{margin:0 0 16px;font-size:18px;color:#a5b4fc}.btn{padding:10px 20px;border:none;border-radius:8px;cursor:pointer;font-size:14px;margin:4px}.btn-primary{background:#6366f1;color:#fff}.btn-primary:hover{background:#4f46e5}input[type=file]{width:100%;padding:10px;background:#111;border:1px solid #333;color:#fff;border-radius:8px;font-size:14px;margin-bottom:12px}.stat{display:inline-block;background:#111;padding:12px 20px;border-radius:8px;margin:4px;text-align:center}.stat-num{font-size:28px;font-weight:bold;color:#6366f1}.stat-label{font-size:12px;color:#9ca3af}#progress-bar{width:0%;height:8px;background:#6366f1;border-radius:4px;transition:width 0.3s}#progress-wrap{background:#222;border-radius:4px;margin-top:8px;display:none}#status-msg{margin-top:8px;font-size:14px;color:#9ca3af}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:8px 12px;text-align:left;border-bottom:1px solid #222}th{color:#9ca3af;font-weight:normal}</style></head><body><h1>Admin Dashboard</h1><div class="card"><h2>Статистик</h2><div class="stat"><div class="stat-num">' + videos.length + '</div><div class="stat-label">Нийт видео</div></div><div class="stat"><div class="stat-num">' + links.length + '</div><div class="stat-label">Нийт линк</div></div><div class="stat"><div class="stat-num">' + activeCount + '</div><div class="stat-label">Идэвхтэй</div></div><div class="stat"><div class="stat-num">' + unusedCount + '</div><div class="stat-label">Ашиглаагүй</div></div></div><div class="card"><h2>Видео оруулах</h2>' + (latestVideo ? '<p style="color:#6ee7b7;font-size:14px;margin-bottom:12px">Одоогийн видео: <strong>' + (latestVideo.filename||latestVideo.id) + '</strong></p>' : '') + '<input type="file" id="video-file" accept="video/*"><div id="progress-wrap"><div id="progress-bar"></div></div><div id="status-msg"></div><button class="btn btn-primary" onclick="uploadVideo()" style="margin-top:8px">Байршуулах</button></div><div class="card"><h2>Линк үүсгэх</h2><button class="btn btn-primary" onclick="createLink()">Шинэ линк үүсгэх</button><div id="link-result" style="margin-top:12px"></div></div><div class="card"><h2>Линкүүд</h2><table><tr><th>Линк ID</th><th>Үүсгэсэн</th><th>Статус</th><th>Нээсэн</th></tr>' + rows + '</table></div><script>async function uploadVideo(){const file=document.getElementById("video-file").files[0];if(!file)return alert("Файл сонгоно уу");const s=document.getElementById("status-msg"),pw=document.getElementById("progress-wrap"),pb=document.getElementById("progress-bar");s.textContent="URL авч байна...";pw.style.display="block";try{const r1=await fetch("/admin/get-upload-url",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({filename:file.name,contentType:file.type})});const{uploadUrl,key}=await r1.json();s.textContent="Байршуулж байна...";await new Promise((res,rej)=>{const x=new XMLHttpRequest();x.upload.onprogress=e=>{if(e.lengthComputable)pb.style.width=(e.loaded/e.total*100)+"%"};x.onload=()=>x.status<300?res():rej(new Error(x.status));x.onerror=rej;x.open("PUT",uploadUrl);x.setRequestHeader("Content-Type",file.type);x.send(file)});s.textContent="Бүртгэж байна...";await fetch("/admin/register-video",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,filename:file.name,size:file.size,contentType:file.type})});s.textContent="Амжилттай!";pb.style.background="#10b981";setTimeout(()=>location.reload(),1500)}catch(e){s.textContent="Алдаа: "+e.message;pb.style.background="#ef4444"}}async function createLink(){const r=await fetch("/admin/create-link",{method:"POST"});const d=await r.json();if(d.linkUrl){document.getElementById("link-result").innerHTML="<div style=\\"background:#111;padding:12px;border-radius:8px;word-break:break-all\\"><a href=\\""+d.linkUrl+"\\" target=\\"_blank\\" style=\\"color:#6ee7b7\\">"+d.linkUrl+"</a></div>"}else{document.getElementById("link-result").innerHTML="<p style=\\"color:#f87171\\">"+( d.error||"Алдаа")+"</p>"}}<\/script></body></html>');
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

app.post('/admin/register-video', requireAdmin, (req, res) => {
  try {
    const { key, filename, size, contentType } = req.body;
    const id = nanoid(10);
    db.saveVideo(id, { id, key, filename, size, contentType, uploadedAt: Date.now() });
    res.json({ id, key });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/admin/create-link', requireAdmin, (req, res) => {
  const video = db.getLatestVideo();
  if (!video) return res.json({ error: 'Видео байхгүй байна' });
  const linkId = nanoid(10);
  db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
  const baseUrl = process.env.BASE_URL || ('https://' + req.headers.host);
  res.json({ linkId, linkUrl: baseUrl + '/watch/' + linkId });
});

app.get('/admin/videos', requireAdmin, (req, res) => res.json(Object.values(db.data.videos || {})));
app.get('/admin/links', requireAdmin, (req, res) => res.json(Object.values(db.data.links || {})));

// Watch: нэг линк = нэг хүн = нэг төхөөрөмж
app.get('/watch/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const link = db.getLink(linkId);
  if (!link) return res.status(404).send(`<!DOCTYPE html><html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:sans-serif"><h2>Линк олдсонгүй</h2></body></html>`);

  const age = Date.now() - link.createdAt;
  if (age > 72 * 60 * 60 * 1000) return res.status(410).send(`<!DOCTYPE html><html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:sans-serif"><h2>⏰ Линкийн хугацаа дууссан</h2><p>72 цагийн хугацаа өнгөрсөн байна.</p></body></html>`);

  // IP-based locking
  const userIp = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  if (link.lockedIp && link.lockedIp !== userIp) {
    return res.status(403).send(`<!DOCTYPE html><html><body style="background:#000;color:#f66;text-align:center;padding:50px;font-family:sans-serif"><h2>🔒 Хандах боломжгүй</h2><p>Энэ линкийг өөр сүлжээнээс аль хэдийн нээсэн байна.</p><p>Линк зөвхөн нэг хүнд зориулагдсан.</p></body></html>`);
  }
  if (!link.lockedIp && userIp) {
    db.updateLink(linkId, { lockedIp: userIp });
  }

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).send(`<!DOCTYPE html><html><body style="background:#000;color:#fff;text-align:center;padding:50px;font-family:sans-serif"><h2>Видео олдсонгүй</h2></body></html>`);

  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.r2Key || video.filename });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.send(`<!DOCTYPE html>
<html lang="mn">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Видео үзэх</title>
<style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;display:flex;justify-content:center;align-items:center;min-height:100vh}video{max-width:100%;max-height:100vh;width:100%}</style>
</head>
<body>
<video controls autoplay controlsList="nodownload" oncontextmenu="return false">
<source src="${signedUrl}" type="video/mp4">
</video>
<script>document.addEventListener('keydown',function(e){if(e.key==='PrintScreen')e.preventDefault();});</script>
</body>
</html>`);
  } catch(err) {
    console.error('Watch error:', err);
    res.status(500).send('Видео ачааллахад алдаа гарлаа');
  }
})
app.get('/stream/:linkId', async (req, res) => {
  const { linkId } = req.params;
  const link = db.getLink(linkId);
  if (!link) return res.status(404).json({ error: 'Линк олдсонгүй' });
  const cookies = parseCookies(req);
  const cookieToken = cookies['v_' + linkId];
  if (!link.activatedAt || Date.now() - link.activatedAt > 72 * 3600 * 1000) return res.status(403).json({ error: 'Хугацаа дууссан' });
  if (!link.deviceToken || cookieToken !== link.deviceToken) return res.status(403).json({ error: 'Зөвшөөрөлгүй' });
  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).json({ error: 'Видео олдсонгүй' });
  try {
    const command = new GetObjectCommand({ Bucket: BUCKET, Key: video.key });
    const signedUrl = await getSignedUrl(s3, command, { expiresIn: 3600 });
    res.redirect(signedUrl);
  } catch (err) { console.error('stream error:', err); res.status(500).json({ error: err.message }); }
});

function playerPage(linkId) {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Видео</title><style>*{margin:0;padding:0;box-sizing:border-box}body{background:#000;color:#fff;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font-family:Arial,sans-serif;user-select:none}#player{width:100%;max-width:900px;aspect-ratio:16/9;background:#111;border-radius:8px;overflow:hidden}video{width:100%;height:100%}.info{margin-top:14px;font-size:13px;color:#6b7280;text-align:center}.warn{margin-top:6px;font-size:12px;color:#f59e0b;text-align:center}</style><script>document.addEventListener("contextmenu",e=>e.preventDefault());document.addEventListener("keydown",e=>{if(e.key==="F12"||(e.ctrlKey&&e.shiftKey&&["I","J","C","K"].includes(e.key))||(e.ctrlKey&&e.key==="U"))e.preventDefault();});<\/script></head><body><div id="player"><video controls autoplay controlsList="nodownload" disablePictureInPicture oncontextmenu="return false"><source src="/stream/' + linkId + '" type="video/mp4">Дэмжихгүй байна.</video></div><div class="info">72 цагийн дотор үзэх боломжтой</div><div class="warn">Линк зөвхөн таны төхөөрөмжид ажиллана — дамжуулбал ажиллахгүй</div></body></html>';
}

function errorPage(title, message) {
  return '<!DOCTYPE html><html lang="mn"><head><meta charset="UTF-8"><title>' + title + '</title><style>body{font-family:Arial,sans-serif;background:#0f0f0f;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;text-align:center;padding:20px}.box{max-width:440px}h1{font-size:22px;margin-bottom:16px;color:#f87171}p{color:#9ca3af;line-height:1.7;white-space:pre-line;font-size:15px}</style></head><body><div class="box"><h1>' + title + '</h1><p>' + message + '</p></div></body></html>';
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
      }
        else if (event.message.text) await sendBankInfo(senderId);
      }
    }
    for (const change of (entry.changes || [])) {
      if (change.field === 'feed' && change.value && change.value.item === 'comment') {
        const comment = (change.value.message || '').trim();
        const commenterId = change.value.from && change.value.from.id;
        if (!commenterId) continue;
        if (comment === '1' || /авна|үзнэ|авмаар/i.test(comment)) {
          await sendBankInfo(commenterId);
        }
      }
    }
  }
});

async function sendBankInfo(recipientId) {
  await sendFbMessage(recipientId, `✅ "Аавын найз охин" кино үзэхийг хүсвэл
🍿 Кино үзэхийг хүсвэл доорх зааврыг дагаарай:

💰 Төлбөр шилжүүлэх мэдээлэл:
• Банк: Хаан банк 🏦
• Дансны дугаар: MN54 000500 5300692947
• Данс эзэмшигч: Дамбажав Мөнхбаяр
• Төлбөрийн дүн: 5000 төгрөг

📝 Гүйлгээний утга (заавал бичнэ!): → Өөрийн Facebook нэрээ бичээрэй

📸 Дараагийн алхам:
1. Гүйлгээ амжилттай болсны скриншотыг авна уу
2. Энэ чат руу явуулна уу

⏰ Хугацаа:
• Төлбөр баталгаажсаны дараа линк автоматаар ирнэ
• Линк 72 цаг (3 хоног) хүчинтэй байна

⚡ Зөвлөмж: Гүйлгээ хийхдээ мэдээллийг яг таг шалгаарай!
Кино үзэхэд бэлэн болсон уу? 🚀`);
}

async function handlePaymentScreenshot(senderId, imageUrl) {
  try {
    // Get FB user's name
    const profileRes = await fetch('https://graph.facebook.com/v19.0/' + senderId + '?fields=name&access_token=' + process.env.FB_PAGE_TOKEN);
    const profile = await profileRes.json();
    const fbName = (profile.name || '').toLowerCase().trim();
    console.log('FB name:', fbName, 'imageUrl:', imageUrl ? 'present' : 'missing');

    if (!imageUrl) {
      await sendFbMessage(senderId, 'Зурагны линк алдсан. Дахин явуулна уу.');
      return;
    }

    // Fetch image
    const imgRes = await fetch(imageUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64Img = Buffer.from(imgBuffer).toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    // Claude Vision
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: base64Img } },
          { type: 'text', text: 'Энэ банкны гүйлгээний screenshot. Дараах мэдээллийг гарга:\n1. Хүлээн авагчийн дансны дугаар (бүгдийг нь, тоо болон үсэг)\n2. Гүйлгээний утга эсвэл тайлбар текст\n\nЗөвхөн JSON өгнө үү: {"account":"...","description":"..."}' }
        ]}]
      })
    });

    const claudeData = await claudeRes.json();
    console.log('Claude API response status:', claudeRes.status);
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';
    console.log('Claude rawText:', rawText.substring(0, 300));

    // Account check: remove all spaces and check for 5300692947
    const rawNoSpace = rawText.replace(/\s/g, '');
    const accountOk = rawNoSpace.includes('5300692947');
    console.log('accountOk:', accountOk, 'rawNoSpace snippet:', rawNoSpace.substring(0, 100));

    // Description check
    let descLower = '';
    try {
      const m = rawText.match(/"description"\s*:\s*"([^"]+)"/);
      if (m) descLower = m[1].toLowerCase();
    } catch(e) {}
    console.log('descLower:', descLower, 'fbName:', fbName);

    const nameParts = fbName.split(' ').filter(p => p.length > 1);
    const nameOk = nameParts.length > 0 && nameParts.some(part => descLower.includes(part));
    console.log('nameOk:', nameOk);

    if (!accountOk) {
      await sendFbMessage(senderId, '❌ Дансны дугаар таарсангүй.\n\nШилжүүлэх данс: MN54 000500 5300692947 (Хаан банк)\n\nЗөв дансанд шилжүүлээд screenshot дахин явуулна уу.');
      return;
    }
    if (!nameOk) {
      await sendFbMessage(senderId, '❌ Гүйлгээний утга дээр таны Facebook нэр ("' + profile.name + '") олдсонгүй.\n\nГүйлгээний утга дээр өөрийн Facebook нэрээ бичээд дахин явуулна уу.');
      return;
    }

    const video = db.getLatestVideo();
    if (!video) { await sendFbMessage(senderId, 'Одоогоор идэвхтэй видео байхгүй.'); return; }
    const linkId = nanoid(10);
    db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
    const linkUrl = process.env.BASE_URL + '/watch/' + linkId;
    await sendFbMessage(senderId, '✅ Төлбөр баталгаажлаа!\n\nТаны видео линк:\n' + linkUrl + '\n\n⏰ 72 цагийн дотор үзнэ үү.\n🔒 Линк зөвхөн таны төхөөрөмжид ажиллана.');
  } catch(err) {
    console.error('Screenshot error:', err);
    await sendFbMessage(senderId, 'Скрийншот боловсруулахад алдаа гарлаа. Дахин явуулна уу.');
  }
}

async function sendBankInfo(recipientId) {
  await sendFbMessage(recipientId, `✅ "Аавын найз охин" кино үзэхийг хүсвэл
🍿 Кино үзэхийг хүсвэл доорх зааврыг дагаарай:

💰 Төлбөр шилжүүлэх мэдээлэл:
• Банк: Хаан банк 🏦
• Дансны дугаар: MN54 000500 5300692947
• Данс эзэмшигч: Дамбажав Мөнхбаяр
• Төлбөрийн дүн: 5000 төгрөг

📝 Гүйлгээний утга (заавал бичнэ!): → Өөрийн Facebook нэрээ бичээрэй

📸 Дараагийн алхам:
1. Гүйлгээ амжилттай болсны скриншотыг авна уу
2. Энэ чат руу явуулна уу

⏰ Хугацаа:
• Төлбөр баталгаажсаны дараа линк автоматаар ирнэ
• Линк 72 цаг (3 хоног) хүчинтэй байна

⚡ Зөвлөмж: Гүйлгээ хийхдээ мэдээллийг яг таг шалгаарай!
Кино үзэхэд бэлэн болсон уу? 🚀`);
}

async function handlePaymentScreenshot(senderId) {
  try {
    const video = db.getLatestVideo();
    if (!video) { await sendFbMessage(senderId, 'Одоогоор идэвхтэй видео байхгүй.'); return; }
    const linkId = nanoid(10);
    db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
    const linkUrl = process.env.BASE_URL + '/watch/' + linkId;
    await sendFbMessage(senderId, '✅ Төлбөр хүлээн авлаа!\n\nТаны видео линк:\n' + linkUrl + '\n\n⏰ 72 цагийн дотор үзнэ үү.\n🔒 Линк зөвхөн таны төхөөрөмжид ажиллана.');
  } catch(err) {
    console.error('Screenshot error:', err);
    await sendFbMessage(senderId, 'Алдаа гарлаа. Дахин явуулна уу.');
  }
}

async function sendBankInfo(recipientId) {
  await sendFbMessage(recipientId, `✅ "Аавын найз охин" кино үзэхийг хүсвэл
🍿 Кино үзэхийг хүсвэл доорх зааврыг дагаарай:

💰 Төлбөр шилжүүлэх мэдээлэл:
• Банк: Хаан банк 🏦
• Дансны дугаар: MN54 000500 5300692947
• Данс эзэмшигч: Дамбажав Мөнхбаяр
• Төлбөрийн дүн: 5000 төгрөг

📝 Гүйлгээний утга (заавал бичнэ!): → Өөрийн Facebook нэрээ бичээрэй

📸 Дараагийн алхам:
1. Гүйлгээ амжилттай болсны скриншотыг авна уу
2. Энэ чат руу явуулна уу

⏰ Хугацаа:
• Төлбөр баталгаажсаны дараа линк автоматаар ирнэ
• Линк 72 цаг (3 хоног) хүчинтэй байна

⚡ Зөвлөмж: Гүйлгээ хийхдээ мэдээллийг яг таг шалгаарай!
Кино үзэхэд бэлэн болсон уу? 🚀`);
}

async function handlePaymentScreenshot(senderId, imageUrl) {
  try {
    const profileRes = await fetch('https://graph.facebook.com/v19.0/' + senderId + '?fields=name&access_token=' + process.env.FB_PAGE_TOKEN);
    const profile = await profileRes.json();
    const fbName = (profile.name || '').toLowerCase().trim();

    const imgRes = await fetch(imageUrl);
    const imgBuffer = await imgRes.arrayBuffer();
    const base64Img = Buffer.from(imgBuffer).toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': process.env.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [{ role: 'user', content: [
          { type: 'image', source: { type: 'base64', media_type: contentType, data: base64Img } },
          { type: 'text', text: 'Энэ банкны гүйлгээний screenshot. Дараах мэдээллийг гарга:\n1. Хүлээн авагчийн дансны дугаар (зөвхөн тоо)\n2. Гүйлгээний утга эсвэл тайлбар текст\n\nЗөвхөн JSON өгнө үү: {"account":"...","description":"..."}' }
        ]}]
      })
    });
    const claudeData = await claudeRes.json();
    const rawText = (claudeData.content && claudeData.content[0] && claudeData.content[0].text) || '';

    // Check account: look for 5300692947 anywhere in rawText (handles IBAN MN54000500 5300692947)
    const accountOk = rawText.includes('5300692947');

    // Check name: sender's FB name appears in description
    let descLower = '';
    try {
      const m = rawText.match(/description["\s]*:["\s]*"([^"]+)"/);
      if (m) descLower = m[1].toLowerCase();
    } catch(e) {}
    const nameOk = fbName && fbName.split(' ').some(part => part.length > 1 && descLower.includes(part));

    if (!accountOk) {
      await sendFbMessage(senderId, '❌ Дансны дугаар таарсангүй.\n\nШилжүүлэх данс: MN54 000500 5300692947 (Хаан банк)\n\nЗөв дансанд шилжүүлээд screenshot дахин явуулна уу.');
      return;
    }
    if (!nameOk) {
      await sendFbMessage(senderId, '❌ Гүйлгээний утга дээр таны фэйсбүүк нэр ("' + profile.name + '") олдсонгүй.\n\nГүйлгээний утга дээр өөрийн фэйсбүүк нэрийг бичээд дахин явуулна уу.');
      return;
    }

    const video = db.getLatestVideo();
    if (!video) { await sendFbMessage(senderId, 'Одоогоор идэвхтэй видео байхгүй.'); return; }
    const linkId = nanoid(10);
    db.saveLink(linkId, { id: linkId, videoId: video.id, createdAt: Date.now() });
    const linkUrl = process.env.BASE_URL + '/watch/' + linkId;
    await sendFbMessage(senderId, '✅ Төлбөр баталгаажлаа!\n\nТаны видео линк:\n' + linkUrl + '\n\n⏰ 72 цагийн дотор үзнэ үү.\n🔒 Линк зөвхөн таны төхөөрөмжид ажиллана.');
  } catch(err) {
    console.error('Screenshot error:', err);
    await sendFbMessage(senderId, 'Скрийншот боловсруулахад алдаа гарлаа. Дахин явуулна уу.');
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

app.listen(PORT, () => console.log('Server running on port ' + PORT));
