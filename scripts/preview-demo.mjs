// Isolated, credential-free preview. Existing data/ and model files are untouched.
import { spawn } from 'node:child_process';
import { mkdir, writeFile, access } from 'node:fs/promises';
import path from 'node:path';
const root=path.resolve(import.meta.dirname,'..');
const dir=path.join(root,'output','demo-preview');
await mkdir(dir,{recursive:true});
try { await access(path.join(dir,'tasks.json')); }
catch {
  const now=Date.now()-30000;
  await writeFile(path.join(dir,'tasks.json'),JSON.stringify([
    {id:'1111111111111111',kind:'model',parentId:null,title:'形体练习',prompt:'蓝橙金属雕塑',model:'hy-3d-express',modelLabel:'混元 3D Express',status:'done',createdAt:now,files:[],demo:true},
    {id:'2222222222222222',kind:'rig',parentId:'1111111111111111',title:'形体练习',model:'hy-3d-rigging',modelLabel:'混元绑骨 · 行走',status:'done',createdAt:now+1000,files:[],demo:true,options:{motionType:'23',motionName:'行走'}},
  ],null,2));
}
const child=spawn(process.execPath,['server.mjs'],{cwd:root,windowsHide:true,stdio:'inherit',env:{...process.env,PORT:process.env.PORT || '5174',SANZO_DATA_DIR:dir,TOKENHUB_API_KEY:'',HUNYUAN_3D_API_KEY:'',TENCENT_HUNYUAN_API_KEY:''}});
process.on('SIGINT',()=>child.kill());
process.on('SIGTERM',()=>child.kill());
child.on('exit',code=>process.exit(code || 0));
