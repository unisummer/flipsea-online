// 뒤집힌 바다 온라인 서버
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib'), crypto = require('crypto');
const { attach } = require('./ws-lite');
const { makeStore } = require('./store');
const { makeDuel } = require('./duel');
const { makeEvents } = require('./events');

const PORT = +process.env.PORT || 10000;
const store = makeStore();
let storeOk = false, storeErr = '';

// ---------- 게임 화면 ----------
const PUB = path.join(__dirname, 'public');
let INDEX = null, INDEX_GZ = null;
let ETAG = '';
function loadIndex() { INDEX = fs.readFileSync(path.join(PUB, 'index.html')); INDEX_GZ = zlib.gzipSync(INDEX, { level: 9 }); ETAG = '"' + crypto.createHash('sha1').update(INDEX).digest('hex').slice(0, 16) + '"'; }
loadIndex();

// ---------- 함께 쓰는 세계 ----------
const DECAY_MS = 20000;           // 시세 압력은 실제 20초마다 0.9배로 풀린다
const W = { mk: {}, dev: {}, disc: {}, inv: {}, nm: {}, dr: {}, cfg: { duel: true }, dpend: {}, ev: [], auto: null, season: 1 };   // dr: 결투 기록, cfg: 선생님 설정   // inv: 항구별 {선장id: 누적 투자 골드}
let CHAT = [], worldDirty = false, chatDirty = false;
function mkDecay(m, now) { const dt = now - m.t; if (dt > 0) { const f = Math.pow(0.9, dt / DECAY_MS); m.s *= f; m.b *= f; m.t = now; } return m; }
function mkPack(m) { return [+m.s.toFixed(3), +m.b.toFixed(3)]; }
function worldSnapshot() {
  const now = Date.now(), mk = {};
  for (const k in W.mk) { const m = mkDecay(W.mk[k], now); if (m.s + m.b < 0.05) { delete W.mk[k]; continue; } mk[k] = mkPack(m); }
  return { mk, dev: W.dev, disc: W.disc, inv: W.inv, nm: W.nm, dr: W.dr, cfg: W.cfg, ev: W.ev, season: W.season, now };
}
async function loadWorld() {
  try { const v = await store.kvGet('world'); if (v) { const o = JSON.parse(v); Object.assign(W, { mk: o.mk || {}, dev: o.dev || {}, disc: o.disc || {}, inv: o.inv || {}, nm: o.nm || {}, dr: o.dr || {}, cfg: Object.assign({ duel: true }, o.cfg), dpend: o.dpend || {}, ev: o.ev || [], auto: o.auto || null, season: o.season || 1 }); } } catch (e) { console.error('world load', e.message); }
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
    const b = await body(req, 4096); const name = String(b.name || '').normalize('NFC').replace(/\s+/g, ' ').trim(), pin = String(b.pin || ''), fk = name.toLowerCase();
    if (!NAME_RE.test(name)) return send(res, 400, { err: 'name' });
    if (!PIN_RE.test(pin)) return send(res, 400, { err: 'pin_format' });
    const f = fails.get(fk); if (f && f.until > Date.now()) return send(res, 429, { err: 'locked', wait: Math.ceil((f.until - Date.now()) / 1000) });
    let u = await store.userByName(name), isNew = false;
    if (u && b.create) return send(res, 409, { err: 'taken' });   // 이미 있는 이름은 새로 만들 수 없다
    if (!u) {
      if (!b.create) return send(res, 404, { err: 'no_user' });
      const salt = crypto.randomBytes(12).toString('hex'); const id = await store.createUser(name, salt, await hashPin(pin, salt)); u = { id, name }; isNew = true;
    } else {
      const h = await hashPin(pin, u.salt);
      if (!crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(u.hash, 'hex'))) {
        const g = f && f.until > Date.now() - 600000 ? f : { n: 0, until: 0 }; g.n++; if (g.n >= 5) { g.until = Date.now() + 5 * 60000; g.n = 0; } fails.set(fk, g);
        return send(res, 401, { err: 'pin', left: 5 - g.n });
      }
      fails.delete(fk);
    }
    const token = crypto.randomBytes(24).toString('hex'); await store.tokenSet(token, Number(u.id));
    return send(res, 200, { token, name: u.name, id: Number(u.id), isNew, season: W.season });
  }
  if (p === '/api/me') { const uid = await authUid(req); if (!uid) return send(res, 401, { err: 'auth' }); const u = await store.userById(uid); return send(res, 200, { id: uid, name: u ? u.name : '?', season: W.season }); }
  // 지난 시즌에 열려 있던 창이 옛 저장을 올리지 못하게 한다
  if ((p.startsWith('/api/doc/') || p === '/api/save') && req.method === 'PUT' && req.headers['x-season'] && Number(req.headers['x-season']) !== W.season) return send(res, 409, { err: 'season' });
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
  if (p.startsWith('/api/admin/') && req.method === 'POST') return admin(req, res, p.slice(11));
  if (p === '/api/rank') {
    const best = new Map();
    for (const r of await store.metasAll()) { let m; try { m = JSON.parse(r.data); } catch (e) { continue; } const a = m.asset || m.gold || 0; const o = best.get(r.uid); if (!o || a > o.asset) best.set(r.uid, { name: r.name, asset: a, gold: m.gold || 0, fame: m.fame || 0, day: m.day || 0, disc: m.disc || 0, ch: m.ch || 0, t: m.t || 0 }); }
    return send(res, 200, { list: [...best.values()].sort((a, b) => b.asset - a.asset).slice(0, 50) });
  }
  send(res, 404, { err: 'not_found' });
}
// ---------- 선생님(관리자) ----------
// Render 환경 변수 ADMIN_KEY에 넣은 관리자 비밀번호로만 쓸 수 있다.
let adminFail = { n: 0, until: 0 };
function kick(uid) { for (const [c, v] of clients) if (v.uid === uid) { c.send(JSON.stringify({ type: 'auth_fail' })); c.close(); } }
async function admin(req, res, act) {
  const KEY = process.env.ADMIN_KEY || '';
  if (KEY.length < 6) return send(res, 403, { err: 'no_admin' });
  if (adminFail.until > Date.now()) return send(res, 429, { err: 'locked', wait: Math.ceil((adminFail.until - Date.now()) / 1000) });
  const b = await body(req, 4096), k = Buffer.from(String(b.key || '')), K = Buffer.from(KEY);
  if (k.length !== K.length || !crypto.timingSafeEqual(k, K)) { if (++adminFail.n >= 5) adminFail = { n: 0, until: Date.now() + 10 * 60000 }; return send(res, 401, { err: 'key' }); }
  adminFail.n = 0;
  if (act === 'state') return send(res, 200, { duel: W.cfg.duel, ev: W.ev, auto: W.auto, season: W.season });
  if (act === 'event') { const r = EV.start(String(b.type), Number(b.scope), b.mag, b.mins, 'teacher'); return send(res, r.err ? 400 : 200, r); }
  if (act === 'event_end') { EV.end(Number(b.id)); return send(res, 200, { ok: true, ev: W.ev }); }
  if (act === 'auto') { return send(res, 200, { auto: EV.setAuto(b) }); }
  if (act === 'reset') {
    // 새 시즌: 저장·투자·결투·발견·대화를 모두 지운다. all이면 선장 계정도 지운다.
    if (b.confirm !== '초기화') return send(res, 400, { err: 'confirm' });
    const all = !!b.all;
    W.season = (W.season || 1) + 1;
    bc({ type: 'reset', season: W.season, all });
    for (const c of [...clients.keys()]) { try { c.close(); } catch (e) {} }
    await store.wipe(all);
    Object.assign(W, { mk: {}, dev: {}, disc: {}, inv: {}, nm: {}, dr: {}, dpend: {} }); EV.clear();
    CHAT = []; chatDirty = true; worldDirty = true; fails.clear(); await saveWorld();
    console.log(`새 시즌 ${W.season} 시작 (계정 ${all ? '삭제' : '유지'})`);
    return send(res, 200, { ok: true, season: W.season });
  }
  if (act === 'duel') { if (typeof b.on === 'boolean') { W.cfg.duel = b.on; worldDirty = true; bc({ type: 'cfg', cfg: W.cfg }); bc({ type: 'sys', text: b.on ? '⚔ 선생님이 결투를 켰습니다.' : '선생님이 결투를 껐습니다.' }); } return send(res, 200, { duel: W.cfg.duel }); }
  if (act === 'users') {
    const metas = {}; for (const r of await store.metasAll()) { let m; try { m = JSON.parse(r.data); } catch (e) { continue; } const o = metas[r.uid]; if (!o || (m.t || 0) > (o.t || 0)) metas[r.uid] = m; }
    const on = new Set([...clients.values()].map(v => v.uid));
    return send(res, 200, { duel: W.cfg.duel, list: (await store.usersAll()).map(u => { const m = metas[u.id] || {}; return { id: u.id, name: u.name, created: u.created, last: u.last, day: m.day || 0, gold: m.gold || 0, asset: m.asset || 0, online: on.has(u.id) }; }) });
  }
  const id = Number(b.id); if (!Number.isInteger(id) || !(await store.userById(id))) return send(res, 404, { err: 'no_user' });
  if (act === 'pin') {
    const pin = String(b.pin || ''); if (!PIN_RE.test(pin)) return send(res, 400, { err: 'pin_format' });
    const salt = crypto.randomBytes(12).toString('hex'); await store.setPin(id, salt, await hashPin(pin, salt)); kick(id);
    const u = await store.userById(id); fails.delete(u.name.toLowerCase());
    return send(res, 200, { ok: true });
  }
  if (act === 'delete') {
    kick(id); await store.deleteUser(id);
    for (const p in W.inv) if (W.inv[p][id]) { delete W.inv[p][id]; invChanged.add(+p); worldDirty = true; }
    delete W.nm[id]; DUEL.forget(id); return send(res, 200, { ok: true });
  }
  send(res, 404, { err: 'not_found' });
}
let ADMIN_HTML = null; try { ADMIN_HTML = fs.readFileSync(path.join(PUB, 'admin.html')); } catch (e) {}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (url.pathname === '/healthz') return send(res, 200, { ok: true, store: store.kind, storeOk, storeErr, players: clients.size });
    if (url.pathname === '/' || url.pathname === '/index.html') {
      // 같은 판이면 다시 보내지 않는다 (304) — 새로 고침 때 0.6MB를 아낀다
      if (req.headers['if-none-match'] === ETAG) { res.writeHead(304, { ETag: ETAG, 'Cache-Control': 'no-cache' }); return res.end(); }
      const gz = /\bgzip\b/.test(req.headers['accept-encoding'] || '');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: ETAG, Vary: 'Accept-Encoding', ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
      return res.end(gz ? INDEX_GZ : INDEX);
    }
    if (url.pathname === '/admin' && ADMIN_HTML) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(ADMIN_HTML); }
    res.writeHead(404); res.end('not found');
  } catch (e) {
    if (e && e.code === 413) return send(res, 413, { err: 'too_big' }); if (e && e.code === 400) return send(res, 400, { err: 'bad_json' });
    console.error(e); send(res, 500, { err: 'server', msg: String(e && e.message || e) });
  }
});

