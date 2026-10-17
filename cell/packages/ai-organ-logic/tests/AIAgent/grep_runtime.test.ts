import {afterEach,expect,test} from 'bun:test';
import {mkdirSync,mkdtempSync,realpathSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {buildGrepToolDef} from '../../src/composer/AIAgent/tools/Grep';
import {configureLocalPermissionConfigStore} from '../../src/permissions/LocalPermissionConfig';
import {LocalFilePermissionConfigStore} from '@cell/ai-support/permissions/LocalFilePermissionConfigStore';

const roots:string[]=[];
afterEach(()=>{configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(read:unknown='allow'){
 const root=realpathSync(mkdtempSync(join(tmpdir(),'grep-runtime-')));roots.push(root);
 const work=join(root,'work'),authority=join(root,'authority');mkdirSync(work);mkdirSync(authority);
 writeFileSync(join(work,'source.txt'),'KNOWN_MATCH\n--literal\n');writeFileSync(join(work,'other.txt'),'OTHER_ONLY\n');
 writeFileSync(join(authority,'permissions.json'),JSON.stringify({permission:{read}}));
 configureLocalPermissionConfigStore(LocalFilePermissionConfigStore);
 const runtime={vm:{outerCtx:{workDir:work,metadata:{exec_protocol:{mode:'default'},local_permissions:{authority_root:authority}}}}} as any;
 return {work,authority,run:(input:any)=>buildGrepToolDef().run(runtime,input,{} as any)};
}
test('actual grep searches one file, directories, includes and literal option-like patterns',async()=>{
 const f=fixture();expect(await f.run({path:'source.txt',pattern:'KNOWN_MATCH'})).toContain('1:KNOWN_MATCH');
 expect(await f.run({path:'.',pattern:'KNOWN_MATCH',include:'*.txt'})).toContain('source.txt:1:KNOWN_MATCH');
 expect(await f.run({path:'source.txt',pattern:'--literal'})).toContain('2:--literal');
 expect(await f.run({path:'.',pattern:'KNOWN_MATCH',include:'*.py'})).toBe('(no matches)');
 expect(await f.run({path:'source.txt',pattern:'absent'})).toBe('(no matches)');
});
test('regex and missing-target failures never become successful no-match facts',async()=>{
 const f=fixture();expect(await f.run({path:'.',pattern:'['})).toStartWith('Error: grep failed');
 expect(await f.run({path:'missing.txt',pattern:'x'})).toStartWith('Error: grep failed');
});
test('file-only grant does not broaden to the workspace or private authority',async()=>{
 const f=fixture({'*':'deny','source.txt':'allow'});
 expect(await f.run({path:'source.txt',pattern:'KNOWN_MATCH'})).toContain('KNOWN_MATCH');
 expect(await f.run({path:'.',pattern:'OTHER_ONLY'})).toStartWith('Error:');
 expect(await f.run({path:f.authority,pattern:'permission',scopeIntent:'external'})).toStartWith('Error:');
});
