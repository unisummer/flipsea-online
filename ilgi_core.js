// ===== 일기토 규칙 (게임과 서버가 같이 쓴다) =====
// 매 판: 방어 1개(상·중·하) + 공격 1개(높이 × 베기·찌르기·치기). 비기: 연격(공격 2) · 철벽(방어 2) · 필살(피해 2배)
const IGR={
  H:['상단','중단','하단'],
  T:{cut:{n:'베기',ic:'🪓',m:1.2},thr:{n:'찌르기',ic:'🗡',m:.9},bash:{n:'치기',ic:'🔨',m:1.0}},
  BEATS:{thr:'cut',cut:'bash',bash:'thr'}, // 대치에서 먼저 닿는 쪽: 찌르기 > 베기 > 치기 > 찌르기
  SK:{combo:{n:'연격',cost:2},wall:{n:'철벽',cost:2},kill:{n:'필살',cost:3}},
  MAXR:10,
};
// 싸우는 사람: {nm, hp, hpMax, atk, wt, tb, q, def, res:{cut,thr,bash}, hv, dam, blk, ki, stag, leg}
function igCheck(F,c){ // 고른 수가 규칙에 맞는지 고쳐서 돌려준다
  const sk=IGR.SK[c&&c.sk]&&F.ki>=IGR.SK[c.sk].cost?c.sk:'';
  const H=x=>[0,1,2].includes(x);let g=(c&&Array.isArray(c.g)?c.g:[]).filter(H);let a=(c&&Array.isArray(c.a)?c.a:[]).filter(x=>x&&H(x.h)&&IGR.T[x.t]);
  if(F.leg)a=a.filter(x=>x.h!==0);
  g=[...new Set(g)].slice(0,sk==='wall'?2:1);if(!g.length)g=[1];
  const seen=new Set();a=a.filter(x=>!seen.has(x.h)&&seen.add(x.h)).slice(0,sk==='combo'?2:1);if(!a.length)a=[{h:F.leg?1:1,t:F.wt||'thr'}];
  return {g,a:a.map(x=>({h:x.h,t:x.t})),sk:(sk==='wall'&&g.length<2)||(sk==='combo'&&a.length<2)?'':sk};}
function igDmg(X,Y,t,rnd,kill){
  const match=t===X.wt?X.tb:.9;let d=X.atk*IGR.T[t].m*match;
  d=(d*(1-((Y.res||{})[t]||0))-Y.def*.35)*.7;d=Math.max(1,d)*(.9+.2*rnd());
  if(Y.stag)d*=1.15;if(Y.hp<Y.hpMax*.3)d*=1-Math.min(.25,Y.dam/400);if(kill)d*=2;return d;}
function igRound(A,B,ca,cb,rnd){
  rnd=rnd||Math.random;ca=igCheck(A,ca);cb=igCheck(B,cb);const ev=[];
  for(const [F,c] of [[A,ca],[B,cb]])if(c.sk)F.ki-=IGR.SK[c.sk].cost;
  const nx={A:{stag:0,leg:0},B:{stag:0,leg:0}},dmgA=[],dmgB=[]; // dmgA: A가 받는 피해
  const atA=ca.a.map(x=>({...x,kill:ca.sk==='kill'})),atB=cb.a.map(x=>({...x,kill:cb.sk==='kill'}));
  const usedB=new Set();
  // 1) 대치: 공격 높이가 같으면 칼끼리 부딪힌다
  for(const a of atA){const j=atB.findIndex((b,i)=>!usedB.has(i)&&b.h===a.h);if(j<0)continue;const b=atB[j];usedB.add(j);a.used=1;b.used=1;
    let win=0;if(a.t===b.t){const s=(A.q-A.hv)-(B.q-B.hv);win=s>0?1:s<0?-1:0;}else win=IGR.BEATS[a.t]===b.t?1:IGR.BEATS[b.t]===a.t?-1:0;
    const dA=igDmg(B,A,b.t,rnd,b.kill),dB=igDmg(A,B,a.t,rnd,a.kill);
    if(win===0){dmgA.push(dA*.35);dmgB.push(dB*.35);ev.push({k:'clash',h:a.h,ta:a.t,tb:b.t,w:0});}
    else if(win>0){dmgA.push(dA*.2);dmgB.push(dB*.6);A.ki++;ev.push({k:'clash',h:a.h,ta:a.t,tb:b.t,w:1});}
    else{dmgA.push(dA*.6);dmgB.push(dB*.2);B.ki++;ev.push({k:'clash',h:a.h,ta:a.t,tb:b.t,w:-1});}}
  // 2) 막힘 / 3) 유효
  const hit=(X,Y,a,cY,arr,who,nY)=>{if(a.used)return;
    if(cY.g.includes(a.h)){let f=a.kill?.5:a.t==='cut'?.2:a.t==='bash'?.3:0;f+=X.blk||0;if(f>0)arr.push(igDmg(X,Y,a.t,rnd,false)*f);
      if(a.t==='bash'&&!a.kill){Y.ki--;nY.stag=1;}else Y.ki++;ev.push({k:'block',by:who,h:a.h,t:a.t,f:Math.round(f*100)});}
    else{arr.push(igDmg(X,Y,a.t,rnd,a.kill)*(a.h===0?1.2:a.h===2?.8:1));Y.ki+=a.h===0?-1:1;if(a.h===2)nY.leg=1;ev.push({k:'hit',by:who,h:a.h,t:a.t,kill:!!a.kill});}};
  for(const a of atA)hit(A,B,a,cb,dmgB,'A',nx.B);
  for(const b of atB)hit(B,A,b,ca,dmgA,'B',nx.A);
  const tA=Math.round(dmgA.reduce((s,x)=>s+x,0)),tB=Math.round(dmgB.reduce((s,x)=>s+x,0));
  A.hp=Math.max(0,A.hp-tA);B.hp=Math.max(0,B.hp-tB);
  for(const [F,n] of [[A,nx.A],[B,nx.B]]){F.ki=Math.max(0,Math.min(3,F.ki));F.stag=n.stag;F.leg=n.leg;}
  return {ca,cb,ev,dA:tA,dB:tB};}
