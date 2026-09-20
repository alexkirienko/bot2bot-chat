#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');
const root = path.resolve(__dirname, '..');
const read = p => fs.readFileSync(path.join(root, p), 'utf8');
const checks = [
 ['bare room exposes fast in-session discovery', () => { const s=read('public/room.html'); assert(s.includes('/join.md')); assert(s.includes('agent-quickstart')); }],
 ['canonical join instructions serve both hosts without restart', () => { const s=read('public/join.md'); assert(s.includes('Codex')&&s.includes('Claude')); assert(s.includes('current')); assert(s.includes('bot2bot.mjs join')); assert(s.includes('claim')&&s.includes('ack')); }],
 ['join contract keeps receive cursor independent of send', () => { const s=read('public/join.md'); assert(/never.*send.*seq/i.test(s)); assert(/silence.*not|empty.*not/i.test(s)); assert(/original.*operator/i.test(s)); }],
 ['invite snippets attach rather than launch', () => { const s=read('public/js/room.js'); const a=s.slice(s.indexOf('function buildCodexSnippet'),s.indexOf('function buildCursorSnippet')); assert(a.includes('buildInteractiveSnippet')); assert(!a.includes('sender_verified is true')); assert(!a.includes('launch a fresh')); assert(!a.includes('npx -y bot2bot-mcp')); }],
 ['public first-run docs no longer advertise missing npm package', () => {for(const p of ['public/connect.html','public/docs.html','public/llms.txt','public/skills/bot2bot/SKILL.md']){ const s=read(p); assert(!s.includes('npx -y bot2bot-mcp'),p); assert(!s.includes('Codex starts fresh sessions'),p); assert(!s.includes('"-y", "bot2bot-mcp"'),p); }}],
 ['connect defaults to existing session with no dependency install', () => {const s=read('public/connect.html');assert(s.includes('bot2bot.mjs'));assert(s.includes('No restart'));assert(!s.includes('--dangerously-bypass-approvals-and-sandbox'));}],
 ['downloadable bundle build exists',()=>{const p=JSON.parse(read('package.json'));assert(p.scripts['build:sdk']);assert(read('scripts/build_sdk.mjs').includes('bot2bot-mcp.mjs'));}],
 ['release builds bundles before cutover',()=>{assert(read('scripts/deploy_release.sh').includes('run build:sdk'));}],
 ['Claude native wakeups are explicit and capability-gated',()=>{const s=read('public/join.md');assert(s.includes('Monitor'));assert(s.includes('watch'));assert(s.includes('timeout_ms'));assert(s.includes('ack'));const ui=read('public/js/room.js');assert(ui.includes('native Monitor'));assert(ui.includes('watch'));}],
 ['discovery response can be Markdown',()=>{assert(read('server/index.js').includes('text/markdown'));assert(read('server/index.js').includes('/join.md'));}],
];
let failed=0;for(const [name,fn] of checks){try{fn();console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+': '+e.message);}}
console.log(JSON.stringify({total:checks.length,passed:checks.length-failed,failed}));process.exitCode=failed?1:0;
