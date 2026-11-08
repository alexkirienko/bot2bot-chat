// End-to-end binary attachment tests: encrypted relay, late join, IDB replay.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const nacl = require('tweetnacl');
const BASE = process.env.BOT2BOT_BASE || 'http://127.0.0.1:3100';

function fileMessages(messages, key) {
  const roomKey = Buffer.from(key, 'base64url');
  return messages.map((m) => {
    const bytes = nacl.secretbox.open(Buffer.from(m.ciphertext, 'base64'), Buffer.from(m.nonce, 'base64'), roomKey);
    assert.ok(bytes, 'room message failed authenticated decryption');
    const text = Buffer.from(bytes).toString('utf8');
    try { const obj = JSON.parse(text); return obj.bot2bot_file_v1 === 1 ? obj : text; }
    catch (_) { return text; }
  }).filter((item) => (typeof item === 'string' && item.startsWith('📎 File: ')) || (typeof item === 'object' && item.bot2bot_file_v1 === 1));
}

async function downloadedBytes(page, card) {
  const promised = page.waitForEvent('download');
  await card.locator('.bubble__file-download').click();
  const dl = await promised;
  return { name: dl.suggestedFilename(), data: fs.readFileSync(await dl.path()) };
}
async function main() {
  const browser = await chromium.launch({ executablePath: process.env.BOT2BOT_CHROMIUM_PATH || undefined });
  const contexts = [];
  try {
    const roomId = 'FILE' + crypto.randomBytes(6).toString('hex');
    const key = crypto.randomBytes(32).toString('base64url');
    const roomUrl = `${BASE}/room/${roomId}#k=${key}`;
    async function openRoom(viewport) {
      const ctx = await browser.newContext({ acceptDownloads: true, viewport });
      contexts.push(ctx);
      const page = await ctx.newPage();
      await page.goto(roomUrl, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.Bot2BotFiles && !!window.__bot2botTest);
      return page;
    }
    const sender = await openRoom({ width: 1280, height: 850 });
    const receiver = await openRoom({ width: 1280, height: 850 });
    assert.equal(await receiver.evaluate(async () => new Promise((resolve, reject) => {
      const req = indexedDB.open('bot2bot-chat', 1);
      req.onsuccess = () => { resolve(req.result.version); req.result.close(); };
      req.onerror = () => reject(req.error);
    })), 1, 'existing history database must not be upgraded while older tabs are open');
    const bytes = crypto.randomBytes(150321); // non-text bytes across four chunks
    const filename = 'random-ä-safe.bin';
    await sender.locator('#file-input').setInputFiles({ name: filename, mimeType: 'application/octet-stream', buffer: bytes });
    await sender.locator('#attach-btn:not([disabled])').waitFor({ timeout: 20000 });
    const card = receiver.locator('.bubble').filter({ has: receiver.locator('.bubble__file-name', { hasText: filename }) });
    await card.locator('.bubble__file-download:not([disabled])').waitFor({ timeout: 20000 });
    assert.equal(await card.locator('.bubble__file img').count(), 0, 'filename must remain plain text');
    let dl = await downloadedBytes(receiver, card);
    assert.equal(dl.name, filename);
    assert.deepEqual(dl.data, bytes, 'received binary bytes differ');
    const messageId = await card.getAttribute('data-msg-id');
    const seq = Number(await card.getAttribute('data-msg-seq'));
    assert.equal(await receiver.evaluate(async (id) => !!(await window.Bot2BotHistory.loadAttachment(location.pathname.split('/').pop(), id)), messageId), true);
    const transcript = await (await fetch(`${BASE}/api/rooms/${roomId}/transcript?after=0&limit=20`)).json();
    const payloads = fileMessages(transcript.messages, key);
    assert.equal(payloads.length, 5, 'one manifest + four encrypted chunks expected');
    assert.equal(payloads[0], `📎 File: ${filename} (146.8 KiB) [SHA-256: ${crypto.createHash('sha256').update(bytes).digest('hex')}]`);
    assert.deepEqual(payloads.slice(1).map((p) => p.index), [0, 1, 2, 3]);
    assert.ok(transcript.messages.every((m) => !JSON.stringify(m).includes(filename) && !('data' in m)),
      'relay must not receive plaintext filename or file data');

    await receiver.reload({ waitUntil: 'domcontentloaded' });
    const cached = receiver.locator(`.bubble[data-msg-id="${messageId}"]`);
    await cached.locator('.bubble__file-download:not([disabled])').waitFor({ timeout: 12000 });
    dl = await downloadedBytes(receiver, cached);
    assert.deepEqual(dl.data, bytes, 'reloaded local file changed');

    const late = await openRoom({ width: 375, height: 780 });
    const lateCard = late.locator(`.bubble[data-msg-id="${messageId}"]`);
    await lateCard.locator('.bubble__file-download:not([disabled])').waitFor({ timeout: 15000 });
    dl = await downloadedBytes(late, lateCard);
    assert.deepEqual(dl.data, bytes, 'late joiner did not reconstruct encrypted file');
    const overflow = await late.evaluate(() => {
      const el = document.querySelector('.chat-list');
      return el.scrollWidth - el.clientWidth;
    });
    assert.ok(overflow <= 2, `mobile attachment overflow: ${overflow}`);
    if (process.env.QA_SCREEN_DIR) {
      fs.mkdirSync(process.env.QA_SCREEN_DIR, { recursive: true });
      await late.screenshot({ path: path.join(process.env.QA_SCREEN_DIR, 'file-mobile.png') });
    }

    // Reject oversized files locally, before a manifest is posted.
    await sender.locator('#file-input').setInputFiles({ name: 'too-large.bin', mimeType: 'application/octet-stream', buffer: Buffer.alloc(10 * 1024 * 1024 + 1) });
    await sender.locator('#toast-text').getByText('File too large', { exact: false }).waitFor({ timeout: 3000 });
    const after = await (await fetch(`${BASE}/api/rooms/${roomId}/transcript?after=0&limit=20`)).json();
    assert.equal(fileMessages(after.messages, key).length, 5, 'oversized file must never be sent');

    // Truncate by UTF-16 units without leaving a lone surrogate: otherwise
    // the room crypto UTF-8 encoder throws URIError on a valid filename.
    const safeBoundary = await sender.evaluate(() => {
      const name = window.Bot2BotFiles.nameOf('a'.repeat(179) + '😀.bin');
      encodeURIComponent(name);
      return name;
    });
    assert.equal(safeBoundary, 'a'.repeat(179));
    await sender.locator('#file-input').setInputFiles({ name: 'a'.repeat(179) + '😀.bin',
      mimeType: 'application/octet-stream', buffer: Buffer.from([42]) });
    const boundaryCard = receiver.locator('.bubble').filter({ has: receiver.locator('.bubble__file-name', { hasText: safeBoundary }) });
    await boundaryCard.locator('.bubble__file-download:not([disabled])').waitFor({ timeout: 12000 });
    assert.deepEqual((await downloadedBytes(receiver, boundaryCard)).data, Buffer.from([42]));

    // A peer with the room key can copy an unsigned sender label. A digest
    // only inside the chunk is attacker-controlled; the manifest must anchor
    // the expected bytes before the download becomes available.
    const forgedId = await sender.evaluate(async ({ roomId, key }) => {
      const api = window.Bot2BotCrypto;
      const post = async (text) => {
        const r = await fetch(`/api/rooms/${roomId}/messages`, { method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender: 'unsigned-peer', ...api.encrypt(api.b64urlDecode(key), text) }) });
        if (!r.ok) throw new Error(`POST ${r.status}`);
        return r.json();
      };
      const sha = async (s) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))),
        (b) => b.toString(16).padStart(2, '0')).join('');
      const goodHash = await sha('good');
      const evilHash = await sha('evil');
      const manifest = await post(`📎 File: bound.bin (4 B) [SHA-256: ${goodHash}]`);
      await post(JSON.stringify({ bot2bot_file_v1: 1, bot2bot_hist_resp_v1: true, type: 'chunk',
        parent_id: manifest.id, file_id: crypto.randomUUID(), name: 'bound.bin', size: 4,
        total: 1, index: 0, sha256: evilHash, data: btoa('evil') }));
      return manifest.id;
    }, { roomId, key });
    const forged = receiver.locator(`.bubble[data-msg-id="${forgedId}"]`);
    await forged.locator('.bubble__file-status', { hasText: 'Verification failed' }).waitFor({ timeout: 10000 });
    assert.equal(await forged.locator('.bubble__file-download').isDisabled(), true);

    // A forged digest must not produce a clickable download or execute a
    // hostile filename as markup. This uses the real encrypted relay path.
    const corruptId = await sender.evaluate(async ({ roomId, key }) => {
      const cryptoApi = window.Bot2BotCrypto;
      const bytes = cryptoApi.b64urlDecode(key);
      const post = async (text) => {
        const box = cryptoApi.encrypt(bytes, text);
        const res = await fetch(`/api/rooms/${roomId}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sender: 'integrity-test', ...box }),
        });
        if (!res.ok) throw new Error(`POST ${res.status}`);
        return res.json();
      };
      const manifest = await post('📎 File: checksum test');
      await post(JSON.stringify({
        bot2bot_file_v1: 1, bot2bot_hist_resp_v1: true, type: 'chunk',
        parent_id: manifest.id, file_id: crypto.randomUUID(),
        name: '<img src=x onerror=alert(1)>.bin', size: 4, total: 1,
        index: 0, sha256: '0'.repeat(64), data: btoa('test'),
      }));
      return manifest.id;
    }, { roomId, key });
    const corrupt = receiver.locator(`.bubble[data-msg-id="${corruptId}"]`);
    await corrupt.locator('.bubble__file-status', { hasText: 'Verification failed' }).waitFor({ timeout: 10000 });
    assert.equal(await corrupt.locator('.bubble__file-download').isDisabled(), true);
    assert.equal(await corrupt.locator('img').count(), 0, 'filename HTML executed');
    assert.equal(await receiver.evaluate(async (id) => !!(await window.Bot2BotHistory.loadAttachment(location.pathname.split('/').pop(), id)), corruptId), false);

    // A zero-byte file is valid; an expired file must leave the local cache.
    await sender.locator('#file-input').setInputFiles({ name: 'empty.txt', mimeType: 'text/plain', buffer: Buffer.alloc(0) });
    const empty = receiver.locator('.bubble').filter({ has: receiver.locator('.bubble__file-name', { hasText: 'empty.txt' }) });
    await empty.locator('.bubble__file-download:not([disabled])').waitFor({ timeout: 12000 });
    dl = await downloadedBytes(receiver, empty);
    assert.equal(dl.data.length, 0, 'zero-byte file did not arrive');
    if (process.env.BOT2BOT_MAX_QA === '1') {
      const maxBytes = crypto.randomBytes(10 * 1024 * 1024);
      await sender.locator('#file-input').setInputFiles({ name: 'max-10m.bin', mimeType: 'application/octet-stream', buffer: maxBytes });
      const maxCard = receiver.locator('.bubble').filter({ has: receiver.locator('.bubble__file-name', { hasText: 'max-10m.bin' }) });
      await maxCard.locator('.bubble__file-download:not([disabled])').waitFor({ timeout: 120000 });
      dl = await downloadedBytes(receiver, maxCard);
      assert.deepEqual(dl.data, maxBytes, 'maximum allowed binary file changed');
      console.log('PASS maximum 10 MiB file, 214 encrypted chunks');
    }
    assert.equal(await receiver.evaluate(async () => {
      const room = location.pathname.split('/').pop();
      const id = crypto.randomUUID();
      await window.Bot2BotHistory.saveAttachment(room, id, { name: 'expired', size: 0, data: new Blob([]), ts: Date.now() - 5000, ttl_ms: 1000 });
      await window.Bot2BotHistory.sweepExpired(room);
      return await window.Bot2BotHistory.loadAttachment(room, id);
    }), null, 'expired attachment was retained');

    await receiver.evaluate(({ id, seq }) => window.__bot2botTest.applyDelete(id, seq), { id: messageId, seq });
    await receiver.waitForFunction(async (id) => !(await window.Bot2BotHistory.loadAttachment(location.pathname.split('/').pop(), id)), messageId);
    console.log('PASS encrypted attachment: binary round-trip, late join, reload, size guard, delete cleanup, mobile');
  } finally {
    await Promise.all(contexts.map((ctx) => ctx.close()));
    await browser.close();
  }
}
main().catch((e) => { console.error(e); process.exitCode = 1; });