// ---------- 실시간 ----------
const clients = new Map();   // conn -> {uid, nm, pos, chatT}
function sendTo(uid, obj) { const s = JSON.stringify(obj); for (const [c, v] of clients) if (v.uid === uid) c.send(s); }
let EV = null;
const DUEL = makeDuel({ W, clients, bc: (o) => bc(o), sendTo, dirty: () => { worldDirty = true; } });
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
    info.pos = { lat: m.lat, lon: m.lon, hd: num(m.hd, -720, 720) ? m.hd : 0, port: Number.isInteger(m.port) ? m.port : -1, ships: Number.isInteger(m.ships) ? m.ships : 1, fl: String(m.fl || '').slice(0, 20), day: num(m.day, 0, 1e7) ? Math.floor(m.day) : 0, bat: !!m.bat, asset: num(m.asset, 0, 1e13) ? Math.round(m.asset) : 0, t: now };
  } else if (m.type === 'dask' || m.type === 'dans' || m.type === 'dack') {
    DUEL.onMsg(info, m);
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
// 줄여 보내기: [id, 위도×1000, 경도×1000, 뱃머리, 항구, 배 수×2+전투]
const sentKey = new Map(); let fullT = 0;
setInterval(() => {
  if (!clients.size) { sentKey.clear(); return; }
  const now = Date.now(), list = playerList();
  if (now - fullT > 30000) { fullT = now; sentKey.clear(); for (const o of list) fullSeen.add(o.id); bc({ type: 'players', list, now }); for (const o of list) sentKey.set(o.id, pk(o).join()); return; }
  const d = [], here = new Set();
  for (const o of list) { here.add(o.id); const a = pk(o), k = a.join(); if (sentKey.get(o.id) !== k) { sentKey.set(o.id, k); d.push(a); } }
  const gone = []; for (const id of sentKey.keys()) if (!here.has(id)) { gone.push(id); sentKey.delete(id); fullSeen.delete(id); }
  const add = list.filter(o => !fullSeen.has(o.id)); for (const o of add) fullSeen.add(o.id);
  if (d.length || gone.length) bc({ type: 'pd', now, d, gone, add: add.map(o => ({ id: o.id, nm: o.nm, fl: o.fl, day: o.day })) });
}, 2000);
const fullSeen = new Set();
function pk(o) { return [o.id, Math.round(o.lat * 1000), Math.round(o.lon * 1000), Math.round(o.hd || 0), o.port, (o.ships || 1) * 2 + (o.bat ? 1 : 0), Math.round((o.asset || 0) / 10) * 10]; }
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
  if (W.nm[uid] !== info.nm) { W.nm[uid] = info.nm; worldDirty = true; }
  DUEL.onJoin(info);
  if (!already) bc({ type: 'sys', text: `${info.nm} 선장이 바다에 나왔습니다.` }, c);
});

(async () => {
  try { await store.init(); storeOk = true; } catch (e) { storeErr = String(e.message || e); console.error('저장소 연결 실패:', storeErr); }
  await loadWorld();
  EV = makeEvents({ W, bc: (o) => bc(o), dirty: () => { worldDirty = true; } });
  server.listen(PORT, () => console.log(`뒤집힌 바다 서버: ${PORT}번 포트, 저장소=${store.kind}${storeOk ? '' : ' (연결 실패: ' + storeErr + ')'}`));
})();
process.on('SIGTERM', async () => { await saveWorld(); if (store.flush) store.flush(); process.exit(0); });
