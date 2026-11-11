// 저장소: DATABASE_URL이 있으면 PostgreSQL(Neon 등), 없으면 파일
const fs = require('fs'), path = require('path');

const SQL_INIT = [
  `create table if not exists users(id serial primary key, name text unique not null, salt text not null, hash text not null, created bigint not null)`,
  `create table if not exists tokens(token text primary key, uid int not null, created bigint not null)`,
  `create table if not exists docs(uid int not null, name text not null, data text not null, t bigint not null, primary key(uid,name))`,
  `create table if not exists kv(k text primary key, v text not null)`,
];
// 대소문자만 다른 이름도 같은 이름으로 본다 (예전 자료에 겹침이 있으면 이 줄만 건너뛴다)
const SQL_OPT = [`create unique index if not exists users_lname on users(lower(name))`];
const Q = {
  userByName: `select id,name,salt,hash from users where lower(name)=lower($1)`,
  usersAll: `select u.id, u.name, u.created, (select max(t) from docs d where d.uid=u.id) as last from users u order by u.id`,
  setPin: `update users set salt=$2, hash=$3 where id=$1`,
  tokensDel: `delete from tokens where uid=$1`,
  docsDel: `delete from docs where uid=$1`,
  userDel: `delete from users where id=$1`,
  userById: `select id,name from users where id=$1`,
  createUser: `insert into users(name,salt,hash,created) values($1,$2,$3,$4) returning id`,
  tokenSet: `insert into tokens(token,uid,created) values($1,$2,$3) on conflict(token) do nothing`,
  tokenUid: `select uid from tokens where token=$1`,
  docGet: `select data from docs where uid=$1 and name=$2`,
  docSet: `insert into docs(uid,name,data,t) values($1,$2,$3,$4) on conflict(uid,name) do update set data=excluded.data, t=excluded.t`,
  metasAll: `select d.uid, u.name, d.name as doc, d.data from docs d join users u on u.id=d.uid where d.name in ('meta','s2_meta','s3_meta')`,
  kvGet: `select v from kv where k=$1`,
  kvSet: `insert into kv(k,v) values($1,$2) on conflict(k) do update set v=excluded.v`,
};

function pgStore(url, pgLib) {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pgLib.Pool({ connectionString: url, max: 4, ssl: local ? false : { rejectUnauthorized: false } });
  const q = async (text, params) => (await pool.query(text, params)).rows;
  return {
    kind: 'pg',
    async init() { for (const s of SQL_INIT) await q(s); for (const s of SQL_OPT) { try { await q(s); } catch (e) { console.error('선택 색인 건너뜀:', e.message); } } },
    async usersAll() { return (await q(Q.usersAll, [])).map(r => ({ id: Number(r.id), name: r.name, created: Number(r.created), last: r.last ? Number(r.last) : 0 })); },
    async setPin(id, salt, hash) { await q(Q.setPin, [id, salt, hash]); await q(Q.tokensDel, [id]); },
    async deleteUser(id) { await q(Q.tokensDel, [id]); await q(Q.docsDel, [id]); await q(Q.userDel, [id]); },
    async userByName(n) { return (await q(Q.userByName, [n]))[0] || null; },
    async userById(id) { return (await q(Q.userById, [id]))[0] || null; },
    async createUser(n, salt, hash) { return Number((await q(Q.createUser, [n, salt, hash, Date.now()]))[0].id); },
    async tokenSet(t, uid) { await q(Q.tokenSet, [t, uid, Date.now()]); },
    async tokenUid(t) { const r = (await q(Q.tokenUid, [t]))[0]; return r ? Number(r.uid) : null; },
    async docGet(uid, n) { const r = (await q(Q.docGet, [uid, n]))[0]; return r ? r.data : null; },
    async docSet(uid, n, data) { await q(Q.docSet, [uid, n, data, Date.now()]); },
    async metasAll() { return (await q(Q.metasAll, [])).map(r => ({ uid: Number(r.uid), name: r.name, doc: r.doc, data: r.data })); },
    async kvGet(k) { const r = (await q(Q.kvGet, [k]))[0]; return r ? r.v : null; },
    async kvSet(k, v) { await q(Q.kvSet, [k, v]); },
  };
}

function fileStore(dir) {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'db.json');
  let D = { users: [], tokens: {}, docs: {}, kv: {} };
  try { D = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  let timer = null;
  const flush = () => { timer = null; const tmp = file + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(D)); fs.renameSync(tmp, file); };
  const dirty = () => { if (!timer) timer = setTimeout(flush, 800); };
  return {
    kind: 'file',
    flush() { if (timer) { clearTimeout(timer); flush(); } },
    async init() {},
    async userByName(n) { const k = n.toLowerCase(); return D.users.find(u => u.name.toLowerCase() === k) || null; },
    async usersAll() { return D.users.map(u => ({ id: u.id, name: u.name, created: u.created, last: (D.docT && D.docT[u.id]) || 0 })); },
    async setPin(id, salt, hash) { const u = D.users.find(x => x.id === id); if (u) { u.salt = salt; u.hash = hash; } for (const t in D.tokens) if (D.tokens[t] === id) delete D.tokens[t]; dirty(); },
    async deleteUser(id) { D.users = D.users.filter(x => x.id !== id); delete D.docs[id]; for (const t in D.tokens) if (D.tokens[t] === id) delete D.tokens[t]; dirty(); },
    async userById(id) { const u = D.users.find(u => u.id === id); return u ? { id: u.id, name: u.name } : null; },
    async createUser(n, salt, hash) { const id = D.users.length ? Math.max(...D.users.map(u => u.id)) + 1 : 1; D.users.push({ id, name: n, salt, hash, created: Date.now() }); dirty(); return id; },
    async tokenSet(t, uid) { D.tokens[t] = uid; dirty(); },
    async tokenUid(t) { return D.tokens[t] || null; },
    async docGet(uid, n) { return (D.docs[uid] && D.docs[uid][n]) || null; },
    async docSet(uid, n, data) { (D.docs[uid] || (D.docs[uid] = {}))[n] = data; (D.docT || (D.docT = {}))[uid] = Date.now(); dirty(); },
    async metasAll() { const out = []; for (const uid in D.docs) { const u = D.users.find(x => x.id === +uid); for (const n of ['meta', 's2_meta', 's3_meta']) if (D.docs[uid][n]) out.push({ uid: +uid, name: u ? u.name : '?', doc: n, data: D.docs[uid][n] }); } return out; },
    async kvGet(k) { return D.kv[k] || null; },
    async kvSet(k, v) { D.kv[k] = v; dirty(); },
  };
}

function makeStore() {
  const url = process.env.DATABASE_URL;
  if (url) {
    let pgLib = null; try { pgLib = require('pg'); } catch (e) { console.error('pg 모듈이 없어 파일 저장으로 돌아갑니다.'); }
    if (pgLib) return pgStore(url, pgLib);
  }
  return fileStore(process.env.DATA_DIR || path.join(__dirname, 'data'));
}
module.exports = { makeStore, SQL_INIT, Q };
