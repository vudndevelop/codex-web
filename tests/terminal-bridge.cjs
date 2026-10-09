const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const net = require('node:net');
const {execFileSync} = require('node:child_process');
const {setTimeout: delay} = require('node:timers/promises');
const pty = require('../scratch/asar/node_modules/node-pty');
const {terminalRequest, startTerminalBridge} = require('../src/server/terminal-bridge.js');
(async () => {
  const terminal = pty.spawn('/bin/zsh', ['-f'], {name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:process.env});
  const session = {id:'test-pane', conversationId:'test-thread', cwd:process.cwd(), shell:'zsh', attached:true, buffer:'', owner:{isDestroyed:()=>false}, backend:{write:async text => terminal.write(text)}};
  terminal.onData(data => { session.buffer += data; });
  const manager = {sessions:new Map([[session.id,session]])};
  const request = {threadId:'test-thread', workspace:process.cwd(), sessionId:'test-pane'};
  let bridge;
  try {
    assert.equal((await terminalRequest(manager, {...request,operation:'list'})).length,1);
    assert.equal((await terminalRequest([{sessions:new Map()},manager], {...request,operation:'list'})).length,1);
    await assert.rejects(terminalRequest([manager,{sessions:new Map([[session.id,{...session}]])}], {...request,operation:'write',text:'bad'}),/Ambiguous/);
    for (const invalid of [{threadId:'wrong'}, {sessionId:'wrong'}, {workspace:'/tmp'}]) {
      await assert.rejects(terminalRequest(manager,{...request,...invalid,operation:'write',text:'echo bad\n'}));
    }
    session.hostId='remote';
    assert.deepEqual(await terminalRequest(manager,{...request,operation:'list'}),[]);
    session.hostId=null;
    session.attached=false;
    await assert.rejects(terminalRequest(manager,{...request,operation:'read'}));
    session.attached=true;
    await assert.rejects(terminalRequest(manager,{...request,operation:'write',text:'x'.repeat(8193)}));
    await terminalRequest(manager,{...request,operation:'write',text:"printf 'BRIDGE_RESULT=%s\\n' $((6*7))\r"});
    for(let i=0;i<100&&!session.buffer.includes('BRIDGE_RESULT=42');i++) await delay(20);
    assert.match((await terminalRequest(manager,{...request,operation:'read'})).output,/BRIDGE_RESULT=42/);
    await terminalRequest(manager,{...request,operation:'write',text:'sleep 30\r'});
    await delay(100);
    await terminalRequest(manager,{...request,operation:'interrupt'});
    await terminalRequest(manager,{...request,operation:'write',text:"printf 'BRIDGE_INTERRUPT=%s\\n' yes\r"});
    for(let i=0;i<100&&!session.buffer.includes('BRIDGE_INTERRUPT=yes');i++) await delay(20);
    assert.match(session.buffer,/BRIDGE_INTERRUPT=yes/);
    const backend=session.backend;
    session.backend={write:async()=>{throw new Error('backend broke')}};
    await assert.rejects(terminalRequest(manager,{...request,operation:'write',text:'bad'}),/backend broke/);
    session.backend=backend;
    bridge = await startTerminalBridge(40000+Math.floor(Math.random()*20000),()=>manager);
    assert.equal((await fs.stat(bridge.socketPath)).mode&0o777,0o600);
    const port=Number(bridge.socketPath.match(/web-(\d+)\.sock$/)[1]);
    await assert.rejects(startTerminalBridge(port,()=>manager),/already running/);
    const stalePort=port===59999?59998:port+1;
    const stalePath=bridge.socketPath.replace(`web-${port}.sock`,`web-${stalePort}.sock`);
    execFileSync('python3',['-c','import socket,sys;s=socket.socket(socket.AF_UNIX);s.bind(sys.argv[1]);s.close()',stalePath]);
    const recovered=await startTerminalBridge(stalePort,()=>manager);
    recovered.stop();
    const response=await new Promise((resolve,reject)=>{
      const connection=net.createConnection(bridge.socketPath);
      let data='';connection.on('error',reject);
      connection.on('connect',()=>connection.write(JSON.stringify({...request,operation:'read'})+'\n'));
      connection.on('data',chunk=>{data+=chunk});
      connection.on('end',()=>resolve(JSON.parse(data)));
    });
    assert.equal(response.ok,true);
    assert.match(response.result.output,/BRIDGE_RESULT=42/);
    console.log('Web PTY, isolation, Ctrl+C, backend errors and private socket passed');
  } finally {
    terminal.kill();
    bridge?.stop();
  }
})().catch(error=>{console.error(error);process.exitCode=1});
