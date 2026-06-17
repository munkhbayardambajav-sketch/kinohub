const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { nanoid } = require('nanoid');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Env config ────────────────────────────────────────────────────────────────
const ADMIN_USER      = process.env.ADMIN_USER      || 'admin';
const ADMIN_PASS      = process.env.ADMIN_PASS      || 'changeme123';
const QPAY_USERNAME   = process.env.QPAY_USERNAME   || '';
const QPAY_PASSWORD   = process.env.QPAY_PASSWORD   || '';
const QPAY_INVOICE_CODE = process.env.QPAY_INVOICE_CODE || '';
const BASE_URL        = process.env.BASE_URL        || `http://localhost:${PORT}`;
const VIDEO_PRICE     = parseInt(process.env.VIDEO_PRICE || '5000'); // төгрөгөөр

const QPAY_API = 'https://merchant.qpay.mn/v2';

// ── Upload dir ────────────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Admin sessions ────────────────────────────────────────────────────────────
const sessions = new Set();

function requireAdmin(req, res, next) {
  const token = req.headers['x-admin-token'] || req.query.token;
  if (token && sessions.has(token)) return next();
  res.status(401).json({ error: 'Нэвтрэх шаардлагатай' });
}

// ── Multer ────────────────────────────────────────────────────────────────────
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => cb(null, nanoid(16) + path.extname(file.originalname))
});
const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) =>
    file.mimetype.startsWith('video/') ? cb(null, true) : cb(new Error('Зөвхөн видео'))
});

// ══════════════════════════════════════════════════════════════════════════════
// QPay helpers
// ══════════════════════════════════════════════════════════════════════════════

