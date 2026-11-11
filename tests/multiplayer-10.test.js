'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {spawn}=require('node:child_process');
const net=require('node:net');
const WebSocket=require('ws');

const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function freePort(){
  const probe=net.createServer();
  await new Promise((resolve,reject)=>{probe.once('error',reject);probe.listen(0,'127.0.0.1',resolve)});
  const port=probe.address().port;
  await new Promise(resolve=>probe.close(resolve));
  return port;
}
function connect(port,id){
  return new Promise((resolve,reject)=>{
    const ws=new WebSocket('ws://127.0.0.1:'+port+'/ws');
    const client={id,ws,messages:[],send(msg){ws.send(JSON.stringify(msg))}};
    ws.on('message',raw=>{
      try{client.messages.push(JSON.parse(raw.toString('utf8')))}
      catch(e){reject(e)}
    });
    ws.once('error',reject);
    ws.once('open',()=>{
      client.send({t:'hello',id,name:id});
      resolve(client);
    });
  });
}
async function waitFor(client,pred,from=0,timeout=9000){
  const until=Date.now()+timeout;
  while(Date.now()<until){
    const msg=client.messages.slice(from).find(pred);
    if(msg)return msg;
    await sleep(12);
  }
  throw new Error('Message timeout for '+client.id+': '+JSON.stringify(client.messages.slice(-1)[0]));
}
const isState=m=>m.t==='state'&&m.room&&m.room.code;

test('10 independent WebSocket clients join, bet, show cards and auto-start the next hand', {timeout:30000},async()=>{
  const port=await freePort();
  let stderr='';
  const child=spawn(process.execPath,['server.js'],{
    cwd:process.cwd(),
    env:{...process.env,PORT:String(port)},
    stdio:['ignore','pipe','pipe']
  });
  child.stderr.on('data',buf=>{stderr+=buf.toString('utf8')});
  const connected=[];
  try{
    let healthy=false;
    for(let i=0;i<100;i++){
      if(child.exitCode!==null)throw new Error('Server exited: '+stderr);
      try{
        const response=await fetch('http://127.0.0.1:'+port+'/healthz');
        if(response.ok){healthy=true;break}
      }catch(e){}
      await sleep(50);
    }
    assert.ok(healthy,'Server /healthz must respond: '+stderr);
    const clients=await Promise.all(Array.from({length:10},(_,i)=>connect(port,'user'+i)));
    connected.push(...clients);
    const byId=new Map(clients.map(c=>[c.id,c]));
    const host=clients[0];
    host.send({t:'create',name:'user0',settings:{chips:100000,rebuy:1}});
    const created=await waitFor(host,m=>isState(m)&&m.created);
    const code=created.room.code;
    assert.match(code,/^[A-Z]{4}$/);
    // Send all nine joins at once to exercise burst connection handling.
    clients.slice(1).forEach((c,i)=>c.send({t:'join',code,name:'user'+(i+1)}));
    const joined=await waitFor(host,m=>isState(m)&&m.room.order.length===10);
    assert.equal(new Set(joined.room.order).size,10);
    await Promise.all(clients.map(c=>waitFor(c,m=>isState(m)&&m.room.order.length===10)));
    const extra=await connect(port,'user10');
    connected.push(extra);
    extra.send({t:'join',code,name:'user10'});
    const denied=await waitFor(extra,m=>m.t==='err');
    assert.match(denied.msg,/최대 10명/);
    host.send({t:'host',op:'deal'});
    const initial=await waitFor(host,m=>isState(m)&&m.room.hand&&m.room.hand.n===1);
    const dealt=await Promise.all(clients.map(c=>waitFor(c,m=>isState(m)&&m.room.hand&&m.room.hand.n===1&&m.my&&m.my.cards&&m.my.cards.length===2)));
    const allCards=dealt.flatMap(m=>m.my.cards);
    assert.equal(allCards.length,20);
    assert.equal(new Set(allCards).size,20);
    for(const state of dealt){
      assert.equal(Object.keys(state.room.hand.shown).length,0,'private cards must stay hidden');
      const publicState=JSON.stringify(state.room);
      for(const card of allCards)assert.equal(publicState.includes('"'+card+'"'),false,'private card leaked: '+card);
    }
    let state=initial,steps=0;
    while(state.room.hand.street!=='done'&&steps<100){
      const hand=state.room.hand;
      const actor=byId.get(hand.toAct);
      assert.ok(actor,'current actor must be a joined player');
      const ps=hand.ps[hand.toAct];
      const type=ps.bet<hand.curBet?'call':'check';
      const from=host.messages.length;
      actor.send({t:'act',a:{type,n:hand.n}});
      state=await waitFor(host,m=>isState(m)&&m.room.hand&&m.room.hand.n===1,from);
      steps++;
    }
    assert.ok(steps>=36&&steps<=50,'all ten players should act across all streets');
    assert.equal(state.room.hand.street,'done');
    assert.equal(Object.keys(state.room.hand.shown).length,10);
    assert.equal(Object.values(state.room.players).reduce((n,p)=>n+p.chips,0),1000000);
    await Promise.all(clients.map(c=>waitFor(c,m=>isState(m)&&m.room.hand&&m.room.hand.street==='done')));
    const next=await waitFor(host,m=>isState(m)&&m.room.hand&&m.room.hand.n===2,host.messages.length,12000);
    assert.equal(next.room.hand.n,2);
    const old=clients[9],lastId=old.id;
    const from=host.messages.length;
    old.ws.close();
    await waitFor(host,m=>isState(m)&&m.room.players[lastId].off===true,from);
    const fresh=await connect(port,lastId);
    connected.push(fresh);
    fresh.send({t:'join',code,name:lastId});
    const recovered=await waitFor(fresh,m=>isState(m)&&m.room.order.length===10);
    assert.equal(recovered.room.order.filter(id=>id===lastId).length,1);
    assert.equal(recovered.room.players[lastId].off,false);
    assert.equal(recovered.my.cards.length,2);
    const hFrom=clients[1].messages.length;
    host.ws.close();
    const moved=await waitFor(clients[1],m=>isState(m)&&m.room.host==='user1',hFrom);
    assert.equal(moved.room.order.length,10);
  }finally{
    for(const c of connected)try{c.ws.terminate()}catch(e){}
    child.kill('SIGTERM');
    await sleep(60);
    if(child.exitCode===null)child.kill('SIGKILL');
  }
});
