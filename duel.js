// 선장끼리 결투: 신청 → 수락 → 서버가 승부를 계산해 두 사람에게 같은 결과를 보낸다
// 진 쪽은 배를 잃지 않는다. 선체가 상하고, 미리 건 내기 골드만 오간다.

const IGC = require('./ilgi_core');
const RANGE_KM = 600;
const IG_MS = 10000;   // 일기토 한 판 고르는 시간          // 이 거리 안에 있어야 결투를 신청할 수 있다
const ASK_MS = 25000;          // 상대가 답할 시간
const PAIR_COOL = 90000;       // 같은 두 사람이 다시 붙으려면 기다리는 시간
const MAX_BET = 1e8;

function km(a, b) {
  const R = 6371, D = Math.PI / 180, dLat = (b.lat - a.lat) * D, dLon = (b.lon - a.lon) * D;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * D) * Math.cos(b.lat * D) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
const num = (x, a, b) => typeof x === 'number' && isFinite(x) && x >= a && x <= b;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// 클라이언트가 보낸 함대 모습을 믿을 만한 범위로 다듬는다
function cleanSnap(s) {
  if (!s || !Array.isArray(s.ships) || !s.ships.length) return null;
  const ships = s.ships.slice(0, 5).map(x => {
    const mx = clamp(Math.round(+x.mx || 80), 30, 600);
    return { t: clamp(Math.round(+x.t || 0), 0, 30), n: String(x.n || '배').slice(0, 16), mx, hp: clamp(Math.round(+x.hp || mx), 1, mx), g: clamp(Math.round(+x.g || 0), 0, 80) };
  });
  return {
    ships,
    crew: clamp(Math.round(+s.crew || 0), 0, 1000), need: clamp(Math.round(+s.need || 1), 1, 1000),
    gun: clamp(+s.gun || 0, 0, 120), spd: clamp(+s.spd || 1, .3, 5), gold: clamp(Math.floor(+s.gold || 0), 0, 1e12),
  };
}

// 같은 씨앗이면 같은 결과가 나오는 난수
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

// 해전 계산: 최대 10번 주고받는다. 배는 가라앉지 않고 정원의 15%에서 멈춘다(항복).
function fight(A, B, seed) {
  const r = rng(seed), side = S => ({ ships: S.ships.map(x => ({ ...x, floor: Math.ceil(x.mx * .15) })), S });
  const a = side(A), b = side(B), rounds = [];
  const crewF = S => clamp(S.crew / S.need, .3, 1);
  const tot = X => X.ships.reduce((s, x) => s + x.hp, 0), max = X => X.ships.reduce((s, x) => s + x.mx, 0);
  const ratio = X => (tot(X) - X.ships.reduce((s, x) => s + x.floor, 0)) / Math.max(1, max(X) - X.ships.reduce((s, x) => s + x.floor, 0));
  const shoot = (X, Y) => {
    // 빠른 쪽이 더 잘 맞히고 덜 맞는다. 포술사 능력과 선원 수도 중요하다.
    const hit = clamp(.5 + .12 * (X.S.gun / 100) + .1 * (X.S.spd - Y.S.spd), .25, .85);
    let dmg = 0;
    for (const s of X.ships) { if (s.hp <= s.floor) continue; const live = .55 + .45 * (s.hp / s.mx); dmg += s.g * hit * live * (.7 + .6 * r()) * .9; }
    dmg = Math.round(dmg * crewF(X.S));
    const alive = Y.ships.filter(s => s.hp > s.floor); if (!alive.length) return { dmg: 0, to: -1 };
    const tgt = alive[Math.floor(r() * alive.length)], before = tgt.hp; tgt.hp = Math.max(tgt.floor, tgt.hp - dmg);
    return { dmg: before - tgt.hp, to: Y.ships.indexOf(tgt) };
  };
  // 빠른 쪽이 먼저 쏜다
  const aFirst = A.spd + r() * .2 >= B.spd + r() * .2;
  for (let i = 0; i < 10; i++) {
    const ev = [];
    for (const who of aFirst ? ['a', 'b'] : ['b', 'a']) {
      const X = who === 'a' ? a : b, Y = who === 'a' ? b : a;
      if (ratio(X) <= 0) continue;
      const s = shoot(X, Y); ev.push([who, s.to, s.dmg]);
    }
    rounds.push({ ev, ha: a.ships.map(x => x.hp), hb: b.ships.map(x => x.hp) });
    if (ratio(a) <= .05 || ratio(b) <= .05) break;
  }
  const ra = ratio(a), rb = ratio(b);
  const win = ra === rb ? (tot(a) >= tot(b) ? 'a' : 'b') : (ra > rb ? 'a' : 'b');
  return { rounds, win, ha: a.ships.map(x => x.hp), hb: b.ships.map(x => x.hp) };
}

