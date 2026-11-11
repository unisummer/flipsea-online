// 뒤집힌 바다 온라인 서버
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { attach } = require('./ws-lite');
const { makeStore } = require('./store');

const PORT = +process.env.PORT || 10000;
const store = makeStore();
let storeOk = false, storeErr = '';

// ---------- 게임 화면 ----------
const PUB = path.join(__dirname, 'public');
let INDEX = null, INDEX_GZ = null;
function loadIndex() { INDEX = fs.readFileSync(path.join(PUB, 'index.html')); INDEX_GZ = zlib.gzipSync(INDEX, { level: 9 }); }
loadIndex();

// ---------- 함께 쓰는 세계 ----------
const DECAY_MS = 20000;           // 시세 압력은 실제 20초마다 0.9배로 풀린다
const W = { mk: {}, dev: {}, disc: {}, inv: {}, nm: {} };   // inv: 항구별 {선장id: 누적 투자 골드}
let CHAT = [], worldDirty = false, chatDirty = false;
function mkDecay(m, now) { const dt = now - m.t; if (dt > 0) { const f = Math.pow(0.9, dt / DECAY_MS); m.s *= f; m.b *= f; m.t = now; } return m; }
function mkPack(m) { return [+m.s.toFixed(3), +m.b.toFixed(3)]; }
function worldSnapshot() {
  const now = Date.now(), mk = {};
  for (const k in W.mk) { const m = mkDecay(W.mk[k], now); if (m.s + m.b < 0.05) { delete W.mk[k]; continue; } mk[k] = mkPack(m); }
  return { mk, dev: W.dev, disc: W.disc, inv: W.inv, nm: W.nm, now };
}
async function loadWorld() {
  try { const v = await store.kvGet('world'); if (v) { const o = JSON.parse(v); Object.assign(W, { mk: o.mk || {}, dev: o.dev || {}, disc: o.disc || {}, inv: o.inv || {}, nm: o.nm || {} }); } } catch (e) { console.error('world load', e.message); }
  try { const v = await store.kvGet('chat'); if (v) CHAT = JSON.parse(v); } catch (e) {}
}
async function saveWorld() {
  try {
    if (worldDirty) { worldDirty = false; await store.kvSet('world', JSON.stringify(W)); }
    if (chatDirty) { chatDirty = false; await store.kvSet('chat', JSON.stringify(CHAT.slice(-60))); }
  } catch (e) { console.error('world save', e.message); worldDirty = true; }
}
setInterval(saveWorld, 20000);

// ---------- 로그인 ----------
const NAME_RE = /^[\p{L}\p{N}_\- ]{2,12}$/u, PIN_RE = /^\d{4,8}$/, DOC_RE = /^(s[23]_)?(meta|c\d{1,3})$/;
const fails = new Map();
const hashPin = (pin, salt) => new Promise((ok, no) => crypto.scrypt(pin, salt, 32, (e, k) => e ? no(e) : ok(k.toString('hex'))));
async function authUid(req) { const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : ''; return t ? await store.tokenUid(t) : null; }

