// 게임 규칙 (public/index.html 의 ENGINE 부분과 같은 코드)

const RK='23456789TJQKA';
const HN=['하이카드','원페어','투페어','트리플','스트레이트','플러시','풀하우스','포카드','스트레이트 플러시'];
function rv(c){return RK.indexOf(c[0])+2}
function eval5(cs){
  const r=cs.map(rv).sort((a,b)=>b-a),fl=cs.every(c=>c[1]===cs[0][1]);
  let st=0;
  if(new Set(r).size===5){if(r[0]-r[4]===4)st=r[0];else if(r[0]===14&&r[1]===5)st=5}
  const cnt={};r.forEach(x=>cnt[x]=(cnt[x]||0)+1);
  const g=Object.entries(cnt).map(([k,v])=>[v,+k]).sort((a,b)=>b[0]-a[0]||b[1]-a[1]);
  let cat,k;
  if(st&&fl){cat=8;k=[st]}
  else if(g[0][0]===4){cat=7;k=[g[0][1],g[1][1]]}
  else if(g[0][0]===3&&g[1][0]===2){cat=6;k=[g[0][1],g[1][1]]}
  else if(fl){cat=5;k=r}
  else if(st){cat=4;k=[st]}
  else if(g[0][0]===3){cat=3;k=g.map(x=>x[1])}
  else if(g[0][0]===2&&g[1][0]===2){cat=2;k=g.map(x=>x[1])}
  else if(g[0][0]===2){cat=1;k=g.map(x=>x[1])}
  else{cat=0;k=r}
  let s=cat;for(let i=0;i<5;i++)s=s*15+(k[i]||0);
  return s;
}
function best(cs){
  const n=cs.length;if(n<5)return -1;let b=-1;const idx=[];
  (function rec(s){if(idx.length===5){const v=eval5(idx.map(i=>cs[i]));if(v>b)b=v;return}
    for(let i=s;i<n;i++){idx.push(i);rec(i+1);idx.pop()}})(0);
  return b;
}
function handName(s){const c=Math.floor(s/15**5);if(c===8&&Math.floor(s/15**4)%15===14)return '로열 플러시';return HN[c]}
function nextIn(list,from,pred){const n=list.length,i=list.indexOf(from);for(let k=1;k<=n;k++){const u=list[(i+k+n)%n];if(pred(u))return u}return null}
function pay(r,u,amt){const H=r.hand,p=H.ps[u],pl=r.players[u];const x=Math.max(0,Math.min(amt,pl.chips));pl.chips-=x;p.bet+=x;p.total+=x;if(pl.chips===0)p.allin=true;return x}
function hlog(H,s){H.log.push(s);if(H.log.length>40)H.log.splice(0,H.log.length-40)}
const TURN_MS=15000;
const MAX_BB=100000;
function levelBB(r,lv){const s=r.settings;return Math.min(s.bb*2**lv,s.maxBb||MAX_BB)}
function blindLevel(r,now){const m=+r.settings.upMin||0;if(!m||!r.startedAt)return 0;return Math.max(0,Math.floor((now-r.startedAt)/(m*60000)))}
function timeoutAct(r,priv,u){const H=r.hand;if(!H||H.street==='done'||H.toAct!==u)return;
  const ps=H.ps[u],t=H.curBet-ps.bet>0?'fold':'check';applyAction(r,priv,u,{type:t,n:H.n});
  H.log[H.log.length-1]+=' ⏰ 시간 초과';}
