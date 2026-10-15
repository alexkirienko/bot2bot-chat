// Browser regression for long-message collapse/expand on real room UI.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const BASE = process.env.BOT2BOT_BASE || 'http://127.0.0.1:3100';

async function main() {
  const browser = await chromium.launch();
  try {
    for (const viewport of [{ width: 1440, height: 900 }, { width: 375, height: 780 }]) {
      const context = await browser.newContext({ viewport, hasTouch: viewport.width < 500 });
      const page = await context.newPage();
      const roomId = 'CLP' + crypto.randomBytes(6).toString('hex');
      const key = crypto.randomBytes(32).toString('base64url');
      // Only a disposable room is opened. Do not print the URL/key.
      await page.goto(`${BASE}/room/${roomId}#k=${key}`, { waitUntil: 'domcontentloaded' });
      await page.waitForFunction(() => !!window.__bot2botTest?.renderMessage);
      const endMarker = 'END-OF-LONG-MESSAGE';
      const longText = [
        '**Summary:** first paragraph with [link](https://example.org/).',
        '',
        'Context '.repeat(95),
        '',
        '- item one', '- item two',
        '',
        '```js', 'const answer = 42;', '// ' + 'code '.repeat(80), '```',
        '', endMarker,
      ].join('\n');
      await page.evaluate(({ longText }) => {
        const render = window.__bot2botTest.renderMessage;
        const ts = Date.now();
        render({ id: 'qa-short', seq: 1, sender: 'qa', ts, text: 'Short text.' });
        render({ id: 'qa-long', seq: 2, sender: 'bot', ts, text: longText });
        render({ id: 'qa-many-lines', seq: 3, sender: 'bot', ts, text: Array(25).fill('line').join('\n') });
        render({ id: 'qa-escape', seq: 4, sender: 'bot', ts, text: '<img src=x onerror=alert(1)> '.repeat(45) });
      }, { longText });
      const short = page.locator('.bubble[data-msg-id="qa-short"]');
      const long = page.locator('.bubble[data-msg-id="qa-long"]');
      const multiline = page.locator('.bubble[data-msg-id="qa-many-lines"]');
      const escape = page.locator('.bubble[data-msg-id="qa-escape"]');
      assert.equal(await short.locator('.bubble__expand').count(), 0, 'short message must not collapse');
      for (const bubble of [long, multiline, escape]) {
        const button = bubble.locator('.bubble__expand');
        assert.equal(await button.count(), 1, 'long/tall message must have expand button');
        assert.equal(await button.getAttribute('aria-expanded'), 'false');
        assert.equal(await bubble.locator('.bubble__body').isHidden(), true);
        assert.equal(await bubble.locator('.bubble__preview').isVisible(), true);
        const height = await bubble.locator('.bubble__preview').evaluate((el) => el.getBoundingClientRect().height);
        assert.ok(height <= 175, `collapsed preview too tall: ${height}`);
        assert.equal(await button.getAttribute('aria-controls'), await bubble.locator('.bubble__body').getAttribute('id'));
      }
      assert.equal(await escape.locator('img').count(), 0, 'plain preview must not inject HTML');
      assert.ok((await long.locator('.bubble__body').textContent()).includes(endMarker), 'full text is retained while collapsed');
      const expand = long.locator('.bubble__expand');
      await expand.click();
      assert.equal(await expand.getAttribute('aria-expanded'), 'true');
      assert.equal(await long.locator('.bubble__body').isVisible(), true);
      assert.equal(await long.locator('.bubble__preview').isHidden(), true);
      assert.ok((await long.locator('.bubble__body').textContent()).includes(endMarker));
      assert.equal(await long.locator('.bubble__body pre code').count(), 1, 'Markdown code must survive expand');
      assert.equal(await long.locator('.bubble__body a').count(), 1, 'Markdown link must survive expand');
      if (process.env.QA_SCREEN_DIR) {
        fs.mkdirSync(process.env.QA_SCREEN_DIR, { recursive: true });
        await page.screenshot({ path: path.join(process.env.QA_SCREEN_DIR, `long-expanded-${viewport.width}.png`) });
      }
      await expand.focus();
      await page.keyboard.press('Enter');
      assert.equal(await expand.getAttribute('aria-expanded'), 'false', 'keyboard must collapse');
      assert.equal(await long.locator('.bubble__body').isHidden(), true);
      assert.equal(await expand.evaluate((el) => document.activeElement === el), true, 'focus must remain on toggle');
      if (process.env.QA_SCREEN_DIR) {
        await page.screenshot({ path: path.join(process.env.QA_SCREEN_DIR, `long-collapsed-${viewport.width}.png`) });
      }
      const layout = await page.evaluate(() => {
        const list = document.querySelector('.chat__list');
        return { scrollWidth: list.scrollWidth, clientWidth: list.clientWidth };
      });
      assert.ok(layout.scrollWidth <= layout.clientWidth + 2, 'chat list must not overflow horizontally');

      if (process.env.QA_LIVE === '1') {
        // Separate browser context → encrypted wire → receiver's normal
        // renderer. Both endpoints use this newly minted QA room only.
        const senderContext = await browser.newContext();
        const sender = await senderContext.newPage();
        await sender.goto(`${BASE}/room/${roomId}#k=${key}`, { waitUntil: 'domcontentloaded' });
        await sender.waitForFunction(() => !!window.__bot2botTest?.renderMessage);
        const marker = 'WIRE-COLLAPSE-' + crypto.randomBytes(4).toString('hex');
        await sender.fill('#message', `**Wire test** ${'dialogue '.repeat(105)} ${marker}`);
        await sender.press('#message', 'Enter');
        const incoming = page.locator('.bubble').filter({ hasText: marker });
        await incoming.waitFor({ state: 'visible', timeout: 10000 });
        assert.equal(await incoming.locator('.bubble__expand').count(), 1, 'wire-delivered long text must collapse');
        await incoming.locator('.bubble__expand').click();
        assert.equal(await incoming.locator('.bubble__body').isVisible(), true);
        await senderContext.close();
      }

      // Replayed IDB history goes through the same renderer on reload.
      await page.waitForTimeout(250);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.locator('.bubble[data-msg-id="qa-long"] .bubble__expand').waitFor({ timeout: 10000 });
      assert.equal(await page.locator('.bubble[data-msg-id="qa-long"] .bubble__body').isHidden(), true,
        'cached long message must start collapsed again');
      await context.close();
      console.log(`PASS long-message UI ${viewport.width}px`);
    }
  } finally {
    await browser.close();
  }
}
main().catch((err) => { console.error(err); process.exitCode = 1; });
