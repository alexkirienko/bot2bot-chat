#!/usr/bin/env node
// Zero-install Bot2Bot interactive CLI. The published bundle is built from
// this file and mcp/src/index.js; the MCP transport is intentionally disabled
// so one backend implementation serves both MCP hosts and shell workflows.

import crypto from 'node:crypto';

const COMMANDS = new Set(['join', 'send', 'claim', 'watch', 'ack', 'status', 'transcript']);
const DEFAULT_CLAIM_TIMEOUT = 25;

function usageError(code, message) {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function parseArgs(argv) {
  const command = argv.shift();
  if (!COMMANDS.has(command)) usageError('usage', 'command must be join, send, claim, watch, ack, status, or transcript');
  const url = argv.shift();
  if (!url || url.startsWith('--')) usageError('usage', 'a room URL is required');
  const options = { command, url };
  const takesValue = new Set([
    '--session', '--name', '--message', '--timeout', '--claim-id', '--seq', '--after', '--limit',
  ]);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!takesValue.has(token)) usageError('usage', `unknown option for ${command}`);
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) usageError('usage', `${token} requires a value`);
    const key = token.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    options[key] = value;
  }
  if (command === 'join') {
    options.session = options.session || `session-${crypto.randomUUID()}`;
    if (!String(options.message || '').trim()) {
      usageError('missing_message', 'join requires a substantive --message kickoff');
    }
  } else if (!options.session) {
    usageError('missing_session', 'non-join commands require the literal --session returned by join');
  }
  if (command === 'ack') {
    if (!options.claimId) usageError('missing_claim_id', 'ack requires --claim-id');
    if (!options.seq || !/^\d+$/.test(String(options.seq))) usageError('missing_seq', 'ack requires numeric --seq');
  }
  if (command === 'send' && !String(options.message || '').trim()) {
    usageError('missing_message', 'send requires --message');
  }
  return options;
}

function redactedRoom(url) {
  try {
    const parsed = new URL(url);
    const match = /^\/room\/([A-Za-z0-9_-]{4,64})\/?$/.exec(parsed.pathname);
    if (!match) return '[room-url]';
    return `${parsed.origin}/room/${match[1]}#k=[redacted]`;
  } catch (_) {
    return '[room-url]';
  }
}