// QPay token авах
async function getQpayToken() {
  const cached = db.getQpayToken();
  if (cached && cached.expiresAt > Date.now() + 60000) return cached.token;

  return new Promise((resolve, reject) => {
    const auth = Buffer.from(`${QPAY_USERNAME}:${QPAY_PASSWORD}`).toString('base64');
    const options = {
      hostname: 'merchant.qpay.mn',
      path: '/v2/auth/token',
      method: 'POST',
      headers: { 'Authorization': `Basic ${auth}`, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.access_token) return reject(new Error('QPay token алдаа: ' + data));
          db.saveQpayToken(json.access_token, Date.now() + (json.expires_in || 3600) * 1000);
          resolve(json.access_token);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// QPay invoice үүсгэх
async function createQpayInvoice(linkId, amount) {
  const token = await getQpayToken();
  const body = JSON.stringify({
    invoice_code: QPAY_INVOICE_CODE,
    sender_invoice_no: linkId,
    invoice_receiver_code: 'terminal',
    invoice_description: 'Кино үзэх эрх (24 цаг)',
    amount: amount,
    callback_url: `${BASE_URL}/qpay/callback/${linkId}`
  });

  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'merchant.qpay.mn',
      path: '/v2/invoice',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (!json.invoice_id) return reject(new Error('Invoice үүсгэхэд алдаа: ' + data));
          resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// QPay төлбөр шалгах
async function checkQpayPayment(invoiceId) {
  const token = await getQpayToken();
  return new Promise((resolve, reject) => {
    const options = {
      hostname: 'merchant.qpay.mn',
      path: `/v2/payment/check/${invoiceId}`,
      method: 'GET',
      headers: { 'Authorization': `Bearer ${token}` }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
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

// Видео байршуулах
app.post('/admin/upload', requireAdmin, upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Файл байхгүй' });
  const videoId = nanoid(16);
  db.saveVideo(videoId, {
    id: videoId,
    filename: req.file.filename,
    originalName: req.file.originalname,
    size: req.file.size,
    mimetype: req.file.mimetype,
    uploadedAt: Date.now()
  });
  res.json({ videoId, name: req.file.originalname });
});

// Видео жагсаалт
app.get('/admin/videos', requireAdmin, (req, res) => {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'db.json'), 'utf8'));
  const videos = Object.values(raw.videos || {}).map(v => ({
    id: v.id, name: v.originalName, size: v.size
  }));
  res.json(videos);
});

// Худалдааны линк үүсгэх
app.post('/admin/generate-links', requireAdmin, (req, res) => {
  const { videoId, count = 1, price } = req.body;
  if (!db.getVideo(videoId)) return res.status(404).json({ error: 'Видео олдсонгүй' });
  const links = [];
  for (let i = 0; i < Math.min(count, 500); i++) {
    const linkId = nanoid(12);
    db.saveLink(linkId, {
      id: linkId,
      videoId,
      price: price || VIDEO_PRICE,
      createdAt: Date.now(),
      paidAt: null,
      expiresAt: null,
      qpayInvoiceId: null,
      qpayData: null
    });
    links.push(linkId);
  }
  res.json({ links });
});

// Бүх линк
app.get('/admin/links', requireAdmin, (req, res) => {
  const links = Object.values(db.getAllLinks()).sort((a, b) => b.createdAt - a.createdAt);
  res.json(links);
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC — ХУДАЛДААНЫ ХУУДАС
// ══════════════════════════════════════════════════════════════════════════════

// Хэрэглэгч линкийг нээнэ → QPay invoice үүсгэж QR харуулна
app.get('/buy/:linkId', async (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Линк олдсонгүй', 'Энэ линк байхгүй эсвэл буруу байна.'));

  // Аль хэдийн төлсөн
  if (link.paidAt) {
    if (link.expiresAt > Date.now()) {
      return res.redirect(`/v/${link.id}`);
    } else {
      return res.status(410).send(errorPage('Хугацаа дууссан', 'Энэ линкийн 24 цагийн хугацаа дуусжээ.'));
    }
  }

  // Шинэ invoice үүсгэх (эсвэл өмнөхийг дахин ашиглах)
  try {
    let invoiceData;
    if (link.qpayInvoiceId) {
      // Өмнөх invoice байгаа — шалгах
      invoiceData = { invoice_id: link.qpayInvoiceId, qPay_QRimage: link.qpayQR, qPay_deeplink: link.qpayDeeplink };
    } else {
      invoiceData = await createQpayInvoice(link.id, link.price);
      db.updateLink(link.id, {
        qpayInvoiceId: invoiceData.invoice_id,
        qpayQR: invoiceData.qPay_QRimage,
        qpayDeeplink: invoiceData.qPay_deeplink || null
      });
    }
    res.send(paymentPage(link, invoiceData));
  } catch (err) {
    console.error('QPay invoice алдаа:', err.message);
    res.status(500).send(errorPage('Алдаа гарлаа', 'QPay систем ачааллахад алдаа гарлаа. Дахин оролдоно уу.'));
  }
});

// Frontend polling — төлбөр болсон уу шалгах
app.get('/buy/:linkId/status', async (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.json({ status: 'not_found' });
  if (link.paidAt) {
    return res.json({ status: link.expiresAt > Date.now() ? 'paid' : 'expired' });
  }
  // QPay-с шалгах
  if (link.qpayInvoiceId) {
    try {
      const check = await checkQpayPayment(link.qpayInvoiceId);
      if (check.count > 0) {
        const now = Date.now();
        db.updateLink(link.id, { paidAt: now, expiresAt: now + 24 * 60 * 60 * 1000 });
        return res.json({ status: 'paid' });
      }
    } catch (e) { /* silent */ }
  }
  res.json({ status: 'pending' });
});

// QPay callback (webhook) — QPay серверээс ирэх
app.post('/qpay/callback/:linkId', async (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link || link.paidAt) return res.json({ status: 'ok' });
  try {
    if (link.qpayInvoiceId) {
      const check = await checkQpayPayment(link.qpayInvoiceId);
      if (check.count > 0) {
        const now = Date.now();
        db.updateLink(link.id, { paidAt: now, expiresAt: now + 24 * 60 * 60 * 1000 });
      }
    }
  } catch (e) { console.error('Callback error:', e.message); }
  res.json({ status: 'ok' });
});

// ══════════════════════════════════════════════════════════════════════════════
// PUBLIC — ВИДЕО ХУУДАС
// ══════════════════════════════════════════════════════════════════════════════

app.get('/v/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link) return res.status(404).send(errorPage('Линк олдсонгүй', 'Энэ линк байхгүй.'));
  if (!link.paidAt) return res.redirect(`/buy/${link.id}`);
  if (link.expiresAt <= Date.now()) return res.status(410).send(errorPage('Хугацаа дууссан', 'Энэ линкийн 24 цагийн хугацаа дуусчээ.'));

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).send(errorPage('Видео олдсонгүй', 'Видео серверт байхгүй байна.'));

  const remaining = Math.round((link.expiresAt - Date.now()) / 3600000 * 10) / 10;

  res.send(`<!DOCTYPE html>
<html lang="mn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Кино үзэх</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background: #000; display: flex; flex-direction: column; align-items: center; justify-content: center; min-height: 100vh; }
    video { max-width: 100vw; max-height: 90vh; width: 100%; }
    .notice { color: #aaa; font-family: system-ui, sans-serif; font-size: 13px; padding: 10px; text-align: center; }
  </style>
</head>
<body>
  <video controls autoplay>
    <source src="/stream/${link.id}" type="${video.mimetype}">
  </video>
  <p class="notice">⏱ ${remaining} цаг үлдсэн</p>
</body>
</html>`);
});

// Видео stream
app.get('/stream/:linkId', (req, res) => {
  const link = db.getLink(req.params.linkId);
  if (!link || !link.paidAt || link.expiresAt <= Date.now()) return res.status(403).end();

  const video = db.getVideo(link.videoId);
  if (!video) return res.status(404).end();

  const filePath = path.join(UPLOAD_DIR, video.filename);
  if (!fs.existsSync(filePath)) return res.status(404).end();

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : fileSize - 1;
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': video.mimetype
    });
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    res.writeHead(200, { 'Content-Length': fileSize, 'Content-Type': video.mimetype });
    fs.createReadStream(filePath).pipe(res);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// HTML helpers
// ══════════════════════════════════════════════════════════════════════════════

function paymentPage(link, invoiceData) {
  const qr = invoiceData.qPay_QRimage || '';
  const deeplink = invoiceData.qPay_deeplink || '';
  return `<!DOCTYPE html>
<html lang="mn">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Кино худалдаж авах</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 24px; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 16px; padding: 32px 24px; width: 100%; max-width: 380px; text-align: center; }
    h1 { font-size: 20px; margin-bottom: 6px; }
    .price { font-size: 28px; font-weight: 700; color: #a78bfa; margin: 12px 0 20px; }
    .qr-wrap { background: #fff; border-radius: 12px; padding: 16px; display: inline-block; margin-bottom: 20px; }
    .qr-wrap img { width: 200px; height: 200px; display: block; }
    .hint { font-size: 13px; color: #888; margin-bottom: 20px; line-height: 1.6; }
    .deeplink { display: block; padding: 14px; background: #6c47ff; border-radius: 10px; color: #fff; text-decoration: none; font-weight: 600; font-size: 15px; margin-bottom: 12px; }
    .deeplink:hover { background: #5a38e0; }
    .status { font-size: 13px; color: #888; margin-top: 16px; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #555; border-top-color: #a78bfa; border-radius: 50%; animation: spin 0.8s linear infinite; vertical-align: middle; margin-right: 6px; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <div class="card">
    <h1>🎬 Кино үзэх эрх</h1>
    <div class="price">${link.price.toLocaleString()}₮</div>
    <div class="hint">QPay апп ашиглан QR кодыг уншуулж төлнө үү</div>
    ${qr ? `<div class="qr-wrap"><img src="data:image/png;base64,${qr}" alt="QPay QR" /></div>` : '<p style="color:#ef5350">QR код ачааллахад алдаа гарлаа</p>'}
    ${deeplink ? `<a class="deeplink" href="${deeplink}">📱 QPay апп нээх</a>` : ''}
    <div class="hint">Төлбөр амжилттай болсны дараа хуудас автоматаар шинэчлэгдэнэ</div>
    <div class="status"><span class="spinner"></span>Төлбөр хүлээж байна...</div>
  </div>
  <script>
    (function poll() {
      fetch('/buy/${link.id}/status')
        .then(r => r.json())
        .then(d => {
          if (d.status === 'paid') {
            document.querySelector('.status').textContent = '✅ Төлбөр амжилттай!';
            setTimeout(() => location.href = '/v/${link.id}', 1000);
          } else {
            setTimeout(poll, 3000);
          }
        })
        .catch(() => setTimeout(poll, 5000));
    })();
  </script>
</body>
</html>`;
}

function adminLoginPage() {
  return `<!DOCTYPE html>
<html lang="mn">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #fff; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 40px; width: 100%; max-width: 360px; }
    h1 { font-size: 20px; margin-bottom: 24px; text-align: center; }
    input { width: 100%; padding: 12px 14px; background: #111; border: 1px solid #333; border-radius: 8px; color: #fff; font-size: 14px; margin-bottom: 12px; }
    button { width: 100%; padding: 12px; background: #6c47ff; border: none; border-radius: 8px; color: #fff; font-size: 15px; font-weight: 600; cursor: pointer; }
    .err { color: #ff5c5c; font-size: 13px; margin-top: 10px; text-align: center; display: none; }
  </style>
</head>
<body>
  <div class="card">
    <h1>🔐 Admin</h1>
    <input type="text" id="u" placeholder="Нэвтрэх нэр" />
    <input type="password" id="p" placeholder="Нууц үг" />
    <button onclick="login()">Нэвтрэх</button>
    <p class="err" id="err">Буруу мэдээлэл</p>
  </div>
  <script>
    async function login() {
      const r = await fetch('/admin/login', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({user: document.getElementById('u').value, pass: document.getElementById('p').value}) });
      const d = await r.json();
      if (d.token) { localStorage.setItem('token', d.token); location.href = '/admin/dashboard'; }
      else document.getElementById('err').style.display = 'block';
    }
    document.addEventListener('keydown', e => e.key === 'Enter' && login());
  </script>
</body>
</html>`;
}

function adminDashboardPage() {
  return `<!DOCTYPE html>
<html lang="mn">
<head>
  <meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Admin Dashboard</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #fff; padding: 24px; max-width: 900px; margin: 0 auto; }
    h1 { font-size: 22px; margin-bottom: 24px; }
    .section { background: #1a1a1a; border: 1px solid #333; border-radius: 12px; padding: 24px; margin-bottom: 20px; }
    h2 { font-size: 15px; color: #aaa; margin-bottom: 16px; }
    input[type=file], input[type=number], input[type=text] { background: #111; border: 1px solid #333; border-radius: 8px; color: #fff; padding: 10px 12px; font-size: 14px; width: 100%; margin-bottom: 10px; }
    button { padding: 10px 20px; background: #6c47ff; border: none; border-radius: 8px; color: #fff; font-size: 14px; font-weight: 600; cursor: pointer; }
    button:hover { background: #5a38e0; }
    button.sec { background: #333; }
    .msg { margin-top: 10px; font-size: 13px; color: #7fff7f; }
    .err { margin-top: 10px; font-size: 13px; color: #ff5c5c; }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 8px 10px; color: #666; border-bottom: 1px solid #222; }
    td { padding: 8px 10px; border-bottom: 1px solid #1a1a1a; }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
    .unpaid  { background: #1e1e2a; color: #888; }
    .paid    { background: #1e3a1e; color: #4caf50; }
    .expired { background: #2a1a1a; color: #ef5350; }
    .copy-btn { padding: 3px 8px; font-size: 11px; background: #222; border-radius: 6px; cursor: pointer; border: none; color: #fff; }
    .progress { background: #222; border-radius: 6px; height: 6px; margin-top: 6px; }
    .progress-bar { background: #6c47ff; height: 6px; border-radius: 6px; }
    .video-item { background: #111; border: 1px solid #2a2a2a; border-radius: 8px; padding: 10px 14px; display: flex; justify-content: space-between; align-items: center; cursor: pointer; margin-bottom: 6px; }
    .video-item.sel { border-color: #6c47ff; background: #1a1240; }
    label { font-size: 13px; color: #aaa; display: block; margin-bottom: 4px; }
    .row { display: flex; gap: 10px; }
    .row > * { flex: 1; }
  </style>
</head>
<body>
  <h1>🎬 Кино борлуулалтын систем</h1>

  <div class="section">
    <h2>Видео байршуулах</h2>
    <input type="file" id="vFile" accept="video/*" />
    <div class="progress" id="prog" style="display:none"><div class="progress-bar" id="progFill" style="width:0%"></div></div>
    <button onclick="uploadVideo()">Байршуулах</button>
    <div id="uploadMsg"></div>
  </div>

  <div class="section">
    <h2>Худалдааны линк үүсгэх</h2>
    <div id="videoList"><p style="color:#555;font-size:13px">Байршуулсан видео энд харагдана</p></div>
    <br>
    <div class="row">
      <div>
        <label>Үнэ (₮)</label>
        <input type="number" id="price" value="5000" min="100" />
      </div>
      <div>
        <label>Хэдэн линк үүсгэх</label>
        <input type="number" id="lCount" value="1" min="1" max="500" />
      </div>
    </div>
    <button onclick="genLinks()">Линк үүсгэх</button>
    <div id="genResult" style="margin-top:14px"></div>
  </div>

  <div class="section">
    <h2>Бүх линк <button class="sec" onclick="loadLinks()" style="font-size:11px;padding:4px 10px;margin-left:10px">Шинэчлэх</button></h2>
    <div id="linksTable"></div>
  </div>

  <script>
    const token = localStorage.getItem('token');
    if (!token) location.href = '/admin';
    const H = { 'Content-Type': 'application/json', 'x-admin-token': token };
    let selVideoId = null;
    const BASE = location.origin;

    async function uploadVideo() {
      const file = document.getElementById('vFile').files[0];
      if (!file) return alert('Видео сонгоно уу');
      const form = new FormData();
      form.append('video', file);
      document.getElementById('prog').style.display = 'block';
      document.getElementById('uploadMsg').innerHTML = '<span style="color:#aaa;font-size:13px">Байршуулж байна...</span>';
      const xhr = new XMLHttpRequest();
      xhr.open('POST', '/admin/upload');
      xhr.setRequestHeader('x-admin-token', token);
      xhr.upload.onprogress = e => {
        if (e.lengthComputable) document.getElementById('progFill').style.width = (e.loaded/e.total*100)+'%';
      };
      xhr.onload = () => {
        document.getElementById('prog').style.display = 'none';
        const d = JSON.parse(xhr.responseText);
        if (d.videoId) { document.getElementById('uploadMsg').innerHTML = '<p class="msg">✅ Байршлаа!</p>'; loadVideos(); }
        else document.getElementById('uploadMsg').innerHTML = '<p class="err">❌ '+( d.error||'Алдаа')+'</p>';
      };
      xhr.send(form);
    }

    async function loadVideos() {
      const vs = await fetch('/admin/videos', {headers: H}).then(r => r.json());
      const el = document.getElementById('videoList');
      if (!vs.length) { el.innerHTML = '<p style="color:#555;font-size:13px">Байршуулсан видео байхгүй</p>'; return; }
      el.innerHTML = vs.map(v => \`<div class="video-item \${selVideoId===v.id?'sel':''}" onclick="selVideo('\${v.id}',this)">
        <span style="font-size:13px">🎬 \${v.name}</span>
        <span style="color:#555;font-size:11px">\${(v.size/1024/1024).toFixed(1)} MB</span>
      </div>\`).join('');
    }

    function selVideo(id, el) {
      selVideoId = id;
      document.querySelectorAll('.video-item').forEach(e => e.classList.remove('sel'));
      el.classList.add('sel');
    }

    async function genLinks() {
      if (!selVideoId) return alert('Видео сонгоно уу');
      const count = parseInt(document.getElementById('lCount').value)||1;
      const price = parseInt(document.getElementById('price').value)||5000;
      const d = await fetch('/admin/generate-links', {method:'POST',headers:H,body:JSON.stringify({videoId:selVideoId,count,price})}).then(r=>r.json());
      if (d.links) {
        const el = document.getElementById('genResult');
        el.innerHTML = \`<p style="font-size:13px;color:#aaa;margin-bottom:10px">✅ \${d.links.length} линк үүслээ:</p>
          \${d.links.map((l,i)=>\`<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <span style="color:#555;font-size:12px;width:24px">\${i+1}.</span>
            <code style="font-size:12px;background:#111;padding:4px 8px;border-radius:6px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">\${BASE}/buy/\${l}</code>
            <button class="copy-btn" onclick="cp('\${BASE}/buy/\${l}',this)">📋</button>
          </div>\`).join('')}
          <button class="sec" onclick="cpAll(\${JSON.stringify(d.links.map(l=>BASE+'/buy/'+l))})" style="margin-top:8px;font-size:12px">Бүгдийг хуулах</button>\`;
        loadLinks();
      }
    }

    function cp(t, btn) { navigator.clipboard.writeText(t); btn.textContent='✓'; setTimeout(()=>btn.textContent='📋',1500); }
    function cpAll(ls) { navigator.clipboard.writeText(ls.join('\\n')); alert('Бүх линк хуулагдлаа!'); }

    async function loadLinks() {
      const links = await fetch('/admin/links',{headers:H}).then(r=>r.json());
      const el = document.getElementById('linksTable');
      if (!links.length) { el.innerHTML='<p style="color:#555;font-size:13px">Линк байхгүй</p>'; return; }
      const now = Date.now();
      el.innerHTML = \`<table>
        <tr><th>Линк</th><th>Үнэ</th><th>Статус</th><th>Төлсөн</th><th>Дуусах</th></tr>
        \${links.map(l => {
          let cls, txt;
          if (!l.paidAt) { cls='unpaid'; txt='Төлөөгүй'; }
          else if (l.expiresAt > now) { cls='paid'; txt='Идэвхтэй'; }
          else { cls='expired'; txt='Дууссан'; }
          return \`<tr>
            <td><code style="font-size:11px">/buy/\${l.id}</code> <button class="copy-btn" onclick="cp('\${BASE}/buy/\${l.id}',this)">📋</button></td>
            <td style="color:#a78bfa">\${(l.price||0).toLocaleString()}₮</td>
            <td><span class="badge \${cls}">\${txt}</span></td>
            <td style="color:#666;font-size:12px">\${l.paidAt ? new Date(l.paidAt).toLocaleString('mn-MN') : '—'}</td>
            <td style="color:#666;font-size:12px">\${l.expiresAt ? new Date(l.expiresAt).toLocaleString('mn-MN') : '—'}</td>
          </tr>\`;
        }).join('')}
      </table>\`;
    }

    loadVideos();
    loadLinks();
  </script>
</body>
</html>`;
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
