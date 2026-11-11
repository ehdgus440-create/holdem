'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');

const src=fs.readFileSync(path.join(__dirname,'..','public','index.html'),'utf8');
const lobbyStart=src.indexOf('function lobbyView(r){');
const lobbyEnd=src.indexOf('function topBar(r){',lobbyStart);
const eventStart=src.indexOf("document.addEventListener('click',e=>{");
const eventEnd=src.indexOf("document.addEventListener('input',e=>{",eventStart);
assert.ok(lobbyStart>0&&lobbyEnd>lobbyStart,'lobby function exists');
assert.ok(eventStart>0&&eventEnd>eventStart,'click handler exists');

function renderLobby(S){
  const helpers={
    S,
    isHost:()=>true,
    esc:v=>String(v),
    fmt:v=>String(v),
    topBar:()=>'<button data-act="menu">☰</button><button data-act="stats">📊</button>',
    colorOf:()=> '#e2c16a',
    nm:()=> '마카오',
    emoteBar:()=> '<div class="emotes">채팅</div>',
    sheet:(inner,act)=>'<div class="sheetbg" data-act="'+act+'"></div><div class="sheet">'+inner+'</div>',
    menuPanel:()=>'<h3>☰ 메뉴</h3><button data-act="menu">닫기</button>',
    statsPanel:()=>'<h3>📊 칩 현황</h3>',
    voicePanel:()=>'<h3>🎙 목소리 바꾸기</h3>'
  };
  const create=new Function(...Object.keys(helpers),src.slice(lobbyStart,lobbyEnd)+';return lobbyView;');
  const fn=create(...Object.values(helpers));
  const r={
    code:'ABCD',host:'p0',hand:null,started:false,order:['p0'],
    players:{p0:{name:'마카오',chips:100000,left:false}},
    settings:{chips:100000,sb:200,bb:400,upMin:6}
  };
  return fn(r);
}
function clickMenu(S){
  const handlers={};let calls=0;
  const document={addEventListener:(kind,fn)=>{handlers[kind]=fn}};
  const render=()=>{calls++};
  const clickSource=src.slice(eventStart,eventEnd);
  new Function('document','S','render','$',clickSource)(document,S,render,()=>null);
  assert.equal(typeof handlers.click,'function');
  const button={disabled:false,dataset:{act:'menu'}};
  handlers.click({target:{closest:query=>query==='[data-act]'?button:null}});
  assert.equal(calls,1);
}

test('lobby menu opens and closes when the top-right ☰ button is tapped',()=>{
  const S={me:'p0',err:'',practice:false,showMenu:false,showStats:false,showVoice:false};
  assert.match(renderLobby(S),/data-act="menu"/);
  assert.doesNotMatch(renderLobby(S),/class="sheetbg"/);
  clickMenu(S);
  assert.equal(S.showMenu,true);
  assert.match(renderLobby(S),/class="sheetbg" data-act="menu"/);
  assert.match(renderLobby(S),/class="sheet">[\s\S]*☰ 메뉴/);
  clickMenu(S);
  assert.equal(S.showMenu,false);
  assert.doesNotMatch(renderLobby(S),/class="sheetbg"/);
});

test('lobby can render chip stats and voice settings without an active hand',()=>{
  const S={me:'p0',err:'',practice:false,showMenu:false,showStats:true,showVoice:false};
  assert.match(renderLobby(S),/data-act="stats"/);
  assert.match(renderLobby(S),/📊 칩 현황/);
  S.showStats=false;S.showVoice=true;
  assert.match(renderLobby(S),/🎙 목소리 바꾸기/);
});
