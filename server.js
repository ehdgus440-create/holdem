// 친구끼리 홀덤 — 게임 서버 (딜러 역할)
// 카드 섞기·나눠주기·베팅 처리·타이머를 모두 서버가 맡아서, 아무도 남의 카드를 볼 수 없어요.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const E = require('./engine.js');

const PORT = process.env.PORT || 3000;
const PAGE = path.join(__dirname, 'public', 'index.html');
const MAX_PLAYERS = 10;
const ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#fff3c4"/><stop offset=".45" stop-color="#d4a63c"/><stop offset="1" stop-color="#8a6416"/></linearGradient><radialGradient id="f" cx=".5" cy=".4" r=".7"><stop offset="0" stop-color="#1c7a55"/><stop offset="1" stop-color="#04261a"/></radialGradient></defs><rect width="512" height="512" rx="112" fill="#0b0a0d"/><rect x="28" y="28" width="456" height="456" rx="92" fill="url(#f)" stroke="url(#g)" stroke-width="14"/><text x="256" y="300" text-anchor="middle" font-family="Georgia,serif" font-size="230" font-weight="bold" fill="url(#g)">♠</text><text x="256" y="430" text-anchor="middle" font-family="Georgia,serif" font-size="74" font-weight="bold" fill="url(#g)" letter-spacing="6">HOLD'EM</text></svg>`;
const NEXT_HAND_MS = 9000;
const ROOM_IDLE_MS = 3 * 60 * 60 * 1000; // 아무도 없이 3시간 지나면 방 정리

const rooms = new Map(); // code -> { r, priv, socks: Map<id, ws>, turnT, nextT, emptySince }

/* ---------- HTTP ---------- */
const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.writeHead(200); res.end('ok'); return; }
  if (req.url === '/manifest.json') {
    res.writeHead(200, { 'content-type': 'application/manifest+json' });
    res.end(JSON.stringify({ name: '친구끼리 홀덤', short_name: '친구홀덤', start_url: '/', display: 'fullscreen', orientation: 'portrait', background_color: '#07070a', theme_color: '#07070a',
      icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }] }));
    return;
  }
  if (req.url === '/icon.svg') {
    res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    res.end(ICON);
    return;
  }
  fs.readFile(PAGE, (err, buf) => {
    if (err) { res.writeHead(500); res.end('page error'); return; }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-cache' });
    res.end(buf);
  });
});

/* ---------- helpers ---------- */
const clip = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u001f]/g, '').trim().slice(0, n);
function newDeck() {
  const d = [];
  for (const s of 'shdc') for (const r of E.RK) d.push(r + s);
  for (let i = d.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [d[i], d[j]] = [d[j], d[i]]; }
  return d;
}
function newCode() {
  const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  for (let k = 0; k < 50; k++) {
    const c = Array.from({ length: 4 }, () => A[crypto.randomInt(A.length)]).join('');
    if (!rooms.has(c)) return c;
  }
  return null;
}
function sendTo(ws, m) { try { if (ws.readyState === 1) ws.send(JSON.stringify(m)); } catch (e) {} }
function fmt(n) { return (+n || 0).toLocaleString('ko-KR'); }

function broadcast(room, extra) {
  const { r, priv } = room;
  const H = r.hand;
  const now = Date.now();
  const json = r; // 공개 정보만 들어 있음 (각자의 카드는 priv 에만 있음)
  for (const [id, ws] of room.socks) {
    const my = H && priv && priv.n === H.n && priv.holes[id] ? { n: H.n, cards: priv.holes[id] } : null;
    sendTo(ws, Object.assign({ t: 'state', room: json, my, now }, extra && extra[id] ? extra[id] : {}));
  }
}

function update(room) {
  room.r.updated = Date.now();
  broadcast(room);
  scheduleTurn(room);
  scheduleNext(room);
}

