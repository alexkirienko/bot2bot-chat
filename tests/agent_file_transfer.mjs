// Bot attachment contract: MCP/CLI -> browser, browser -> MCP, tamper refusal.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { File } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import nacl from 'tweetnacl';

const BASE = process.env.BOT2BOT_BASE || 'http://127.0.0.1:3123';
const root = path.resolve(import.meta.dirname, '..');
const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'bot2bot-agent-file-'));
process.env.HOME = dir;
process.env.BOT2BOT_BASE = BASE;
process.env.BOT2BOT_MCP_LIBRARY = '1';
process.env.BOT2BOT_SESSION_ID = 'file-qa-' + crypto.randomUUID();
process.env.BOT2BOT_MCP_HANDLE = 'file-qa-' + crypto.randomBytes(3).toString('hex');
const backend = await import('../mcp/src/index.js');
const roomId = 'AF' + crypto.randomBytes(7).toString('hex');
const key = crypto.randomBytes(32);
const url = `${BASE}/room/${roomId}#k=${key.toString('base64url')}`;
const input = path.join(dir, 'random-ä-safe.bin');
const bytes = crypto.randomBytes(120123);
fs.writeFileSync(input, bytes);

function browserProtocol() {
  const ctx = { crypto: crypto.webcrypto, Uint8Array, Blob, btoa, atob, Date, Math, String, Array, Map, Set };
  ctx.window = ctx;
  // Byte-for-byte snapshot of the already-deployed browser protocol in PR #7.
  vm.runInNewContext(fs.readFileSync(path.join(root, 'tests/fixtures/browser-file-transfer.v1.js'), 'utf8'), ctx);
  return ctx.Bot2BotFiles;
}
async function post(text, sender = 'browser-qa') {
  const nonce = crypto.randomBytes(24);
  const ciphertext = nacl.secretbox(new TextEncoder().encode(text), nonce, key);
  const res = await fetch(`${BASE}/api/rooms/${roomId}/messages`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sender, nonce: nonce.toString('base64'), ciphertext: Buffer.from(ciphertext).toString('base64') }),
  });
  assert.equal(res.status, 200, `relay rejected test message ${res.status}`);
  return res.json();
}
function decode(m) {
  const plain = nacl.secretbox.open(Buffer.from(m.ciphertext, 'base64'), Buffer.from(m.nonce, 'base64'), key);
  assert.ok(plain, 'room message authentication failed');
  return Buffer.from(plain).toString('utf8');
}
try {
  const instructions = fs.readFileSync(path.join(root, 'public/join.md'), 'utf8');
  assert.match(instructions, /send-file/);
  assert.match(instructions, /download-file/);
  assert.match(instructions, /send_file/);
  assert.match(instructions, /download_file/);
  assert.match(instructions, /10 MiB/);
  // The new feature must be discoverable to an MCP host, not only the web UI.
  assert.equal(typeof backend.RAW_HANDLERS.send_file, 'function', 'send_file raw handler is absent');
  assert.equal(typeof backend.RAW_HANDLERS.download_file, 'function', 'download_file raw handler is absent');
  assert.equal(typeof backend.TOOL_HANDLERS.send_file, 'function', 'send_file MCP tool is absent');
  assert.equal(typeof backend.TOOL_HANDLERS.download_file, 'function', 'download_file MCP tool is absent');
  const sent = await backend.RAW_HANDLERS.send_file({ url, path: input, name: 'file-qa' });
  assert.match(sent.id, /^[a-f0-9-]{36}$/i);
  assert.equal(sent.size, bytes.length);
  assert.equal(sent.total, 3);
  const transcript = await backend.RAW_HANDLERS.get_transcript({ url, limit: 30 });
  const manifest = transcript.messages.find(m => m.id === sent.id);
  assert.ok(manifest?.text.startsWith('📎 File: random-ä-safe.bin ('));
  const chunks = transcript.messages.filter(m => m.text?.startsWith('{') && m.text.includes('"bot2bot_file_v1":1'));
  assert.equal(chunks.length, 3);
  let result;
  const browser = browserProtocol();
  for (const m of chunks) result = browser.accept(JSON.parse(m.text), m.sender);
  assert.equal(result?.kind, 'complete', 'browser did not reassemble bot file');
  assert.deepEqual(Buffer.from(result.bytes), bytes);
  assert.equal(await browser.digest(result.bytes), sent.sha256);
  const exposed = await backend.TOOL_HANDLERS.get_transcript({ url, limit: 30 });
  assert.doesNotMatch(exposed.content[0].text, /bot2bot_file_v1|"data":"/,
    'MCP transcript leaked chunk JSON to LLM context');
  assert.ok(exposed.structuredContent.messages.every(m => !m.text?.includes('"bot2bot_file_v1":1')));

  // Browser wire format is consumed by a bot and saved as verified bytes.
  const incoming = crypto.randomBytes(100321);
  const packed = await browser.create(new File([incoming], 'browser-to-bot.bin'));
  const parent = await post(`📎 File: ${packed.name} (${(packed.size / 1024).toFixed(1)} KiB) [SHA-256: ${packed.sha256}]`);
  for (let i = 0; i < packed.total; i++) await post(JSON.stringify(packed.chunk(parent.id, i)));
  const destination = path.join(dir, 'received.bin');
  const received = await backend.RAW_HANDLERS.download_file({ url, message_id: parent.id, output_path: destination });
  assert.equal(received.size, incoming.length);
  assert.deepEqual(fs.readFileSync(destination), incoming);
  await assert.rejects(() => backend.RAW_HANDLERS.download_file({ url, message_id: parent.id, output_path: destination }), /exist|overwrite/i);
  assert.deepEqual(fs.readFileSync(destination), incoming, 'existing output must not be overwritten');

  const claim = await backend.RAW_HANDLERS.claim_task({ url, timeout_seconds: 1 });
  assert.equal(claim.message?.id, parent.id, 'claim should expose the browser file manifest');
  await backend.RAW_HANDLERS.ack_task({ url, claim_id: claim.claim_id, seq: claim.message.seq });
  const next = await backend.RAW_HANDLERS.claim_task({ url, timeout_seconds: 1 });
  assert.equal(next.empty, true, 'claim should skip/ack all file chunks without exposing them');

  // Forged digest must never produce even a partial destination file.
  const wrong = await post(`📎 File: corrupt.bin (4 B) [SHA-256: ${'0'.repeat(64)}]`);
  await post(JSON.stringify({ bot2bot_file_v1: 1, bot2bot_hist_resp_v1: true, type: 'chunk',
    parent_id: wrong.id, file_id: crypto.randomUUID(), name: 'corrupt.bin', size: 4, total: 1,
    index: 0, sha256: '0'.repeat(64), data: Buffer.from('test').toString('base64') }));
  const bad = path.join(dir, 'bad.bin');
  await assert.rejects(() => backend.RAW_HANDLERS.download_file({ url, message_id: wrong.id, output_path: bad }), /checksum|digest/i);
  assert.equal(fs.existsSync(bad), false);

  // In an unsigned room, a peer can copy the sender label and invent both
  // bytes and a self-consistent chunk digest. Without a digest in the
  // manifest the download cannot know what the real sender announced.
  const unbound = await post('📎 File: unbound.bin (4 B)', 'browser-qa');
  const attackerBytes = Buffer.from('evil');
  await post(JSON.stringify({ bot2bot_file_v1: 1, bot2bot_hist_resp_v1: true, type: 'chunk',
    parent_id: unbound.id, file_id: crypto.randomUUID(), name: 'unbound.bin', size: 4, total: 1,
    index: 0, sha256: crypto.createHash('sha256').update(attackerBytes).digest('hex'),
    data: attackerBytes.toString('base64') }), 'browser-qa');
  const unsafe = path.join(dir, 'unbound-received.bin');
  await assert.rejects(() => backend.RAW_HANDLERS.download_file({ url, message_id: unbound.id, output_path: unsafe }), /manifest|unbound|SHA-256/i);
  assert.equal(fs.existsSync(unsafe), false);

  const half = await post(`📎 File: absent.bin (48.0 KiB) [SHA-256: ${'0'.repeat(64)}]`);
  await post(JSON.stringify({ bot2bot_file_v1: 1, bot2bot_hist_resp_v1: true, type: 'chunk',
    parent_id: half.id, file_id: crypto.randomUUID(), name: 'absent.bin', size: 49153, total: 2,
    index: 0, sha256: '0'.repeat(64), data: Buffer.alloc(49152).toString('base64') }));
  const missing = path.join(dir, 'missing.bin');
  await assert.rejects(() => backend.RAW_HANDLERS.download_file({ url, message_id: half.id, output_path: missing }), /incomplete/i);
  assert.equal(fs.existsSync(missing), false);

  const tooBig = path.join(dir, 'oversize.bin');
  fs.writeFileSync(tooBig, Buffer.alloc(10 * 1024 * 1024 + 1));
  const before = await (await fetch(`${BASE}/api/rooms/${roomId}/status`)).json();
  await assert.rejects(() => backend.RAW_HANDLERS.send_file({ url, path: tooBig }), /10 MiB/);
  const after = await (await fetch(`${BASE}/api/rooms/${roomId}/status`)).json();
  assert.equal(after.last_seq, before.last_seq, 'oversize sent any ciphertext');

  const empty = path.join(dir, 'empty.bin');
  fs.writeFileSync(empty, Buffer.alloc(0));
  const emptySent = await backend.RAW_HANDLERS.send_file({ url, path: empty });
  assert.equal(emptySent.total, 1);
  const emptyDest = path.join(dir, 'empty-received.bin');
  assert.equal((await backend.RAW_HANDLERS.download_file({ url, message_id: emptySent.id, output_path: emptyDest })).size, 0);
  assert.equal(fs.statSync(emptyDest).size, 0);

  if (process.env.BOT2BOT_MAX_QA === '1') {
    const maximum = path.join(dir, 'maximum.bin');
    const maxBytes = crypto.randomBytes(10 * 1024 * 1024);
    fs.writeFileSync(maximum, maxBytes);
    const maxSent = await backend.RAW_HANDLERS.send_file({ url, path: maximum });
    assert.equal(maxSent.total, 214);
    const maxDest = path.join(dir, 'maximum-received.bin');
    await backend.RAW_HANDLERS.download_file({ url, message_id: maxSent.id, output_path: maxDest });
    assert.deepEqual(fs.readFileSync(maxDest), maxBytes);
    console.log('PASS bot exact 10 MiB boundary, 214 encrypted chunks');
  }

  // Cross-language interoperability on a real relay, not just duplicated
  // fixtures: Python -> Node and Node -> Python use the same #k= room key.
  const pythonEnv = { ...process.env, PYTHONPATH: path.join(root, 'sdk') };
  const pySend = spawnSync('python3', ['-c',
    'import sys; from bot2bot import Room; r=Room(sys.argv[1], name="python-file-qa"); print(r.send_file(sys.argv[2])); r.close()',
    url, input], { cwd: root, encoding: 'utf8', env: pythonEnv, timeout: 30000 });
  assert.equal(pySend.status, 0, `Python send_file failed: ${pySend.stderr}`);
  const pyManifestId = pySend.stdout.trim();
  assert.match(pyManifestId, /^[a-f0-9-]{36}$/i);
  const fromPython = path.join(dir, 'from-python.bin');
  await backend.RAW_HANDLERS.download_file({ url, message_id: pyManifestId, output_path: fromPython });
  assert.deepEqual(fs.readFileSync(fromPython), bytes);

  const nodeForPython = await backend.RAW_HANDLERS.send_file({ url, path: input });
  const fromNode = path.join(dir, 'from-node.bin');
  const pyDownload = spawnSync('python3', ['-c',
    'import sys; from bot2bot import Room; r=Room(sys.argv[1], name="python-file-qa"); print(r.download_file(sys.argv[2], sys.argv[3])); r.close()',
    url, nodeForPython.id, fromNode], { cwd: root, encoding: 'utf8', env: pythonEnv, timeout: 30000 });
  assert.equal(pyDownload.status, 0, `Python download_file failed: ${pyDownload.stderr}`);
  assert.deepEqual(fs.readFileSync(fromNode), bytes);

  // 120 transport chunks must not hide a later human/bot message from a
  // newly joining agent with a 50-visible-message transcript window.
  for (let i = 0; i < 120; i++) await post(JSON.stringify({ bot2bot_file_v1: 1,
    bot2bot_hist_resp_v1: true, type: 'chunk', index: i }));
  const latest = await post('latest human followup after a file', 'browser-qa');
  const visible = await backend.TOOL_HANDLERS.get_transcript({ url, limit: 50 });
  assert.ok(visible.structuredContent.messages.some(m => m.id === latest.id),
    'MCP transcript should show messages after a large attachment');

  const cliJoin = spawnSync(process.execPath, ['public/sdk/bot2bot.mjs', 'join', url,
    '--session', 'file-qa-onboarding', '--name', 'file-qa-onboarding', '--message', 'real task handoff'], {
    cwd: root, encoding: 'utf8', timeout: 30000, env: process.env,
  });
  assert.equal(cliJoin.status, 0, `CLI join failed: ${cliJoin.stderr}`);
  assert.ok(JSON.parse(cliJoin.stdout).transcript.messages.some(m => m.id === latest.id),
    'CLI join must show the latest message after attachment chunks');

  // Zero-install command should expose the same behavior as the MCP tool.
  const cli = spawnSync(process.execPath, ['public/sdk/bot2bot.mjs', 'send-file', url,
    '--session', 'file-qa-cli', '--path', input], {
    cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, BOT2BOT_MCP_HANDLE: 'file-cli-' + crypto.randomBytes(3).toString('hex') },
  });
  assert.equal(cli.status, 0, `send-file CLI failed: ${cli.stderr} ${cli.stdout.slice(0, 400)}`);
  const cliSent = JSON.parse(cli.stdout);
  assert.equal(cliSent.ok, true);
  const cliOut = path.join(dir, 'cli-received.bin');
  const cliDownload = spawnSync(process.execPath, ['public/sdk/bot2bot.mjs', 'download-file', url,
    '--session', 'file-qa-cli', '--message-id', parent.id, '--out', cliOut], {
    cwd: root, encoding: 'utf8', timeout: 30000, env: process.env,
  });
  assert.equal(cliDownload.status, 0, `download-file CLI failed: ${cliDownload.stderr} ${cliDownload.stdout.slice(0, 400)}`);
  assert.deepEqual(fs.readFileSync(cliOut), incoming);
  console.log('PASS bot file tools/CLI: browser interoperability, digest, limits, no overwrite and no chunk spam');
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
