const assert = require('node:assert/strict');
const pty = require('../scratch/asar/node_modules/node-pty');
const terminal = pty.spawn('/bin/zsh', ['-f'], {name:'xterm-256color',cols:80,rows:24,cwd:process.cwd(),env:process.env});
let output = '';
const timer = setTimeout(() => { terminal.kill(); throw new Error('PTY timed out'); }, 5000);
terminal.onData(data => { output += data; });
terminal.onExit(({exitCode}) => {
  clearTimeout(timer);
  assert.equal(exitCode, 0);
  assert.match(output, /PTY_RESULT=42/);
  console.log('PTY input/output passed');
});
terminal.write("printf 'PTY_RESULT=%s\\n' $((6*7)); exit\r");
