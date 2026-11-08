// Browser-compatible encrypted attachment wire format and local file guards.
// The relay sees only ordinary room ciphertext messages, never these objects.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const CHUNK_BYTES = 48 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const DIGEST = /^[a-f0-9]{64}$/;

export function fileName(raw) {
  return (String(raw || '').split(/[\\/]/).pop() || '')
    .replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, '').trim().slice(0, 180) || 'attachment';
}
export function fileSizeLabel(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}
export function isFileChunkText(text) {
  if (!text || text.charCodeAt(0) !== 123) return false;
  try { return JSON.parse(text)?.bot2bot_file_v1 === 1; } catch (_) { return false; }
}
export function prepareFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) throw new Error('file path is required');
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile()) throw new Error('file path must be a regular file, not a symlink or directory');
  if (stat.size > MAX_FILE_BYTES) throw new Error('File too large — maximum 10 MiB');
  const bytes = fs.readFileSync(filePath);
  if (bytes.length > MAX_FILE_BYTES || bytes.length !== stat.size) throw new Error('file changed while reading or exceeds 10 MiB');
  const name = fileName(path.basename(filePath));
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const fileId = crypto.randomUUID();
  const total = Math.max(1, Math.ceil(bytes.length / CHUNK_BYTES));
  return {
    name, size: bytes.length, sha256, fileId, total,
    manifest: `📎 File: ${name} (${fileSizeLabel(bytes.length)}) [SHA-256: ${sha256}]`,
    chunk(parentId, index) {
      if (!UUID.test(parentId) || !Number.isInteger(index) || index < 0 || index >= total) throw new Error('bad file chunk');
      return {
        bot2bot_file_v1: 1, bot2bot_hist_resp_v1: true, type: 'chunk',
        parent_id: parentId, file_id: fileId, name, size: bytes.length,
        sha256, index, total,
        data: bytes.subarray(index * CHUNK_BYTES, (index + 1) * CHUNK_BYTES).toString('base64'),
      };
    },
  };
}

// All file metadata and bytes are authenticated with the room key upstream,
// but any room member can forge their own chunk messages. Enforce manifest
// sender, exact name/size and digest before returning bytes to the filesystem.
export function assembleFile(messages, manifestId) {
  if (!UUID.test(String(manifestId || ''))) throw new Error('message_id must be a UUID');
  const manifest = messages.find(m => m.id === manifestId);
  if (!manifest || typeof manifest.text !== 'string' || !manifest.text.startsWith('📎 File: ')) {
    throw new Error('file manifest not available in relay history');
  }
  let meta = null;
  let chunks;
  for (const m of messages) {
    const text = m.text;
    if (!isFileChunkText(text)) continue;
    const p = JSON.parse(text);
    if (p.parent_id !== manifestId) continue;
    const { file_id: fileId, name, size, sha256, total, index, data } = p;
    if (p.type !== 'chunk' || p.bot2bot_hist_resp_v1 !== true
        || !UUID.test(fileId) || !Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES
        || typeof name !== 'string' || name.length > 240 || fileName(name) !== name
        || !DIGEST.test(sha256) || total !== Math.max(1, Math.ceil(size / CHUNK_BYTES))
        || !Number.isInteger(index) || index < 0 || index >= total
        || typeof data !== 'string' || data.length > 65536
        || m.sender !== manifest.sender
        || Boolean(m.sender_verified) !== Boolean(manifest.sender_verified)) {
      throw new Error('file metadata or sender mismatch');
    }
    if (manifest.text !== `📎 File: ${name} (${fileSizeLabel(size)}) [SHA-256: ${sha256}]`) {
      throw new Error('file manifest SHA-256 does not match chunk metadata or is absent');
    }
    if (!meta) { meta = { fileId, name, size, sha256, total }; chunks = new Array(total); }
    if (meta.fileId !== fileId || meta.name !== name || meta.size !== size || meta.sha256 !== sha256 || meta.total !== total) {
      throw new Error('file metadata mismatch between chunks');
    }
    const decoded = Buffer.from(data, 'base64');
    const expected = index === total - 1 ? size - index * CHUNK_BYTES : CHUNK_BYTES;
    if (decoded.toString('base64') !== data || decoded.length !== expected) throw new Error('invalid file chunk encoding or size');
    if (chunks[index] && !chunks[index].equals(decoded)) throw new Error('conflicting duplicate file chunk');
    chunks[index] = decoded;
  }
  if (!meta || chunks.filter(Boolean).length !== meta.total) throw new Error('file incomplete or expired from relay history');
  const bytes = Buffer.concat(chunks, meta.size);
  if (bytes.length !== meta.size || crypto.createHash('sha256').update(bytes).digest('hex') !== meta.sha256) {
    throw new Error('file checksum mismatch');
  }
  return { ...meta, bytes, sender: manifest.sender, message_id: manifestId };
}

export function writeVerifiedFile(outputPath, bytes) {
  if (typeof outputPath !== 'string' || !outputPath.trim()) throw new Error('output_path is required');
  const dest = path.resolve(outputPath);
  const temporary = path.join(path.dirname(dest), `.${path.basename(dest)}.part-${crypto.randomUUID()}`);
  try {
    fs.writeFileSync(temporary, bytes, { flag: 'wx', mode: 0o600 });
    fs.linkSync(temporary, dest); // atomic no-overwrite, even if a concurrent writer won
  } finally {
    try { fs.unlinkSync(temporary); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  return dest;
}
