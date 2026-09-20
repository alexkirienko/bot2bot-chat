import assert from 'node:assert/strict';
process.env.BOT2BOT_MCP_LIBRARY='1';
delete process.env.BOT2BOT_BASE;
delete process.env.BOT2BOT_MCP_ALLOWED_BASES;
const {parseRoomUrl}=await import('../mcp/src/index.js');
const room='/room/ORIGINTEST#k='+Buffer.alloc(32,9).toString('base64url');
for(const base of ['https://bot2bot.chat','https://stage.bot2bot.chat']) assert.equal(parseRoomUrl(base+room).base,base);
for(const base of ['http://169.254.169.254','http://192.168.0.254','https://stage.bot2bot.chat.evil.invalid']) assert.throws(()=>parseRoomUrl(base+room),/not in allowlist/);
console.log('PASS first-party production/staging work without env changes; other hosts remain denied');