function roomSafeFields(parsed) {
  return {
    base: parsed.base,
    room_id: parsed.roomId,
    url: redactedRoom(parsed.url),
  };
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function nextCommand(parsed, session) {
  return `node bot2bot.mjs claim '<room URL supplied to join>' --session ${shellQuote(session)} --timeout ${DEFAULT_CLAIM_TIMEOUT}`;
}

function safeMessage(error) {
  let message = String(error?.message || error || 'operation failed');
  message = message.replace(/https?:\/\/[^\s'"`]+/gi, '[room-url]');
  message = message.replace(/(?:#k=|key=|secret=|token=|password=)[^\s,;]+/gi, '[redacted]');
  message = message.replace(/\b(?:ciphertext|nonce|sender_sig|register_sig)\b[^\s,;]*/gi, '[redacted]');
  return message.slice(0, 500);
}

function emit(value, code = 0) {
  process.stdout.write(JSON.stringify(value) + '\n', () => {
    // Fatal watch errors must close the presence transport too, allowing
    // the native host monitor to notify/re-arm instead of silently hanging.
    if (code === 2) process.exit(code);
  });
  process.exitCode = code;
}

async function loadBackend(session, name, watch = false) {
  // This assignment must happen before the dynamic import. mcp/src/index.js
  // derives its process/session namespace during module initialization.
  Object.assign(process.env, { BOT2BOT_MCP_LIBRARY: '1' });
  if (watch) process.env.BOT2BOT_MCP_PRESENCE = '1';
  process.env.BOT2BOT_SESSION_ID = String(session);
  if (name) process.env.BOT2BOT_MCP_ROOM_NAME = String(name);
  const backend = await import('../mcp/src/index.js');
  return backend;
}

function rawHandler(backend, name) {
  const handler = backend.RAW_HANDLERS?.[name];
  if (typeof handler !== 'function') usageError('backend', `raw handler unavailable: ${name}`);
  return handler;
}

async function run(options) {
  const backend = await loadBackend(options.session, options.name, options.command === 'watch');
  const parsed = backend.parseRoomUrl(options.url);
  const room = roomSafeFields(parsed);
  const common = { ok: true, command: options.command, session_id: options.session, room };

  if (options.command === 'join') {
    // Transcript is deliberately bounded and immediate: joining must not wait
    // for a peer message before publishing the substantive handoff.
    const transcript = await rawHandler(backend, 'get_transcript')({
      url: options.url,
      after_seq: 0,
      limit: 100,
    });
    const sent = await rawHandler(backend, 'send_message')({
      url: options.url,
      text: options.message,
      name: options.name,
    });
    return {
      ...common,
      sender: sent.sender,
      sender_verified: Boolean(sent.sender_verified),
      transcript,
      sent,
      next_command: nextCommand(parsed, options.session),
      session_restore: `Reuse --session ${shellQuote(options.session)} on every later command; without it a new receive identity is created.`,
    };
  }

  if (options.command === 'send') {
    const sent = await rawHandler(backend, 'send_message')({
      url: options.url,
      text: options.message,
      name: options.name,
    });
    return { ...common, ...sent, sender_verified: Boolean(sent.sender_verified) };
  }

  if (options.command === 'watch') {
    // Feed the host's native event monitor, not a detached LLM. Keep the
    // at-least-once claim pending until the host explicitly ACKs it.
    let emittedClaim = '';
    while (true) {
      const claim = await rawHandler(backend, 'claim_task')({
        url: options.url,
        timeout_seconds: Math.max(1, Math.min(90, Number(options.timeout) || 60)),
      });
      if (!claim.empty && claim.message) {
        if (claim.claim_id !== emittedClaim) {
          emit({ ...common, empty: false, claim_id: claim.claim_id,
            seq: Number(claim.message.seq), cursor: Number(claim.cursor || 0),
            message: { ...claim.message, sender_verified: Boolean(claim.message.sender_verified) } });
          emittedClaim = claim.claim_id;
        }
        // No duplicate event flood while the host is reasoning/answering.
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
  }

  if (options.command === 'claim') {
    const claim = await rawHandler(backend, 'claim_task')({
      url: options.url,
      timeout_seconds: Math.max(1, Math.min(90, Number(options.timeout) || DEFAULT_CLAIM_TIMEOUT)),
    });
    if (claim.empty || !claim.message) {
      return {
        ...common,
        empty: true,
        cursor: Number(claim.cursor || 0),
        last_seq: Number(claim.last_seq || 0),
        message: null,
      };
    }
    return {
      ...common,
      empty: false,
      claim_id: claim.claim_id,
      cursor: Number(claim.cursor || 0),
      last_seq: Number(claim.last_seq || 0),
      seq: Number(claim.message.seq || 0),
      message: {
        ...claim.message,
        sender_verified: Boolean(claim.message.sender_verified),
      },
    };
  }

  if (options.command === 'ack') {
    const ack = await rawHandler(backend, 'ack_task')({
      url: options.url,
      claim_id: options.claimId,
      seq: Number(options.seq),
    });
    return { ...common, ...ack, seq: Number(options.seq) };
  }

  if (options.command === 'status') {
    const status = await rawHandler(backend, 'room_status')({ url: options.url });
    return { ...common, ...status };
  }

  const transcript = await rawHandler(backend, 'get_transcript')({
    url: options.url,
    after_seq: Number(options.after || 0),
    limit: Math.max(1, Math.min(500, Number(options.limit) || 100)),
  });
  transcript.messages = (transcript.messages || []).map((message) => ({
    ...message,
    sender_verified: Boolean(message.sender_verified),
  }));
  return { ...common, ...transcript };
}

async function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const result = await run(options);
    emit(result, result.empty ? 1 : 0);
  } catch (error) {
    emit({
      ok: false,
      code: error?.code || 'operation_failed',
      message: safeMessage(error),
    }, 2);
  }
}

main();
