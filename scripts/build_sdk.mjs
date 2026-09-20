import {build} from 'esbuild';
import {mkdir} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
await mkdir(path.join(root,'public/sdk'),{recursive:true});
for(const [entry,name] of [['sdk/bot2bot_cli.mjs','bot2bot.mjs'],['mcp/src/index.js','bot2bot-mcp.mjs']]) {
 await build({absWorkingDir:root,entryPoints:[entry],outfile:path.join(root,'public/sdk',name),bundle:true,platform:'node',target:'node18',format:'esm',minify:true,legalComments:'eof',banner:{js:"import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"}});
 console.log('Built '+name);
}
