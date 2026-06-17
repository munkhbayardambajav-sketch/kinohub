const fs = require('fs');
const path = require('path');

const DB_FILE = path.join(__dirname, 'data', 'db.json');

function ensureDb() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ videos: {}, links: {}, qpayToken: null }));
  }
}

function read() {
  ensureDb();
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}

function write(data) {
  ensureDb();
  fs.writeFileSync(DB_FILE, JSON.stringify(data, null, 2));
}

function saveVideo(id, info)    { const db = read(); db.videos[id] = info; write(db); }
function getVideo(id)           { return read().videos[id] || null; }
function saveLink(id, data)     { const db = read(); db.links[id] = data; write(db); }
function getLink(id)            { return read().links[id] || null; }
function getAllLinks()           { return read().links; }

function updateLink(id, updates) {
  const db = read();
  if (!db.links[id]) return null;
  db.links[id] = { ...db.links[id], ...updates };
  write(db);
  return db.links[id];
}

function saveQpayToken(token, expiresAt) {
  const db = read();
  db.qpayToken = { token, expiresAt };
  write(db);
}

function getQpayToken() {
  return read().qpayToken || null;
}

module.exports = { saveVideo, getVideo, saveLink, getLink, updateLink, getAllLinks, saveQpayToken, getQpayToken };