/* ---------- game flow ---------- */
function deal(room) {
  const { r } = room;
  const H0 = r.hand;
  if (H0 && H0.street !== 'done') return false;
  const elig = r.order.filter(u => E.canPlay(r, u));
  if (elig.length < 2) return false;
  if (!r.startedAt) r.startedAt = Date.now();
  room.priv = E.startHand(r, newDeck());
  r.started = true;
  return true;
}
function scheduleTurn(room) {
  clearTimeout(room.turnT);
  const H = room.r.hand;
  if (!H || H.street === 'done' || !H.toAct) return;
  const key = H.n + ':' + H.toAct + ':' + H.turnAt;
  const wait = Math.max(300, (H.turnAt || 0) + E.TURN_MS + 1000 - Date.now());
  room.turnT = setTimeout(() => {
    const h = room.r.hand;
    if (h && h.street !== 'done' && room.priv && room.priv.n === h.n && h.n + ':' + h.toAct + ':' + h.turnAt === key) {
      E.timeoutAct(room.r, room.priv, h.toAct);
      update(room);
    }
  }, wait);
}
function scheduleNext(room) {
  clearTimeout(room.nextT);
  const { r } = room, H = r.hand;
  if (!r.started || r.paused || !H || H.street !== 'done') return;
  const n = H.n;
  const wait = Math.max(1500, (H.doneAt || 0) + NEXT_HAND_MS - Date.now());
  room.nextT = setTimeout(() => {
    const h = room.r.hand;
    if (h && h.n === n && h.street === 'done' && !room.r.paused && deal(room)) update(room);
  }, wait);
}

/* ---------- player handling ---------- */
function attach(ws, code) {
  if (ws.code && ws.code !== code) detach(ws, false);
  const room = rooms.get(code);
  ws.code = code;
  const old = room.socks.get(ws.id);
  if (old && old !== ws) { old.code = null; try { old.close(4000, 'replaced'); } catch (e) {} }
  room.socks.set(ws.id, ws);
  room.emptySince = 0;
}
function detach(ws, leaving) {
  const room = rooms.get(ws.code);
  if (!room) { ws.code = null; return; }
  if (room.socks.get(ws.id) === ws) room.socks.delete(ws.id);
  const p = room.r.players[ws.id];
  if (p) {
    if (leaving) {
      p.left = true;
      E.forceFold(room.r, room.priv, ws.id, '나감');
      if (room.r.hand) E.hlog(room.r.hand, `🚪 ${p.name} 나감`);
    }
    p.off = !room.socks.has(ws.id);
  }
  // 방장이 나가거나 끊기면 접속 중인 다른 사람에게 방장 넘기기
  if (room.r.host === ws.id && !room.socks.has(ws.id)) {
    const next = room.r.order.find(u => room.socks.has(u) && !room.r.players[u].left);
    if (next) { room.r.host = next; if (room.r.hand) E.hlog(room.r.hand, `👑 ${room.r.players[next].name} 님이 새 방장`); }
  }
  if (!room.socks.size) room.emptySince = Date.now();
  ws.code = null;
  update(room);
}

function onCreate(ws, m) {
  const name = clip(m.name, 10) || '플레이어';
  ws.name = name;
  const st = m.settings || {};
  const chipsOK = [100000, 200000, 300000, 500000, 1000000];
  const chips = chipsOK.includes(+st.chips) ? +st.chips : 100000;
  const fixOK = [400, 1000, 2000, 4000, 10000, 20000, 50000, 100000];
  const fixed = +st.mode === 1;
  const bb = fixed ? (fixOK.includes(+st.fix) ? +st.fix : 400) : 400;
  const code = newCode();
  if (!code) return sendTo(ws, { t: 'err', msg: '방을 만들 수 없어요. 잠시 후 다시 해 주세요.' });
  const r = {
    code, host: ws.id, created: Date.now(), updated: Date.now(),
    settings: { chips, sb: bb / 2, bb, upMin: fixed ? 0 : 6, maxBb: E.MAX_BB, rebuy: +st.rebuy === 0 ? 0 : 1 },
    players: {}, order: [], seqs: {}, hand: null, handNo: 0, started: false, paused: false,
  };
  r.players[ws.id] = { name, chips, rebuys: 0, sitOut: false, left: false };
  r.order.push(ws.id);
  const room = { r, priv: null, socks: new Map(), turnT: null, nextT: null, emptySince: 0 };
  rooms.set(code, room);
  console.log(`[방 생성] ${code}`);
  attach(ws, code);
  broadcast(room, { [ws.id]: { created: true } });
}