// ---------- HTTP ----------
function send(res, code, obj) { const b = Buffer.from(JSON.stringify(obj)); res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': b.length }); res.end(b); }
function body(req, limit) {
  return new Promise((ok, no) => { let n = 0; const ch = []; req.on('data', d => { n += d.length; if (n > limit) { no({ code: 413 }); req.destroy(); } else ch.push(d); }); req.on('end', () => { try { ok(JSON.parse(Buffer.concat(ch).toString('utf8') || '{}')); } catch (e) { no({ code: 400 }); } }); req.on('error', no); });
}
async function api(req, res, url) {
  const p = url.pathname;
  if (p === '/api/login' && req.method === 'POST') {
    const b = await body(req, 4096); const name = String(b.name || '').trim(), pin = String(b.pin || '');
    if (!NAME_RE.test(name)) return send(res, 400, { err: 'name' });
    if (!PIN_RE.test(pin)) return send(res, 400, { err: 'pin_format' });
    const f = fails.get(name); if (f && f.until > Date.now()) return send(res, 429, { err: 'locked', wait: Math.ceil((f.until - Date.now()) / 1000) });
    let u = await store.userByName(name), isNew = false;
    if (!u) {
      if (!b.create) return send(res, 404, { err: 'no_user' });
      const salt = crypto.randomBytes(12).toString('hex'); const id = await store.createUser(name, salt, await hashPin(pin, salt)); u = { id, name }; isNew = true;
    } else {
      const h = await hashPin(pin, u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'))) {
        const g = f && f.until > Date.now() - 600000 ? f : { n: 0, until: 0 }; g.n++; if (g.n >= 5) { g.until = Date.now() + 5 * 60000; g.n = 0; } fails.set(name, g);
        return send(res, 401, { err: 'pin', left: 5 - g.n });
      }
      fails.delete(name);
    }
    const token = crypto.randomBytes(24).toString('hex'); await store.tokenSet(token, Number(u.id));
    return send(res, 200, { token, name: u.name, id: Number(u.id), isNew });
  }
  if (p === '/api/me') { const uid = await authUid(req); if (!uid) return send(res, 401, { err: 'auth' }); const u = await store.userById(uid); return send(res, 200, { id: uid, name: u ? u.name : '?' }); }
  if (p.startsWith('/api/doc/')) {
    const uid = await authUid(req); if (!uid) return send(res, 401, { err: 'auth' });
    const n = decodeURIComponent(p.slice(9)); if (!DOC_RE.test(n)) return send(res, 400, { err: 'doc' });
    if (req.method === 'GET') { const d = await store.docGet(uid, n); return send(res, 200, d ? { exists: true, data: JSON.parse(d) } : { exists: false }); }
    if (req.method === 'PUT') { const b = await body(req, 700000); await store.docSet(uid, n, JSON.stringify(b.data)); return send(res, 200, { ok: true }); }
  }
  if (p === '/api/save' && req.method === 'PUT') {
    const uid = await authUid(req); if (!uid) return send(res, 401, { err: 'auth' });
    const b = await body(req, 900000); const docs = b && b.docs; if (!docs || typeof docs !== 'object') return send(res, 400, { err: 'docs' });
    const names = Object.keys(docs); if (!names.length || names.length > 20 || !names.every(n => DOC_RE.test(n))) return send(res, 400, { err: 'doc' });
    names.sort((x, y) => (/meta$/.test(x) ? 1 : 0) - (/meta$/.test(y) ? 1 : 0));   // 조각을 먼저, 요약(meta)을 마지막에
    for (const n of names) await store.docSet(uid, n, JSON.stringify(docs[n]));
    return send(res, 200, { ok: true });
  }
  if (p === '/api/rank') {
    const best = new Map();
    for (const r of await store.metasAll()) { let m; try { m = JSON.parse(r.data); } catch (e) { continue; } const a = m.asset || m.gold || 0; const o = best.get(r.uid); if (!o || a > o.asset) best.set(r.uid, { name: r.name, asset: a, gold: m.gold || 0, fame: m.fame || 0, day: m.day || 0, disc: m.disc || 0, ch: m.ch || 0, t: m.t || 0 }); }
    return send(res, 200, { list: [...best.values()].sort((a, b) => b.asset - a.asset).slice(0, 50) });
  }
  send(res, 404, { err: 'not_found' });
}
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, store: store.kind, storeOk, storeErr, players: clients.size });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? INDEX_GZ : INDEX);
    }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (e && e.code === 413) return send(res, 413, { err: 'too_big' }); if (e && e.code === 400) return send(res, 400, { err: 'bad_json' });
    console.error(e); send(res, 500, { err: 'server', msg: String(e && e.message || e) });
  }
});

