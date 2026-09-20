#!/usr/bin/env node
// End-to-end regression tests for the interactive MCP/session path and the
// zero-install Node CLI.  The relay and MCP server are real local processes.

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const SERVER_BIN = path.join(ROOT, 'server', 'index.js');
const MCP_BIN = path.join(ROOT, 'mcp', 'src', 'index.js');
const CLI_BIN = path.join(ROOT, 'sdk', 'bot2bot_cli.mjs');
const TMP_ROOT = process.env.TMPDIR || path.join(ROOT, '.tmp');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function jsonrpc(id, method, params) {
  return JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
}

function extractText(result) {
  return (result?.content || []).filter((item) => item.type === 'text').map((item) => item.text).join('\n');
}

function startChild(command, args, env, label) {
  const proc = spawn(process.execPath, [command, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  proc._label = label;
  proc._stderrText = () => stderr;
  return proc;
}

async function waitForServer(proc, timeoutMs = 8_000) {
  let stdout = '';
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const chunk = await Promise.race([
      once(proc.stdout, 'data').then(([data]) => data.toString()),
      sleep(100).then(() => ''),
    ]);
    stdout += chunk;
    if (/Bot2Bot\.chat listening/.test(stdout)) return;
    if (proc.exitCode !== null) throw new Error(`relay exited early: ${proc.exitCode}`);
  }
  throw new Error(`relay start timeout: ${stdout}`);
}

function startRelay(baseDir, port) {
  const env = {
    PORT: String(port),
    HOST: '127.0.0.1',
    PUBLIC_BASE_URL: `http://127.0.0.1:${port}`,
    METRICS_STATE_PATH: path.join(baseDir, 'metrics.json'),
    METRICS_HISTORY_PATH: path.join(baseDir, 'metrics_history.json'),
    METRICS_HOURLY_HISTORY_PATH: path.join(baseDir, 'metrics_hourly.json'),
    METRICS_GEO_MINUTE_HISTORY_PATH: path.join(baseDir, 'metrics_geo_minute.json'),
    METRICS_GEO_HOURLY_HISTORY_PATH: path.join(baseDir, 'metrics_geo_hourly.json'),
    IDENTITIES_STATE_PATH: path.join(baseDir, 'identities.json'),
    AGENT_DIRECTORY_STATE_PATH: path.join(baseDir, 'agent_profiles.json'),
    ROOM_GRACE_MS: '600000',
  };
  const proc = startChild(SERVER_BIN, [], env, 'relay');
  return { proc, env };
}

function startMcp(home, base, extraEnv = {}) {
  return startChild(MCP_BIN, [], {
    HOME: home,
    BOT2BOT_BASE: base,
    BOT2BOT_MCP_ALLOWED_BASES: base,
    ...extraEnv,
  }, 'mcp');
}

async function rpc(proc, id, method, params, timeoutMs = 12_000) {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => {
      proc.stdout.off('data', onData);
      reject(new Error(`${proc._label || 'child'} rpc ${method} timed out; stderr=${proc._stderrText?.() || ''}`));
    }, timeoutMs);
    function onData(chunk) {
      buffer += chunk.toString();
      for (;;) {
        const nl = buffer.indexOf('\n');
        if (nl < 0) return;
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch (_) { continue; }
        if (message.id !== id) continue;
        clearTimeout(timer);
        proc.stdout.off('data', onData);
        if (message.error) reject(new Error(message.error.message || 'json-rpc error'));
        else resolve(message.result);
        return;
      }
    }
    proc.stdout.on('data', onData);
    proc.stdin.write(jsonrpc(id, method, params));
  });
}

async function initialize(proc, id = 1) {
  return rpc(proc, id, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'interactive-mcp-test', version: '1.0.0' },
  });
}

async function callTool(proc, id, name, args) {
  return rpc(proc, id, 'tools/call', { name, arguments: args });
}

async function stop(proc) {
  if (!proc || proc.exitCode !== null) return;
  proc.kill('SIGTERM');
  await Promise.race([once(proc, 'exit'), sleep(2_000)]);
  if (proc.exitCode === null) proc.kill('SIGKILL');
}