function onJoin(ws, m) {
  const code = clip(m.code, 4).toUpperCase();
  let room = rooms.get(code);
  if (!room && m.snap && typeof m.snap === 'object' && m.snap.code === code && m.snap.players && m.snap.players[ws.id]) room = restoreRoom(code, m.snap, ws.id);
  if (!room) {
    console.log(`[join 실패] 없는 방 ${code} (현재 방: ${[...rooms.keys()].join(',') || '없음'})`);
    return sendTo(ws, { t: 'err', msg: `${code} 방을 찾을 수 없어요. 코드를 다시 확인해 주세요. (서버가 재시작되면 방이 사라질 수 있어요 — 그럴 땐 방장이 새로 만들어 주세요)`, home: true, silent: !!m.silent });
  }
  const { r } = room;
  const name = clip(m.name, 10) || ws.name || '플레이어';
  ws.name = name;
  let p = r.players[ws.id];
  if (!p) {
    if (r.order.filter(u => !r.players[u].left).length >= MAX_PLAYERS) return sendTo(ws, { t: 'err', msg: '방이 꽉 찼어요 (최대 10명).', home: true });
    p = r.players[ws.id] = { name, chips: r.settings.chips, rebuys: 0, sitOut: false, left: false };
    r.order.push(ws.id);
    if (r.hand) E.hlog(r.hand, `👋 ${name} 입장 (다음 판부터 참여)`);
  } else {
    if (p.left) { p.left = false; if (r.hand) E.hlog(r.hand, `👋 ${name} 돌아옴`); }
    p.name = name;
  }
  p.off = false;
  attach(ws, code);
  if (!room.socks.has(r.host) || r.players[r.host].left) r.host = ws.id;
  update(room);
}

// 서버가 재시작돼서 방이 사라졌을 때, 다시 접속한 사람의 화면에 남아 있던 방 정보로 복구 (진행 중이던 판은 무효 처리하고 칩 환불)
function restoreRoom(code, snap, byId) {
  try {
    const r = JSON.parse(JSON.stringify(snap));
    if (!Array.isArray(r.order) || typeof r.players !== 'object' || !r.settings) return null;
    r.order = r.order.filter(u => r.players[u]).slice(0, MAX_PLAYERS + 5);
    for (const u of r.order) { const p = r.players[u]; p.chips = Math.max(0, Math.floor(+p.chips || 0)); p.off = true; p.name = clip(p.name, 10) || '플레이어'; }
    if (r.hand && r.hand.street !== 'done') E.voidHand(r);
    if (r.hand) E.hlog(r.hand, '🔧 서버가 다시 켜져서 방을 복구했어요');
    r.seqs = {}; r.paused = false;
    if (!r.players[r.host]) r.host = byId;
    const room = { r, priv: null, socks: new Map(), turnT: null, nextT: null, emptySince: 0 };
    rooms.set(code, room);
    console.log(`[복구] 방 ${code} (${r.order.length}명)`);
    return room;
  } catch (e) { console.error('restore fail', e); return null; }
}

