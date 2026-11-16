import test from 'node:test';
import assert from 'node:assert/strict';
import { groupAssets, filterAssets } from '../public/js/asset-data.js';

const model={id:'model',kind:'model',title:'蓝衣男孩',prompt:'A pose character',createdAt:1,status:'done',preview:'/character.png',collection:'游戏角色'};
const rig={id:'rig',kind:'rig',parentId:'model',createdAt:2,status:'done',modelLabel:'混元绑骨'};
const walk={id:'walk',kind:'animate',parentId:'rig',createdAt:3,status:'done'};
const run={id:'run',kind:'animate',parentId:'rig',createdAt:4,status:'queued'};

test('one character retains its original, rig and branching animation versions',()=>{
  const [g]=groupAssets([run,rig,model,walk]);
  assert.equal(g.id,'model'); assert.equal(g.preview,'/character.png'); assert.equal(g.animated,true);
  assert.deepEqual(g.versions.map(t=>t.id),['model','rig','walk','run']);
  assert.equal(g.latest.id,'run');
});

test('recycling the root hides the whole asset and restoring preserves its lineage',()=>{
  const trashed=groupAssets([{...model,trashedAt:123},rig,walk]);
  assert.equal(filterAssets(trashed).length,0);
  assert.equal(filterAssets(trashed,{filter:'trash'})[0].versions.length,3);
  const restored=groupAssets([{...model,trashedAt:null},rig,walk]);
  assert.equal(filterAssets(restored)[0].versions.length,3);
  assert.equal(filterAssets(restored,{filter:'trash'}).length,0);
});

test('search finds the parent project or a child engine without duplicating cards',()=>{
  const groups=groupAssets([model,rig,walk,{id:'other',kind:'model',createdAt:5,title:'山石',status:'done'}]);
  assert.equal(filterAssets(groups,{query:'混元绑骨'}).length,1);
  assert.equal(filterAssets(groups,{collection:'游戏角色',filter:'animated'}).length,1);
  assert.deepEqual(filterAssets(groups,{sort:'oldest'}).map(g=>g.id),['model','other']);
  assert.equal(filterAssets(groups,{query:'找不到'}).length,0);
});

test('missing parents and corrupt cycles do not lose versions or hang',()=>{
  const tasks=[{id:'orphan',parentId:'missing',createdAt:1},{id:'a',parentId:'b',createdAt:2},{id:'b',parentId:'a',createdAt:3}];
  const groups=groupAssets(tasks);
  assert.equal(groups.flatMap(g=>g.versions).length,3);
  assert.ok(groups.some(g=>g.root.id==='orphan'));
});
