// 운영 이벤트: 선생님이 직접 열거나, 세계 시계가 정해진 간격마다 저절로 연다.
// 범위: -1 = 온 바다, 0~11 = 바다 지역 하나
const REGIONS = ['은빛바다', '안개바다', '고래바다', '별빛바다', '붉은바다', '향신료바다', '산호바다', '무풍바다', '폭풍바다', '얼음바다', '고향바다', '바람바다'];
const TYPES = {
  festival: { n: '축제', ic: '🎉', def: 30, max: 100, good: 1, d: m => `항구에서 파는 값 +${m}%` },
  harvest: { n: '풍년 장터', ic: '🌾', def: 20, max: 60, good: 1, d: m => `항구에서 사는 값 −${m}%` },
  wind: { n: '순풍', ic: '🌬', def: 20, max: 60, good: 1, d: m => `배 속도 +${m}%` },
  raid: { n: '해적 대습격', ic: '☠', def: 100, max: 300, good: 0, d: m => `해적이 ${1 + m / 100}배 자주, 더 세게 나타남` },
  storm: { n: '폭풍', ic: '🌀', def: 30, max: 70, good: 0, d: m => `배 속도 −${m}%` },
};
const where = s => (s >= 0 && s < REGIONS.length ? REGIONS[s] : '온 바다');

function makeEvents({ W, bc, dirty }) {
  W.ev = W.ev || []; W.auto = W.auto || { on: false, every: 10, dur: 5, types: ['festival', 'harvest', 'wind', 'raid', 'storm'], next: 0 };
  let seq = Date.now() % 100000;
  const pub = () => bc({ type: 'ev', ev: W.ev });
  function start(type, scope, mag, mins, by) {
    const T = TYPES[type]; if (!T) return { err: 'type' };
    scope = Number.isInteger(scope) && scope >= -1 && scope < REGIONS.length ? scope : -1;
    mag = Math.max(5, Math.min(T.max, Math.round(+mag || T.def)));
    mins = Math.max(1, Math.min(240, Math.round(+mins || 10)));
    const now = Date.now(), e = { id: ++seq, type, scope, mag, start: now, end: now + mins * 60000, by: by || 'teacher' };
    W.ev.push(e); dirty(); pub();
    bc({ type: 'sys', text: `${T.ic} ${where(scope)}에 ${T.n}! ${T.d(mag)} (${mins}분 동안)${by === 'auto' ? ' · 세계 시계' : ''}` });
    return { ok: true, ev: e };
  }
  function end(id) { const e = W.ev.find(x => x.id === id); if (!e) return; W.ev = W.ev.filter(x => x.id !== id); dirty(); pub(); bc({ type: 'sys', text: `${TYPES[e.type].ic} ${where(e.scope)}의 ${TYPES[e.type].n}이(가) 끝났습니다.` }); }
  setInterval(() => {
    const now = Date.now();
    for (const e of W.ev.slice()) if (e.end <= now) end(e.id);
    const A = W.auto;
    if (A.on && A.types && A.types.length && now >= (A.next || 0)) {
      A.next = now + A.every * 60000; dirty();
      const t = A.types[Math.floor(Math.random() * A.types.length)], sc = Math.random() < .3 ? -1 : Math.floor(Math.random() * REGIONS.length);
      start(t, sc, TYPES[t].def, A.dur, 'auto');
    }
  }, 5000);
  return {
    start, end,
    setAuto(o) {
      const A = W.auto;
      if (typeof o.on === 'boolean') { A.on = o.on; if (o.on) A.next = Date.now() + 60000; }
      if (Number.isFinite(+o.every)) A.every = Math.max(2, Math.min(240, Math.round(+o.every)));
      if (Number.isFinite(+o.dur)) A.dur = Math.max(1, Math.min(120, Math.round(+o.dur)));
      if (Array.isArray(o.types)) A.types = o.types.filter(t => TYPES[t]);
      if (o.on) bc({ type: 'sys', text: `⏰ 세계 시계가 움직이기 시작했습니다. 약 ${A.every}분마다 바다 어딘가에서 일이 벌어집니다.` });
      dirty(); return A;
    },
    clear() { W.ev = []; pub(); },
  };
}
module.exports = { makeEvents, TYPES, REGIONS };
