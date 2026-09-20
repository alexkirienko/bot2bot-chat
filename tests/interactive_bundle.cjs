const fs=require('fs'),assert=require('assert/strict');
const code=fs.readFileSync('public/sdk/bot2bot.mjs','utf8');
assert(Buffer.byteLength(code)<200000,'CLI must not include unused MCP host/protocol dependencies');
assert(code.split('\n').length>500,'CLI must be readable for a host security review, not one minified blob');
assert(!code.includes('node_modules/@modelcontextprotocol'),'CLI must not ship unused MCP SDK code');
console.log('PASS standalone CLI is small, readable, and excludes unused MCP host dependencies');