async function runCli(args, env) {
  const proc = spawn(process.execPath, [CLI_BIN, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  proc.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
  proc.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
  const [result] = await once(proc, 'exit');
  let json = null;
  try { json = JSON.parse(stdout.trim()); } catch (_) {}
  return { code: result, stdout, stderr, json };
}

function parseRoomUrl(text) {
  const match = String(text).match(/https?:\/\/[^\s]+#k=[A-Za-z0-9_-]+/);
  assert.ok(match, `room URL missing from MCP response: ${text}`);
  return match[0];
}

function senderFrom(text) {
  const match = String(text).match(/sent as "([^"]+)"/);
  assert.ok(match, `sender label missing: ${text}`);
  return match[1];
}

async function main() {
  const work = mkdtempSync(path.join(TMP_ROOT, 'bot2bot-interactive-'));
  const home = path.join(work, 'home');
  const homeCli = path.join(work, 'cli-home');
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const relay = startRelay(work, port);
  const mcps = new Set();
  try {
    await waitForServer(relay.proc);

    const a = startMcp(home, base);
    const b = startMcp(home, base);
    mcps.add(a); mcps.add(b);

    const init = await initialize(a);
    assert.match(init.instructions, /claim_task.*answer.*ack_task.*claim_task/i);
    assert.match(init.instructions, /never.*idle|do not.*idle/i);
    assert.match(init.instructions, /send_message.*never.*receive cursor/i);
    assert.match(init.instructions, /original local operator.*release/i);
    assert.match(init.instructions, /anonymous.*valid|anonymous.*allowed/i);

    const created = await callTool(a, 2, 'create_room', { base });
    const roomUrl = parseRoomUrl(extractText(created));

    // Two MCP processes sharing HOME must still have independent receive
    // identities and independent cursor state. Same human nickname is okay.
    const sentA = await callTool(a, 3, 'send_message', { url: roomUrl, text: 'task from A', name: 'codex' });
    const sentB = await callTool(b, 3, 'send_message', { url: roomUrl, text: 'task from B', name: 'codex' });
    const labelA = senderFrom(extractText(sentA));
    const labelB = senderFrom(extractText(sentB));
    assert.notEqual(labelA, labelB, 'same-HOME MCP processes must not collide on sender labels');

    const claimA = await callTool(a, 4, 'claim_task', { url: roomUrl, timeout_seconds: 1 });
    const claimB = await callTool(b, 4, 'claim_task', { url: roomUrl, timeout_seconds: 1 });
    const claimAText = extractText(claimA);
    const claimBText = extractText(claimB);
    assert.match(claimAText, /task from B/);
    assert.match(claimBText, /task from A/);
    const claimAFields = claimAText.match(/claim_id=([^\s]+) seq=(\d+)/);
    const claimBFields = claimBText.match(/claim_id=([^\s]+) seq=(\d+)/);
    assert.ok(claimAFields && claimBFields);

    // A send while a peer claim is inflight must not move A's receive cursor.
    const responseA = await callTool(a, 5, 'send_message', { url: roomUrl, text: 'answer from A before ACK', name: 'codex' });
    assert.match(extractText(responseA), /seq=\d+/);
    const reClaimA = await callTool(a, 6, 'claim_task', { url: roomUrl, timeout_seconds: 1 });
    assert.match(extractText(reClaimA), /task from B/);
    assert.match(extractText(reClaimA), new RegExp(`claim_id=${claimAFields[1]}\\s+seq=${claimAFields[2]}`));

    await callTool(a, 7, 'ack_task', {
      url: roomUrl,
      claim_id: claimAFields[1],
      seq: Number(claimAFields[2]),
    });
    await callTool(b, 7, 'ack_task', {
      url: roomUrl,
      claim_id: claimBFields[1],
      seq: Number(claimBFields[2]),
    });

    await callTool(b, 8, 'send_message', { url: roomUrl, text: 'task from B after ACK', name: 'codex' });
    const nextA = await callTool(a, 9, 'claim_task', { url: roomUrl, timeout_seconds: 1 });
    assert.match(extractText(nextA), /task from B after ACK/);
    const nextAFields = extractText(nextA).match(/claim_id=([^\s]+) seq=(\d+)/);
    assert.ok(nextAFields);
    await callTool(a, 10, 'ack_task', {
      url: roomUrl,
      claim_id: nextAFields[1],
      seq: Number(nextAFields[2]),
    });

    // Explicit session IDs make the local identity and cursor reconnectable.
    const stableSession = 'interactive-stable-session';
    const stableCreated = await callTool(a, 19, 'create_room', { base });
    const stableRoomUrl = parseRoomUrl(extractText(stableCreated));
    const stable1 = startMcp(home, base, { BOT2BOT_SESSION_ID: stableSession });
    mcps.add(stable1);
    await initialize(stable1, 20);
    await callTool(b, 21, 'send_message', { url: stableRoomUrl, text: 'stable peer task', name: 'peer' });
    const stableClaim1 = await callTool(stable1, 22, 'claim_task', { url: stableRoomUrl, timeout_seconds: 1 });
    const stableClaimText = extractText(stableClaim1);
    assert.match(stableClaimText, /stable peer task/);
    const stableFields = stableClaimText.match(/claim_id=([^\s]+) seq=(\d+)/);
    assert.ok(stableFields);
    await stop(stable1);
    mcps.delete(stable1);

    const stable2 = startMcp(home, base, { BOT2BOT_SESSION_ID: stableSession });
    mcps.add(stable2);
    await initialize(stable2, 23);
    const stableClaim2 = await callTool(stable2, 24, 'claim_task', { url: stableRoomUrl, timeout_seconds: 1 });
    assert.match(extractText(stableClaim2), /stable peer task/);
    assert.match(extractText(stableClaim2), new RegExp(`claim_id=${stableFields[1]}\\s+seq=${stableFields[2]}`));
    await callTool(stable2, 25, 'ack_task', {
      url: stableRoomUrl,
      claim_id: stableFields[1],
      seq: Number(stableFields[2]),
    });

    // The library import must not attach an MCP stdio transport. The CLI uses
    // the same exported handlers directly and returns structured JSON.
    const cliEnv = {
      HOME: homeCli,
      BOT2BOT_BASE: base,
      BOT2BOT_MCP_ALLOWED_BASES: base,
    };
    const cliCreated = await callTool(a, 26, 'create_room', { base });
    const cliRoomUrl = parseRoomUrl(extractText(cliCreated));
    const joined = await runCli(['join', cliRoomUrl, '--name', 'codex', '--message', 'CLI substantive kickoff'], cliEnv);
    assert.equal(joined.code, 0, joined.stderr);
    assert.ok(joined.json, `CLI join was not JSON: ${joined.stdout}`);
    assert.equal(typeof joined.json.session_id, 'string');
    assert.ok(joined.json.session_id.length > 0);
    assert.ok(Array.isArray(joined.json.transcript?.messages));
    assert.equal(joined.json.sent?.text, 'CLI substantive kickoff');
    assert.equal(typeof joined.json.sent?.sender_verified, 'boolean');
    assert.equal(typeof joined.json.next_command, 'string');
    assert.match(joined.json.next_command, /claim/);
    assert.match(joined.json.next_command, new RegExp(joined.json.session_id));
    assert.ok(!joined.stdout.includes(cliRoomUrl), 'CLI must not print the secret full room URL');

    const cliSession = joined.json.session_id;
    const cliSent = await runCli(['send', cliRoomUrl, '--session', cliSession, '--message', 'CLI followup'], cliEnv);
    assert.equal(cliSent.code, 0, cliSent.stderr);
    assert.equal(cliSent.json?.ok, true);
    assert.equal(typeof cliSent.json?.id, 'string');
    assert.equal(typeof cliSent.json?.seq, 'number');
    assert.equal(typeof cliSent.json?.sender_verified, 'boolean');
    assert.ok(!cliSent.stdout.includes(cliRoomUrl));

    await callTool(b, 30, 'send_message', { url: cliRoomUrl, text: 'CLI peer reply', name: 'peer' });
    const cliClaim = await runCli(['claim', cliRoomUrl, '--session', cliSession, '--timeout', '2'], cliEnv);
    assert.equal(cliClaim.code, 0, cliClaim.stderr);
    assert.equal(cliClaim.json?.ok, true);
    assert.equal(cliClaim.json?.message?.text, 'CLI peer reply');
    assert.equal(typeof cliClaim.json?.message?.sender_verified, 'boolean');
    assert.equal(typeof cliClaim.json?.claim_id, 'string');
    assert.equal(typeof cliClaim.json?.seq, 'number');

    const cliAck = await runCli([
      'ack', cliRoomUrl, '--session', cliSession,
      '--claim-id', cliClaim.json.claim_id,
      '--seq', String(cliClaim.json.seq),
    ], cliEnv);
    assert.equal(cliAck.code, 0, cliAck.stderr);
    assert.equal(cliAck.json?.ok, true);
    assert.equal(cliAck.json?.advanced, true);

    const cliTranscript = await runCli(['transcript', cliRoomUrl, '--session', cliSession], cliEnv);
    assert.equal(cliTranscript.code, 0, cliTranscript.stderr);
    assert.equal(typeof cliTranscript.json?.last_seq, 'number');
    assert.ok(cliTranscript.json.messages.some((message) => message.text === 'CLI substantive kickoff'));
    for (const message of cliTranscript.json.messages) {
      assert.equal(typeof message.sender_verified, 'boolean');
      assert.equal(typeof message.seq, 'number');
    }
    const cliStatus = await runCli(['status', cliRoomUrl, '--session', cliSession], cliEnv);
    assert.equal(cliStatus.code, 0, cliStatus.stderr);
    assert.equal(typeof cliStatus.json?.last_seq, 'number');
    assert.equal(typeof cliStatus.json?.participants, 'number');

    const missingSession = await runCli(['send', cliRoomUrl, '--message', 'must fail'], cliEnv);
    assert.equal(missingSession.code, 2);
    assert.equal(missingSession.json?.ok, false);
    assert.equal(missingSession.json?.code, 'missing_session');
    assert.ok(!missingSession.stdout.includes(roomUrl));
    assert.ok(!missingSession.json?.error, 'errors must use safe machine fields, not raw error keys');

    console.log('✓ interactive MCP/session + zero-install CLI checks passed');
  } finally {
    for (const proc of mcps) await stop(proc);
    await stop(relay.proc);
    rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});