function canPlay(r,u){const p=r.players[u];return p&&!p.sitOut&&!p.left&&p.chips>0}
function startHand(r,deck){
  const elig=r.order.filter(u=>canPlay(r,u));
  if(elig.length<2)return null;
  const prev=r.hand&&r.hand.dealer;
  const dealer=prev?nextIn(r.order,prev,u=>elig.includes(u)):elig[0];
  const n=(r.handNo||0)+1;r.handNo=n;
  const lv=blindLevel(r,Date.now());
  const bbA=levelBB(r,lv),sbA=bbA/2;
  const seats=elig,ps={};
  seats.forEach(u=>ps[u]={bet:0,total:0,folded:false,allin:false,acted:false});
  const H={n,dealer,seats,ps,board:[],street:'pre',curBet:0,minRaise:bbA,sbA,bbA,toAct:null,shown:{},result:null,log:[],turnAt:Date.now()};
  let sb,bb;
  if(seats.length===2){sb=dealer;bb=nextIn(seats,dealer,()=>true)}
  else{sb=nextIn(seats,dealer,()=>true);bb=nextIn(seats,sb,()=>true)}
  H.sb=sb;H.bb=bb;r.hand=H;
  const holes={};seats.forEach(u=>holes[u]=[deck.pop(),deck.pop()]);
  hlog(H,`— ${n}번째 판 (블라인드 ${sbA}/${bbA}) —`);
  pay(r,sb,sbA);pay(r,bb,bbA);
  ps[sb].la={k:'blind',t:'SB',v:ps[sb].bet};ps[bb].la={k:'blind',t:'BB',v:ps[bb].bet};
  H.curBet=Math.max(...seats.map(u=>ps[u].bet));
  const priv={n,deck,holes};
  progress(r,priv,bb);
  return priv;
}
function roundDone(H){
  const act=H.seats.filter(u=>!H.ps[u].folded);if(act.length<=1)return true;
  const can=act.filter(u=>!H.ps[u].allin);
  if(can.length===0)return true;
  if(can.length===1&&H.ps[can[0]].bet>=H.curBet)return true;
  return can.every(u=>H.ps[u].acted&&H.ps[u].bet===H.curBet);
}
function nextToAct(H,from){return nextIn(H.seats,from,u=>{const p=H.ps[u];return !p.folded&&!p.allin&&(!p.acted||p.bet<H.curBet)})}
function nextStreet(H,priv){
  H.seats.forEach(u=>{const q=H.ps[u];q.bet=0;q.acted=false;if(!q.folded&&!q.allin)delete q.la});
  H.curBet=0;H.minRaise=H.bbA;
  priv.deck.pop();
  const k=H.street==='pre'?3:1;for(let i=0;i<k;i++)H.board.push(priv.deck.pop());
  H.street={pre:'flop',flop:'turn',turn:'river'}[H.street];
}
function progress(r,priv,last){
  const H=r.hand,act=H.seats.filter(u=>!H.ps[u].folded);
  if(act.length===1)return settle(r,priv,false);
  if(!roundDone(H)){H.toAct=nextToAct(H,last);H.turnAt=Date.now();return}
  for(;;){
    if(H.street==='river')return settle(r,priv,true);
    nextStreet(H,priv);
    const can=act.filter(u=>!H.ps[u].allin);
    if(can.length>=2){H.toAct=nextToAct(H,H.dealer);H.turnAt=Date.now();return}
  }
}
function applyAction(r,priv,u,a){
  const H=r.hand;
  if(!H||H.street==='done')return '진행 중인 판이 없어요';
  if(a.n!==H.n)return '지난 판의 액션이에요';
  if(H.toAct!==u)return '내 차례가 아니에요';
  const p=H.ps[u],pl=r.players[u],toCall=H.curBet-p.bet;let msg;
  let la;
  if(a.type==='fold'){p.folded=true;msg='폴드';la={k:'fold',t:'폴드'}}
  else if(a.type==='check'){if(toCall>0)return '체크할 수 없어요';msg='체크';la={k:'check',t:'체크'}}
  else if(a.type==='call'){
    if(toCall<=0){msg='체크';la={k:'check',t:'체크'}}
    else{const x=pay(r,u,toCall);msg=p.allin?`올인 콜 (${x})`:`콜 ${x}`;la=p.allin?{k:'allin',t:'올인',v:p.bet}:{k:'call',t:'콜',v:x}}
  }else if(a.type==='raise'||a.type==='allin'){
    const max=p.bet+pl.chips;let to=a.type==='allin'?max:Math.floor(+a.to||0);
    if(to>=max)to=max;
    else{const min=H.curBet+H.minRaise;if(to<min)return `최소 ${min}까지 올려야 해요`}
    if(to<=H.curBet){pay(r,u,to-p.bet);msg=`올인 (${to})`;la={k:'allin',t:'올인',v:to}}
    else{
      const inc=to-H.curBet;if(inc>=H.minRaise)H.minRaise=inc;
      const wasBet=H.curBet===0;pay(r,u,to-p.bet);H.curBet=to;
      H.seats.forEach(v=>{if(v!==u)H.ps[v].acted=false});
      msg=p.allin?`올인!! (${to})`:(wasBet?`벳 ${to}`:`레이즈 → ${to}`);
      la=p.allin?{k:'allin',t:'올인',v:to}:wasBet?{k:'bet',t:'벳',v:to}:{k:'raise',t:'레이즈',v:to};
    }
  }else return '알 수 없는 액션';
  p.acted=true;p.la=Object.assign(la,{at:Date.now()});hlog(H,`${pl.name}: ${msg}`);
  progress(r,priv,u);
  return null;
}
function forceFold(r,priv,u,why){
  const H=r.hand;if(!H||H.street==='done'||!H.ps[u]||H.ps[u].folded)return;
  if(H.toAct===u){applyAction(r,priv,u,{type:'fold',n:H.n});return}
  H.ps[u].folded=true;H.ps[u].la={k:'fold',t:'폴드',at:Date.now()};hlog(H,`${r.players[u].name}: 폴드 (${why||'자리 비움'})`);
  const act=H.seats.filter(v=>!H.ps[v].folded);
  if(act.length===1)settle(r,priv,false);
  else if(roundDone(H))progress(r,priv,H.toAct);
}
function settle(r,priv,show){
  const H=r.hand,ps=H.ps,act=H.seats.filter(u=>!ps[u].folded);
  const levels=[...new Set(H.seats.map(u=>ps[u].total).filter(x=>x>0))].sort((a,b)=>a-b);
  let prev=0;const pots=[];
  for(const L of levels){
    let amt=0;H.seats.forEach(u=>amt+=Math.max(0,Math.min(ps[u].total,L)-prev));
    const el=act.filter(u=>ps[u].total>=L);prev=L;if(!amt)continue;
    const last=pots[pots.length-1];
    if(!el.length||(last&&last.el.join()===el.join())){if(last)last.amt+=amt;else pots.push({amt,el:act.slice()})}
    else pots.push({amt,el});
  }
  const score={};if(show)act.forEach(u=>score[u]=best(priv.holes[u].concat(H.board)));
  const won={},res=[];
  for(const P of pots){
    let w;
    if(!show)w=[act[0]];
    else{const m=Math.max(...P.el.map(u=>score[u]));w=P.el.filter(u=>score[u]===m)}
    const ord=[];let c=H.dealer;
    for(let i=0;i<H.seats.length;i++){c=nextIn(H.seats,c,()=>true);if(w.includes(c))ord.push(c)}
    const share=Math.floor(P.amt/ord.length);let rem=P.amt-share*ord.length;
    ord.forEach(u=>{const g=share+(rem>0?1:0);if(rem>0)rem--;won[u]=(won[u]||0)+g;r.players[u].chips+=g});
    res.push({amt:P.amt,w:ord,hand:show?handName(score[ord[0]]):null,solo:P.el.length===1});
  }
  const names={};
  if(show)act.forEach(u=>{H.shown[u]=priv.holes[u];names[u]=handName(score[u])});
  H.result={pots:res,won,show,names};
  H.street='done';H.toAct=null;H.doneAt=Date.now();
  Object.keys(won).forEach(u=>hlog(H,`🏆 ${r.players[u].name} +${won[u]}${show?` (${names[u]})`:''}`));
}
function voidHand(r){
  const H=r.hand;if(!H||H.street==='done')return;
  H.seats.forEach(u=>{r.players[u].chips+=H.ps[u].total});
  H.street='done';H.toAct=null;H.result={void:true,pots:[],won:{}};H.doneAt=Date.now();
  hlog(H,'⚠️ 이번 판은 무효 처리됐어요 (칩 환불)');
}

module.exports={RK,startHand,applyAction,forceFold,timeoutAct,voidHand,canPlay,blindLevel,levelBB,hlog,best,handName,MAX_BB,TURN_MS};
