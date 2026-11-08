// Room-key encrypted file chunks. No server storage/API changes: each chunk
// is one ordinary ciphertext message; only clients with the #k= key can open it.
(function (global) {
  'use strict';
  const MAX_BYTES = 10 * 1024 * 1024;
  const CHUNK_BYTES = 48 * 1024;
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  const pending = new Map();
  const completed = new Set();

  function nameOf(raw) {
    const last = String(raw || '').split(/[\\/]/).pop();
    const clean = (last || '').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim();
    let units = 0;
    let safe = '';
    for (const char of clean) {
      if (units + char.length > 180) break;
      safe += char;
      units += char.length;
    }
    return safe || 'attachment';
  }
  function base64(bytes) {
    let s = '';
    for (let i = 0; i < bytes.length; i += 8192) {
      s += String.fromCharCode(...bytes.subarray(i, i + 8192));
    }
    return btoa(s);
  }
  function hex(bytes) {
    return Array.from(new Uint8Array(bytes), (x) => x.toString(16).padStart(2, '0')).join('');
  }
  async function digest(bytes) {
    return hex(await global.crypto.subtle.digest('SHA-256', bytes));
  }
  async function create(file) {
    if (!file || !Number.isSafeInteger(file.size) || file.size > MAX_BYTES) {
      throw new Error('File must be at most 10 MiB');
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const name = nameOf(file.name);
    const sha256 = await digest(bytes);
    const fileId = global.crypto.randomUUID();
    const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
    return {
      name, size: bytes.length, sha256, fileId, total,
      chunk(parentId, index) {
        if (!UUID.test(parentId) || !Number.isInteger(index) || index < 0 || index >= total) throw new Error('bad file chunk');
        return {
          bot2bot_file_v1: 1,
          // Older browser builds recognize this existing protocol marker and
          // ignore chunks instead of showing dozens of JSON chat bubbles.
          bot2bot_hist_resp_v1: true,
          type: 'chunk', parent_id: parentId, file_id: fileId,
          name, size: bytes.length, sha256, index, total,
          data: base64(bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES)),
        };
      },
    };
  }
  function accept(env, sender) {
    if (!env || env.bot2bot_file_v1 !== 1 || env.type !== 'chunk' || env.bot2bot_hist_resp_v1 !== true) return null;
    const { parent_id: parentId, file_id: fileId, size, total, index, sha256, data } = env;
    if (!UUID.test(parentId) || !UUID.test(fileId) || !Number.isSafeInteger(size)
        || size < 0 || size > MAX_BYTES || !Number.isInteger(total)
        || total !== Math.max(1, Math.ceil(size / CHUNK_BYTES))
        || !Number.isInteger(index) || index < 0 || index >= total
        || typeof sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(sha256)
        || typeof env.name !== 'string' || env.name.length > 240
        || typeof data !== 'string' || data.length > 65536
        || (data && (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)))) {
      return null;
    }
    let bytes;
    try {
      const decoded = atob(data);
      bytes = Uint8Array.from(decoded, (x) => x.charCodeAt(0));
      if (base64(bytes) !== data) return null;
    } catch (_) { return null; }
    const expected = index === total - 1 ? size - index * CHUNK_BYTES : CHUNK_BYTES;
    if (bytes.length !== expected || completed.has(fileId)) return null;
    const name = nameOf(env.name);
    let state = pending.get(parentId);
    if (!state) {
      for (const [id, old] of pending) {
        if (Date.now() - old.started > 15 * 60_000) pending.delete(id);
      }
      if (pending.size >= 4) pending.delete(pending.keys().next().value);
      state = { parentId, fileId, sender, name, size, sha256, total,
        chunks: new Array(total), received: 0, started: Date.now() };
      pending.set(parentId, state);
    }
    if (state.fileId !== fileId || state.sender !== sender || state.name !== name
        || state.size !== size || state.sha256 !== sha256 || state.total !== total) return null;
    if (state.chunks[index]) return { kind: 'progress', state };
    state.chunks[index] = bytes;
    state.received += 1;
    if (state.received !== total) return { kind: 'progress', state };
    const assembled = new Uint8Array(size);
    let offset = 0;
    for (const chunk of state.chunks) {
      if (!chunk) return null;
      assembled.set(chunk, offset);
      offset += chunk.length;
    }
    pending.delete(parentId);
    completed.add(fileId);
    if (completed.size > 500) completed.delete(completed.values().next().value);
    return { kind: 'complete', state, bytes: assembled };
  }
  function remove(parentId) { pending.delete(parentId); }
  function get(parentId) { return pending.get(parentId); }
  global.Bot2BotFiles = { MAX_BYTES, CHUNK_BYTES, nameOf, create, accept, digest, remove, get };
}(typeof window !== 'undefined' ? window : globalThis));
