import assert from 'node:assert/strict';
import {createAgentProcessEffects,createAgentRpc} from '../../cell/packages/ai-runtime-host-support/src/agentProcess.ts';
const effects=createAgentProcessEffects(),versions={};
for(const provider of ['codex','claude','grok']){versions[provider]=await effects.version(provider);assert(versions[provider],provider+' installed version');}
// Only initialize the real transport. No thread, session or inference is created.
const child=await effects.spawn(['codex','app-server','--stdio','--disable','shell_tool','--disable','multi_agent'],import.meta.dirname);
try{const rpc=createAgentRpc(child,async()=>{},async()=>{throw Error('unexpected server request')});const initialized=await rpc.request('initialize',{clientInfo:{name:'eidolon_bridge_protocol_probe',title:'Local compatibility probe',version:'0.1.0'},capabilities:null},10000);assert(initialized&&typeof initialized==='object');await rpc.notify('initialized',{});}
finally{await child.close()}
// CLI parser/help only: never prompt a provider or touch existing user sessions.
const grok=Bun.spawnSync(['grok','--model','fixture','--tools','','--no-subagents','--disable-web-search','--permission-mode','dontAsk','--deny','MCPTool','agent','--no-leader','stdio','--help'],{stdout:'pipe',stderr:'ignore'});assert.equal(grok.exitCode,0,'installed Grok fixed flags');
const claude=Bun.spawnSync(['claude','--print','--bare','--permission-mode','dontAsk','--tools','','--strict-mcp-config','--mcp-config','{"mcpServers":{}}','--setting-sources','','--input-format','stream-json','--output-format','stream-json','--verbose','--help'],{stdout:'pipe',stderr:'ignore'});assert.equal(claude.exitCode,0,'installed Claude fixed flags');
console.log(JSON.stringify({passed:true,versions,codexTransport:'initialized-only',grok:'help-only',claude:'help-only',providerCalls:0,liveAuthentication:'unverified'}));