function onAct(ws, a) {
  const room = rooms.get(ws.code);
  if (!room || !a) return;
  const { r } = room, u = ws.id, p = r.players[u], H = r.hand;
  if (!p) return;
  const type = String(a.type || '');
  if (type === 'sit') p.sitOut = true;
  else if (type === 'back') p.sitOut = false;
  else if (type === 'rebuy') {
    const inHand = H && H.street !== 'done' && H.ps[u] && !H.ps[u].folded;
    if (r.settings.rebuy !== 0 && p.chips === 0 && !inHand) {
      p.chips += r.settings.chips; p.rebuys = (p.rebuys || 0) + 1;
      if (H) E.hlog(H, `🔄 ${p.name} 리바인 (+${fmt(r.settings.chips)}) · ${p.rebuys}번째`);
    }
  } else if (type === 'show') {
    if (H && H.street === 'done' && H.ps[u] && !H.shown[u] && room.priv && room.priv.n === H.n) {
      H.shown[u] = room.priv.holes[u]; E.hlog(H, `🃏 ${p.name}: 카드 공개!`);
    }
  } else if (['fold', 'check', 'call', 'raise', 'allin'].includes(type)) {
    if (!room.priv || !H || room.priv.n !== H.n) return;
    const err = E.applyAction(r, room.priv, u, { type, to: +a.to || 0, n: +a.n });
    if (err) { sendTo(ws, { t: 'err', msg: err }); broadcast(room); return; }
  } else return;
  update(room);
}

function onHost(ws, m) {
  const room = rooms.get(ws.code);
  if (!room || room.r.host !== ws.id) return;
  const { r } = room;
  if (m.op === 'deal') {
    if (!deal(room)) return sendTo(ws, { t: 'err', msg: '칩이 있는 참가자가 2명 이상 필요해요' });
  } else if (m.op === 'pause') r.paused = !r.paused;
  else if (m.op === 'kick') { const H = r.hand; if (H && H.toAct) E.forceFold(r, room.priv, H.toAct, '방장이 폴드 처리'); }
  else if (m.op === 'void') E.voidHand(r);
  else return;
  update(room);
}

/* ---------- websocket ---------- */
const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 16 * 1024 });
wss.on('connection', ws => {
  ws.id = null; ws.code = null; ws.alive = true;
  ws.on('pong', () => { ws.alive = true; });
  ws.on('message', buf => {
    let m; try { m = JSON.parse(buf); } catch (e) { return; }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'hello') { ws.id = clip(m.id, 40) || 'p' + crypto.randomBytes(6).toString('hex'); ws.name = clip(m.name, 10); return; }
    if (!ws.id) return;
    try {
      if (m.t === 'create') onCreate(ws, m);
      else if (m.t === 'join') onJoin(ws, m);
      else if (m.t === 'ping') sendTo(ws, { t: 'pong' });
      else if (m.t === 'leave') { if (ws.code) detach(ws, true); sendTo(ws, { t: 'left' }); }
      else if (m.t === 'act') onAct(ws, m.a);
      else if (m.t === 'host') onHost(ws, m);
      else if (m.t === 'emote') {
        const room = rooms.get(ws.code); if (!room) return;
        const now = Date.now(); if (ws.lastEmote && now - ws.lastEmote < 1200) return; ws.lastEmote = now;
        const msg = clip(m.m, 20);
        for (const s of room.socks.values()) sendTo(s, { t: 'emote', u: ws.id, m: msg });
      }
    } catch (e) { console.error('handler error', e); }
  });
  ws.on('close', () => { if (ws.code) detach(ws, false); });
});

// 끊긴 연결 정리 + 오래 빈 방 정리
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { try { ws.terminate(); } catch (e) {} continue; }
    ws.alive = false; try { ws.ping(); } catch (e) {}
  }
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (!room.socks.size && room.emptySince && now - room.emptySince > ROOM_IDLE_MS) {
      clearTimeout(room.turnT); clearTimeout(room.nextT); rooms.delete(code);
    }
  }
}, 25000);

server.listen(PORT, () => console.log(`친구끼리 홀덤 서버 실행 중: http://localhost:${PORT}`));