function igOver(A,B,r,rnd){rnd=rnd||Math.random;const cmp=()=>{const a=A.hp/A.hpMax,b=B.hp/B.hpMax;return a===b?(rnd()<.5?'A':'B'):a>b?'A':'B';};
  if(A.hp<=0&&B.hp<=0)return rnd()<.5?'A':'B';if(A.hp<=0)return 'B';if(B.hp<=0)return 'A';if(r>=IGR.MAXR)return cmp();return null;}
// 담력으로 상대 수를 엿보기: 상대가 고른 것 중 하나를 사실대로 알려 준다
function igHint(me,foe,cFoe,rnd){rnd=rnd||Math.random;const p=Math.max(.05,Math.min(.6,.15+(me.dam-foe.dam)/150));if(rnd()>p)return null;
  if(rnd()<.6){const a=cFoe.a[0];return {k:'a',h:a.h,txt:`상대 시선이 ${a.h===0?'위로':a.h===2?'아래로':'몸통으로'} 향한다… (${IGR.H[a.h]} 공격 기미)`};}
  const g=cFoe.g[0];return {k:'g',h:g,txt:`상대가 ${IGR.H[g]}을 감싸는 자세다… (${IGR.H[g]} 막기 기미)`};}
// 공정 모드: 능력과 장비를 모두 같게
function igFair(F){return Object.assign(F,{hpMax:120,hp:120,atk:20,wt:F.wt,tb:1.3,q:0,def:4,res:{},hv:0,dam:50,blk:0});}
// 받은 값 다듬기 (서버에서 클라이언트 값 검사)
function igClean(f){const c=(v,a,b,d)=>typeof v==='number'&&isFinite(v)?Math.max(a,Math.min(b,v)):d;f=f||{};
  return {nm:String(f.nm||'?').slice(0,16),hpMax:c(f.hpMax,40,240,90),hp:c(f.hpMax,40,240,90),atk:c(f.atk,4,70,15),wt:IGR.T[f.wt]?f.wt:'bash',tb:c(f.tb,1,1.6,1),q:c(f.q,-1,2,0),
    def:c(f.def,0,30,0),res:{cut:c(f.res&&f.res.cut,0,.6,0),thr:c(f.res&&f.res.thr,0,.6,0),bash:c(f.res&&f.res.bash,0,.6,0)},hv:c(f.hv,0,2,0),dam:c(f.dam,0,100,20),blk:c(f.blk,0,.25,0),ki:0,stag:0,leg:0,
    wn:String(f.wn||'').slice(0,24),an:String(f.an||'').slice(0,24)};}
if(typeof module!=='undefined')module.exports={IGR,igCheck,igRound,igOver,igHint,igFair,igClean,igDmg};