// ---------- 실시간 ----------
const clients = new Map();   // conn -> {uid, nm, pos, chatT}
function bc(obj, except) { const s = JSON.stringify(obj); for (const c of clients.keys()) if (c !== except) c.send(s); }
function playerList() {
  const seen = new Map();
  for (const v of clients.values()) if (v.pos && (!seen.has(v.uid) || seen.get(v.uid).pos.t < v.pos.t)) seen.set(v.uid, v);
  return [...seen.values()].map(v => ({ id: v.uid, nm: v.nm, ...v.pos }));
}
const mkChanged = new Set(), devChanged = new Set(), invChanged = new Set();
function onMsg(c, info, raw) {
  let m; try { m = JSON.parse(raw); } catch (e) { return; }
  const now = Date.now(), num = (x, a, b) => typeof x === 'number' && isFinite(x) && x >= a && x <= b;
  if (m.type === 'pos') {
    if (!num(m.lat, -90, 90) || !num(m.lon, -400, 400)) return;
    info.pos = { lat: m.lat, lon: m.lon, hd: num(m.hd, -720, 720) ? m.hd : 0, port: Number.isInteger(m.port) ? m.port : -1, ships: Number.isInteger(m.ships) ? m.ships : 1, fl: String(m.fl || '').slice(0, 20), day: num(m.day, 0, 1e7) ? Math.floor(m.day) : 0, bat: !!m.bat, t: now };
  } else if (m.type === 'chat') {
    const text = String(m.text || '').replace(/\s+/g, ' ').trim().slice(0, 200); if (!text || now - (info.chatT || 0) < 700) return; info.chatT = now;
    const msg = { nm: info.nm, text, t: now, where: String(m.where || '').slice(0, 30) }; CHAT.push(msg); if (CHAT.length > 80) CHAT = CHAT.slice(-60); chatDirty = true; bc({ type: 'chat', m: msg });
  } else if (m.type === 'mk' && Array.isArray(m.d)) {
    for (const x of m.d.slice(0, 200)) {
      if (!Array.isArray(x) || !/^\d{1,3}_\d{1,3}$/.test(x[0]) || !num(x[1], 0, 500) || !num(x[2], 0, 500)) continue;
      const k = x[0], w = mkDecay(W.mk[k] || (W.mk[k] = { s: 0, b: 0, t: now }), now); w.s += x[1]; w.b += x[2]; mkChanged.add(k); worldDirty = true;
    }
  } else if (m.type === 'dev' && Array.isArray(m.d)) {
    for (const x of m.d.slice(0, 50)) { if (!Array.isArray(x) || !Number.isInteger(x[0]) || x[0] < 0 || x[0] > 400 || !num(x[1], 0, 50000)) continue; W.dev[x[0]] = (W.dev[x[0]] || 0) + x[1]; devChanged.add(x[0]); worldDirty = true; }
  } else if (m.type === 'inv' && Array.isArray(m.d)) {
    // 선장이 그 항구에 넣은 누적 투자금(절대값). 줄어들지 않고 큰 값만 받는다.
    for (const x of m.d.slice(0, 200)) {
      if (!Array.isArray(x) || !Number.isInteger(x[0]) || x[0] < 0 || x[0] > 400 || !num(x[1], 0, 1e11)) continue;
      const P = W.inv[x[0]] || (W.inv[x[0]] = {}), v = Math.floor(x[1]);
      if (v > (P[info.uid] || 0)) { P[info.uid] = v; invChanged.add(x[0]); worldDirty = true; }
    }
    if (W.nm[info.uid] !== info.nm) { W.nm[info.uid] = info.nm; worldDirty = true; }
  } else if (m.type === 'disc' && Number.isInteger(m.id) && m.id >= 0 && m.id < 1000) {
    if (!W.disc[m.id]) { W.disc[m.id] = { nm: info.nm, t: now }; worldDirty = true; bc({ type: 'disc', id: m.id, nm: info.nm }); }
  }
}
// 시세·발전 변화는 0.4초마다 묶어서 알린다
setInterval(() => {
  const now = Date.now();
  if (mkChanged.size) { const mk = {}; for (const k of mkChanged) if (W.mk[k]) mk[k] = mkPack(mkDecay(W.mk[k], now)); mkChanged.clear(); bc({ type: 'mk', now, mk }); }
  if (invChanged.size) { const inv = {}, nm = {}; for (const p of invChanged) { inv[p] = W.inv[p]; for (const u in W.inv[p]) nm[u] = W.nm[u]; } invChanged.clear(); bc({ type: 'inv', inv, nm }); }
  if (devChanged.size) { const dev = {}; for (const p of devChanged) dev[p] = W.dev[p]; devChanged.clear(); bc({ type: 'dev', dev }); }
}, 400);
// 배 위치는 2초마다
setInterval(() => { if (clients.size) bc({ type: 'players', list: playerList(), now: Date.now() }); }, 2000);
// 끊긴 연결 정리
setInterval(() => { for (const c of clients.keys()) { if (!c.alive) { c.close(); continue; } c.alive = false; c.ping(); } }, 30000);

attach(server, '/ws', async (c, url) => {
  const uid = await store.tokenUid(url.searchParams.get('token') || '').catch(() => null);
  if (!uid) { c.send(JSON.stringify({ type: 'auth_fail' })); c.close(); return; }
  const u = await store.userById(uid); const info = { uid, nm: u ? u.name : '?', pos: null };
  const already = [...clients.values()].some(v => v.uid === uid);
  clients.set(c, info);
  c.onmessage = raw => onMsg(c, info, raw);
  c.onclose = () => { clients.delete(c); if (![...clients.values()].some(v => v.uid === uid)) bc({ type: 'sys', text: `${info.nm} 선장이 떠났습니다.` }); };
  c.send(JSON.stringify({ type: 'init', you: { id: uid, nm: info.nm }, world: worldSnapshot(), chat: CHAT.slice(-40), players: playerList() }));
  if (!already) bc({ type: 'sys', text: `${info.nm} 선장이 바다에 나왔습니다.` }, c);
});

(async () => {
  try { await store.init(); storeOk = true; } catch (e) { storeErr = String(e.message || e); console.error('저장소 연결 실패:', storeErr); }
  await loadWorld();
  server.listen(PORT, () => console.log(`뒤집힌 바다 서버: ${PORT}번 포트, 저장소=${store.kind}${storeOk ? '' : ' (연결 실패: ' + storeErr + ')'}`));
})();
process.on('SIGTERM', async () => { await saveWorld(); if (store.flush) store.flush(); process.exit(0); });