function makeDuel({ W, clients, bc, sendTo, dirty }) {
  W.dr = W.dr || {}; W.cfg = W.cfg || {}; W.dpend = W.dpend || {}; W.ig = W.ig || {};
  if (W.cfg.duel === undefined) W.cfg.duel = true;
  if (W.cfg.ig === undefined) W.cfg.ig = true;
  const matches = new Map(); // 진행 중인 일기토
  const pending = new Map(); // id -> {id, from, to, bet, snap, t}
  const pairT = new Map();
  let seq = 1;
  const posOf = uid => { let p = null; for (const v of clients.values()) if (v.uid === uid && v.pos && (!p || v.pos.t > p.t)) p = v.pos; return p; };
  const online = uid => [...clients.values()].some(v => v.uid === uid);
  const rec = uid => W.dr[uid] || (W.dr[uid] = { w: 0, l: 0, net: 0, r: 1000 });
  const err = (uid, text) => sendTo(uid, { type: 'dfail', text });

  function check(a, b) {
    if (!W.cfg.duel) return '선생님이 결투를 꺼 두었습니다.';
    const pa = posOf(a), pb = posOf(b);
    if (!pa || !pb || !online(b)) return '상대가 지금 바다에 없습니다.';
    if (pa.port >= 0 || pb.port >= 0) return '항구 안에서는 결투할 수 없습니다. 둘 다 바다에 있어야 합니다.';
    if (pa.bat || pb.bat) return '해적과 싸우는 중에는 결투할 수 없습니다.';
    const d = km(pa, pb); if (d > RANGE_KM) return `너무 멉니다 (${Math.round(d)}km). ${RANGE_KM}km 안으로 다가가세요.`;
    return null;
  }

  function ask(info, m) {
    const ig = m.mode === 'ig';
    if (ig && !W.cfg.ig) return err(info.uid, '선생님이 일기토를 꺼 두었습니다.');
    if (ig && inMatch(info.uid)) return err(info.uid, '이미 일기토 중입니다.');
    const to = Number(m.to), bet = Math.floor(+m.bet || 0), snap = ig ? { ships: [{ t: 0, mx: 80, hp: 80, g: 0 }], gold: +(m.snap && m.snap.gold) || 0 } : cleanSnap(m.snap);
    const fA = ig ? IGC.igClean(m.f) : null;
    if (!Number.isInteger(to) || to === info.uid) return;
    if (!snap) return err(info.uid, '함대 정보를 읽지 못했습니다.');
    if (!num(bet, 0, MAX_BET) || bet > snap.gold) return err(info.uid, '가진 골드보다 많이 걸 수 없습니다.');
    const why = check(info.uid, to); if (why) return err(info.uid, why);
    const pk = [info.uid, to].sort().join('-'), pt = pairT.get(pk) || 0;
    if (Date.now() - pt < PAIR_COOL) return err(info.uid, `같은 상대와는 ${Math.ceil((PAIR_COOL - (Date.now() - pt)) / 1000)}초 뒤에 다시 붙을 수 있습니다.`);
    for (const p of pending.values()) if (p.from === info.uid || p.to === info.uid || p.from === to || p.to === to) return err(info.uid, '둘 중 한 사람이 이미 다른 결투를 기다리는 중입니다.');
    const id = seq++, p = { id, from: info.uid, fnm: info.nm, to, bet, snap: ig ? { gold: Math.floor(+m.snap.gold || 0) } : snap, t: Date.now(), ig, fA };
    if (ig) p.snap.gold = Math.max(0, Math.floor(+(m.snap && m.snap.gold) || 0));
    pending.set(id, p);
    const R = rec(info.uid);
    const IR = igRec(info.uid);
    sendTo(to, ig ? { type: 'dreq', id, mode: 'ig', from: info.uid, nm: info.nm, bet, f: { wn: fA.wn, an: fA.an, wt: fA.wt, hpMax: W.cfg.igFair ? 120 : fA.hpMax }, fair: !!W.cfg.igFair, rec: [IR.w, IR.l, Math.round(IR.r)], ms: ASK_MS }
      : { type: 'dreq', id, from: info.uid, nm: info.nm, bet, ships: snap.ships.map(s => [s.t, s.n, s.hp, s.mx, s.g]), rec: [R.w, R.l, Math.round(R.r)], ms: ASK_MS });
    sendTo(info.uid, { type: 'dwait', id, to, ms: ASK_MS });
    setTimeout(() => { if (pending.get(id) === p) { pending.delete(id); sendTo(p.from, { type: 'dfail', text: '상대가 답하지 않아 결투가 취소되었습니다.' }); sendTo(p.to, { type: 'dgone', id }); } }, ASK_MS + 1500);
  }

  function answer(info, m) {
    const p = pending.get(Number(m.id)); if (!p || p.to !== info.uid) return;
    pending.delete(p.id);
    if (!m.ok) { sendTo(p.from, { type: 'dfail', text: `${info.nm} 선장이 ${p.ig ? '일기토' : '결투'}를 거절했습니다.` }); return; }
    if (p.ig) return igBegin(p, info, m);
    const snap = cleanSnap(m.snap); if (!snap) return err(info.uid, '함대 정보를 읽지 못했습니다.');
    if (p.bet > snap.gold) { const t = '상대의 골드가 내기 금액보다 적어 결투가 취소되었습니다.'; err(info.uid, '가진 골드가 내기 금액보다 적습니다.'); sendTo(p.from, { type: 'dfail', text: t }); return; }
    const why = check(p.from, p.to); if (why) { err(p.from, why); err(p.to, why); return; }
    pairT.set([p.from, p.to].sort().join('-'), Date.now());
    const seed = (Date.now() ^ (p.from * 7919) ^ (p.to * 104729)) >>> 0;
    const F = fight(p.snap, snap, seed);
    const winU = F.win === 'a' ? p.from : p.to, loseU = F.win === 'a' ? p.to : p.from;
    const Wr = rec(winU), Lr = rec(loseU), ex = 1 / (1 + 10 ** ((Lr.r - Wr.r) / 400)), k = Math.round(32 * (1 - ex));
    Wr.w++; Lr.l++; Wr.r += k; Lr.r -= k; Wr.net += p.bet; Lr.net -= p.bet; dirty();
    const res = { type: 'dres', id: p.id, t: Date.now(), bet: p.bet, a: { id: p.from, nm: p.fnm, ships: p.snap.ships }, b: { id: p.to, nm: info.nm, ships: snap.ships }, rounds: F.rounds, win: F.win, ha: F.ha, hb: F.hb, dr: k };
    for (const u of [p.from, p.to]) { if (online(u)) sendTo(u, res); else (W.dpend[u] = W.dpend[u] || []).push(res); }
    bc({ type: 'sys', text: `⚔ ${F.win === 'a' ? p.fnm : info.nm} 선장이 ${F.win === 'a' ? info.nm : p.fnm} 선장과의 결투에서 이겼습니다!${p.bet ? ` (내기 ${p.bet.toLocaleString()}골드)` : ''}` });
    bc({ type: 'dr', dr: { [winU]: Wr, [loseU]: Lr }, nm: { [winU]: W.nm[winU], [loseU]: W.nm[loseU] } });
  }

  // ---------- 일기토 대전: 서버가 심판 ----------
  const igRec = uid => W.ig[uid] || (W.ig[uid] = { w: 0, l: 0, net: 0, r: 1000 });
  const inMatch = uid => [...matches.values()].some(M => M.a === uid || M.b === uid);
  const pub = F => ({ nm: F.nm, hp: F.hp, hpMax: F.hpMax, atk: F.atk, wt: F.wt, tb: F.tb, q: F.q, def: F.def, res: F.res, hv: F.hv, dam: F.dam, blk: F.blk, ki: F.ki, stag: F.stag, leg: F.leg, wn: F.wn, an: F.an });
  function igBegin(p, info, m) {
    const gold = Math.max(0, Math.floor(+(m.snap && m.snap.gold) || 0));
    if (p.bet > gold) { err(info.uid, '가진 골드가 내기 금액보다 적습니다.'); sendTo(p.from, { type: 'dfail', text: '상대의 골드가 내기 금액보다 적어 취소되었습니다.' }); return; }
    const why = check(p.from, p.to); if (why) { err(p.from, why); err(p.to, why); return; }
    if (inMatch(p.from) || inMatch(p.to)) { err(p.from, '둘 중 한 사람이 이미 일기토 중입니다.'); return; }
    pairT.set([p.from, p.to].sort().join('-'), Date.now());
    const A = Object.assign(p.fA, { nm: p.fnm }), B = Object.assign(IGC.igClean(m.f), { nm: info.nm });
    if (W.cfg.igFair) { IGC.igFair(A); IGC.igFair(B); }
    const M = { id: p.id, a: p.from, b: p.to, A, B, r: 0, ch: {}, bet: p.bet, fair: !!W.cfg.igFair };
    matches.set(M.id, M);
    for (const [u, me] of [[M.a, 'A'], [M.b, 'B']]) sendTo(u, { type: 'igs', id: M.id, me, A: pub(A), B: pub(B), bet: M.bet, fair: M.fair, ms: IG_MS });
    igRoundStart(M);
  }
  function igRoundStart(M) { M.ch = {}; M.hinted = {}; clearTimeout(M.tm); M.tm = setTimeout(() => igResolve(M), IG_MS + 1500); }
  function igChoose(info, m) {
    const M = matches.get(Number(m.id)); if (!M) return; const side = info.uid === M.a ? 'A' : info.uid === M.b ? 'B' : null; if (!side || M.ch[side]) return;
    M.ch[side] = IGC.igCheck(M[side], m.c);
    const other = side === 'A' ? 'B' : 'A', ou = side === 'A' ? M.b : M.a;
    // 먼저 고른 쪽의 수를, 아직 고르는 상대가 담력만큼 엿볼 수 있다
    if (!M.ch[other] && !M.hinted[other]) { M.hinted[other] = 1; const h = IGC.igHint(M[other], M[side], M.ch[side]); if (h) sendTo(ou, { type: 'igh', id: M.id, h }); }
    if (M.ch.A && M.ch.B) igResolve(M);
  }
  function igResolve(M) {
    if (!matches.has(M.id)) return; clearTimeout(M.tm);
    const ca = M.ch.A || { g: [1], a: [{ h: 1, t: M.A.wt }] }, cb = M.ch.B || { g: [1], a: [{ h: 1, t: M.B.wt }] };
    const res = IGC.igRound(M.A, M.B, ca, cb); M.r++;
    const w = IGC.igOver(M.A, M.B, M.r);
    const st = { A: { hp: M.A.hp, ki: M.A.ki, stag: M.A.stag, leg: M.A.leg }, B: { hp: M.B.hp, ki: M.B.ki, stag: M.B.stag, leg: M.B.leg } };
    for (const u of [M.a, M.b]) sendTo(u, { type: 'igr', id: M.id, r: M.r, res, st, over: w || null });
    if (w) igEnd(M, w); else setTimeout(() => { if (matches.has(M.id)) { igRoundStart(M); for (const u of [M.a, M.b]) sendTo(u, { type: 'ign', id: M.id, r: M.r, ms: IG_MS }); } }, 1600);
  }
  function igEnd(M, w, why) {
    matches.delete(M.id); clearTimeout(M.tm);
    const winU = w === 'A' ? M.a : M.b, loseU = w === 'A' ? M.b : M.a, Wr = igRec(winU), Lr = igRec(loseU);
    const ex = 1 / (1 + 10 ** ((Lr.r - Wr.r) / 400)), k = Math.round(32 * (1 - ex));
    Wr.w++; Lr.l++; Wr.r += k; Lr.r -= k; Wr.net += M.bet; Lr.net -= M.bet; dirty();
    const res = { type: 'ige', id: M.id, win: w, bet: M.bet, dr: k, why: why || '', a: M.a, b: M.b };
    for (const u of [M.a, M.b]) { if (online(u)) sendTo(u, res); else (W.dpend[u] = W.dpend[u] || []).push(res); }
    const wn = w === 'A' ? M.A.nm : M.B.nm, ln = w === 'A' ? M.B.nm : M.A.nm;
    bc({ type: 'sys', text: `🗡 ${wn} 선장이 ${ln} 선장과의 일기토에서 이겼습니다!${why ? ' (' + why + ')' : ''}${M.bet ? ` (내기 ${M.bet.toLocaleString()}골드)` : ''}` });
    bc({ type: 'igrk', ig: { [winU]: Wr, [loseU]: Lr }, nm: { [winU]: W.nm[winU], [loseU]: W.nm[loseU] } });
  }
  // 접속이 끊긴 쪽은 15초 기다린 뒤 기권
  setInterval(() => { for (const M of [...matches.values()]) for (const [u, side] of [[M.a, 'A'], [M.b, 'B']]) {
    if (online(u)) { M['off' + side] = 0; continue; } M['off' + side] = M['off' + side] || Date.now();
    if (Date.now() - M['off' + side] > 15000) { igEnd(M, side === 'A' ? 'B' : 'A', '상대 연결 끊김'); break; } } }, 3000);

  return {
    onMsg(info, m) {
      if (m.type === 'igc') return igChoose(info, m);
      if (m.type === 'dask') ask(info, m);
      else if (m.type === 'dans') answer(info, m);
      else if (m.type === 'dack') { const L = W.dpend[info.uid]; if (L) { W.dpend[info.uid] = L.filter(r => r.id !== m.id); if (!W.dpend[info.uid].length) delete W.dpend[info.uid]; dirty(); } }
    },
    onJoin(info) { for (const r of W.dpend[info.uid] || []) sendTo(info.uid, r); },
    forget(uid) { delete W.dr[uid]; delete W.ig[uid]; delete W.dpend[uid]; dirty(); },
    fight, cleanSnap,
  };
}
module.exports = { makeDuel, fight, cleanSnap, RANGE_KM };
