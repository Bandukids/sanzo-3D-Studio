import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { once } from 'node:events';

const root=path.resolve(import.meta.dirname,'..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function launch(dir) {
  const child=spawn(process.execPath,['server.mjs'],{cwd:root,env:{...process.env,PORT:'0',SANZO_DATA_DIR:dir,TOKENHUB_API_KEY:'',HUNYUAN_3D_API_KEY:'',TENCENT_HUNYUAN_API_KEY:''},windowsHide:true,stdio:['ignore','pipe','pipe']});
  let output='';
  const url=await new Promise((resolve,reject)=>{
    const timeout=setTimeout(()=>reject(new Error('Test server did not start: '+output)),8000);
    child.stdout.on('data',chunk=>{output+=chunk;const m=output.match(/http:\/\/localhost:(\d+)/);if(m){clearTimeout(timeout);resolve('http://127.0.0.1:'+m[1]);}});
    child.once('error',reject);
    child.once('exit',code=>{clearTimeout(timeout);reject(new Error('Server exited '+code));});
  });
  return {url,async stop(){ if(child.exitCode===null){const exited=once(child,'exit');child.kill();await exited;} }};
}

test('asset API preserves media, validates updates and survives a restart', {timeout:20000}, async t=>{
  const dir=await mkdtemp(path.join(tmpdir(),'sanzo-3d-test-'));
  const id='0000000000000000';
  const tasks=Array.from({length:65},(_,i)=>({id:i.toString(16).padStart(16,'0'),kind:i===1?'rig':'model',parentId:i===1?id:null,title:'原始资产 '+i,prompt:'description',model:'hy-3d-express',modelLabel:'混元 3D Express',status:'done',createdAt:i+1,files:[],demo:true}));
  await writeFile(path.join(dir,'tasks.json'),JSON.stringify(tasks));
  await mkdir(path.join(dir,'assets',id),{recursive:true});
  const media=path.join(dir,'assets',id,'model.glb');await writeFile(media,'model-file-sentinel');
  let server=await launch(dir);
  t.after(async()=>{
    await server.stop();
    const resolved=path.resolve(dir);
    if(path.dirname(resolved)===path.resolve(tmpdir()) && path.basename(resolved).startsWith('sanzo-3d-test-')) await rm(resolved,{recursive:true,force:true});
  });
  const patch=body=>fetch(server.url+'/api/tasks/'+id,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  await t.test('direct app routes work and complete asset history is returned',async()=>{
    for(const route of ['/create/','/assets/','/studio/','/tasks/','/settings/']){
      const r=await fetch(server.url+route);assert.equal(r.status,200,route);assert.match(await r.text(),/id="appShell"/);
    }
    assert.equal((await (await fetch(server.url+'/api/tasks')).json()).length,65);
    assert.equal((await fetch(server.url+'/unknown/')).status,404);
  });
  await t.test('rename and recycle retain all media and version links',async()=>{
    const response=await patch({title:'蓝衣男孩',collection:'游戏角色',trashed:true,status:'failed',files:[]});
    assert.equal(response.status,200);
    const updated=await response.json();assert.equal(updated.title,'蓝衣男孩');assert.equal(updated.collection,'游戏角色');assert.ok(updated.trashedAt);assert.equal(updated.status,'done');
    assert.equal(await readFile(media,'utf8'),'model-file-sentinel');
    const list=await (await fetch(server.url+'/api/tasks')).json();assert.equal(list.find(x=>x.kind==='rig').parentId,id);
  });
  await t.test('invalid updates are rejected atomically and cross-site mutation is blocked',async()=>{
    for(const invalid of [null,[],{title:''},{title:'x'.repeat(121)},{collection:'x'.repeat(61)},{trashed:'true'},{title:'不应写入',collection:8}]) assert.equal((await patch(invalid)).status,400);
    const badOrigin=await fetch(server.url+'/api/tasks/'+id,{method:'PATCH',headers:{Origin:'https://example.com','Content-Type':'application/json'},body:JSON.stringify({title:'不应写入'})});assert.equal(badOrigin.status,403);
    const current=await (await fetch(server.url+'/api/tasks/'+id)).json();assert.equal(current.title,'蓝衣男孩');
  });
  await t.test('recycled metadata persists and restoration keeps the original file',async()=>{
    // Wait for the existing atomic save debounce, not for an upstream operation.
    for(let i=0;i<20;i++){const saved=JSON.parse(await readFile(path.join(dir,'tasks.json'),'utf8'));if(saved.find(t=>t.id===id).trashedAt)break;await delay(50);}
    await server.stop();server=await launch(dir);
    const persisted=await (await fetch(server.url+'/api/tasks/'+id)).json();assert.equal(persisted.title,'蓝衣男孩');assert.ok(persisted.trashedAt);
    const restored=await (await patch({trashed:false})).json();assert.equal(restored.trashedAt,null);assert.equal(restored.collection,'游戏角色');assert.equal(await readFile(media,'utf8'),'model-file-sentinel');
  });
  await t.test('demo creation still submits through the existing generation API',async()=>{
    const r=await fetch(server.url+'/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:'text',model:'hy-3d-express',prompt:'测试形体',demo:true})});
    assert.equal(r.status,200);const task=await r.json();assert.equal(task.demo,true);assert.equal(task.kind,'model');assert.equal(task.status,'queued');
  });
});
