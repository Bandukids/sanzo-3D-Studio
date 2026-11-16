import { groupAssets, filterAssets, titleOf, taskKind, isPending } from './asset-data.js';
const $ = s => document.querySelector(s);
const kinds = {model:'模型',rig:'绑骨',animate:'动画',motion:'文生动作'};
const node = (tag,cls,text) => { const n=document.createElement(tag); if(cls)n.className=cls; if(text!=null)n.textContent=text; return n; };
const icon = name => { const n=document.createElementNS('http://www.w3.org/2000/svg','svg'); n.setAttribute('class','icon'); n.setAttribute('aria-hidden','true'); const u=document.createElementNS(n.namespaceURI,'use'); u.setAttribute('href',`#i-${name}`); n.append(u); return n; };
const stamp = t => new Date(t).toLocaleString('zh-CN',{month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false});
const status = t => t.status === 'done' ? '已完成' : t.status === 'failed' ? '失败' : ({queued:'排队中',saving:'保存中'}[t.status] || '生成中');
const button = (text,name,click) => { const b=node('button',null); b.type='button'; if(name)b.append(icon(name)); b.append(document.createTextNode(text)); b.addEventListener('click',click); return b; };

export function createLibrary({ getTasks, onOpen, onUpdate, api, toast }) {
  let filter='all', dialogId=null;
  const dialog=$('#assetDialog');
  const groups=()=>groupAssets(getTasks());
  const groupFor=id=>groups().find(g=>g.versions.some(t=>t.id===id));
  const rootTitle=t=>titleOf(groupFor(t.id)?.root || t);
  async function patch(group,values) {
    const t=await api(`/api/tasks/${group.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify(values)});
    onUpdate(t);
  }
  function openGroup(g) { onOpen(g.versions.filter(t=>t.status==='done').at(-1) || g.latest); }
  async function trash(g,b) {
    b.disabled=true;
    try {
      await patch(g,{trashed:!g.trashed});
      toast(g.trashed?'资产已恢复':'已移入回收站，可随时恢复');
    } catch(e) { toast(e.message); b.disabled=false; }
  }
  function card(g) {
    const c=node('article','card'+(g.versions.some(isPending)?' is-running':''));
    const open=button('',null,()=>openGroup(g)); open.className='card-open'; open.setAttribute('aria-label',`打开 ${titleOf(g.root)}`);
    const thumb=node('div','thumb');
    if(g.preview) { const img=node('img'); img.src=g.preview; img.alt=''; img.loading='lazy'; thumb.append(img); }
    else thumb.append(icon(g.animated?'bone':'cube'));
    if(g.versions.length>1) thumb.append(node('span','version-badge',`${g.versions.length} 个版本`));
    const copy=node('div','card-body');
    copy.append(node('p',null,titleOf(g.root)));
    copy.append(node('span','card-description',g.root.collection || g.root.prompt || '自由创作'));
    const meta=node('div','card-meta');
    meta.append(node('span',null,(g.root.modelLabel || '')+(g.root.demo?' · 演示':'')),node('span',`st-${g.latest.status==='done'?'done':g.latest.status==='failed'?'failed':'run'}`,status(g.latest)));
    copy.append(meta); open.append(thumb,copy);
    const actions=node('div','card-actions');
    actions.append(button('详情','layers',()=>details(g.id)));
    const edit=button('命名','edit',()=>details(g.id,true)); actions.append(edit);
    const del=button(g.trashed?'恢复':'回收',g.trashed?'restore':'trash',()=>trash(g,del)); del.setAttribute('aria-label',`${g.trashed?'恢复':'回收'} ${titleOf(g.root)}`); actions.append(del);
    c.append(open,node('span','kind',g.animated?'骨架与动作':kinds[taskKind(g.root)]),actions);
    return c;
  }
  function render() {
    const all=groups(), visible=all.filter(g=>!g.trashed);
    $('#assetCount').textContent=visible.length;
    const collections=[...new Set(all.map(g=>g.root.collection).filter(Boolean))].sort((a,b)=>a.localeCompare(b,'zh-CN'));
    const sel=$('#collectionFilter'),current=sel.value;
    const signature=collections.join('\n');
    if(sel.dataset.signature!==signature) {
      sel.replaceChildren(new Option('所有项目',''),...collections.map(x=>new Option(x,x)));
      sel.value=collections.includes(current)?current:''; sel.dataset.signature=signature;
      $('#collectionSuggestions').replaceChildren(...collections.map(x=>new Option(x,x)));
    }
    const result=filterAssets(all,{filter,query:$('#assetSearch').value,collection:sel.value,sort:$('#assetSort').value});
    $('#galleryGrid').replaceChildren(...result.map(card));
    $('#galleryEmpty').hidden=result.length>0;
    if(!result.length) {
      const empty=$('#galleryEmpty');
      empty.querySelector('h2').textContent=filter==='trash'?'回收站是空的。':all.length?'没有找到对应资产。':'让第一个灵感，在这里成形。';
      empty.querySelector('p').textContent=filter==='trash'?'移入回收站的资产，可以在这里恢复。':all.length?'换个关键词，或调整筛选条件试试。':'生成的模型、骨架与动作，会自动整理到这里。';
    }
    $('#assetSummary').textContent=filter==='trash'?`${result.length} 项资产 · 原始文件仍保存在本机`:`${result.length} 项资产 · ${result.reduce((n,g)=>n+g.versions.length,0)} 个创作版本`;
    renderTasks();
    if(dialog.open && dialogId) renderVersions(groupFor(dialogId));
  }
  function renderTasks() {
    const all=groups().filter(g=>!g.trashed), tasks=all.flatMap(g=>g.versions).sort((a,b)=>b.createdAt-a.createdAt);
    const count=tasks.filter(isPending).length;
    $('#taskCount').textContent=count; $('#taskCount').hidden=!count;
    const stats=[[count,'进行中'],[tasks.filter(t=>t.status==='done').length,'已完成'],[tasks.filter(t=>t.status==='failed').length,'失败']];
    $('#taskStats').replaceChildren(...stats.map(([n,label])=>{const d=node('div','task-stat');d.append(node('strong',null,n),node('span',null,label));return d;}));
    $('#taskList').replaceChildren(...tasks.map(t=>{
      const row=node('div','task-row'),copy=node('div','task-row-copy');
      copy.append(node('strong',null,rootTitle(t)),node('small',null,`${kinds[taskKind(t)]} · ${t.modelLabel} · ${stamp(t.createdAt)}${t.demo?' · 演示':''}`));
      if(t.error) copy.append(node('small',null,t.error));
      row.append(icon(taskKind(t)==='model'?'cube':'bone'),copy,node('span',`task-state ${t.status}`,status(t)));
      const b=button('查看','arrow',()=>onOpen(t));b.className='soft-button';row.append(b);return row;
    }));
    if(!tasks.length) $('#taskList').append(node('p','task-empty','还没有任务。开始创作，让灵感慢慢成形。'));
  }
  function renderVersions(g) {
    if(!g)return;
    $('#versionCount').textContent=`${g.versions.length} 个版本`;
    $('#versionList').replaceChildren(...g.versions.map((t,i)=>{
      const row=node('div','version-row'),copy=node('div');
      copy.append(node('b',null,`${String(i+1).padStart(2,'0')} · ${kinds[taskKind(t)]}${t.options?.motionName?' · '+t.options.motionName:''}`),node('small',null,`${t.modelLabel} · ${status(t)} · ${stamp(t.createdAt)}`));
      const files=node('div','version-downloads');
      for(const f of t.files || []){const a=node('a',null,f.name.split('.').pop().toUpperCase()); a.href=f.url+'?dl'; a.setAttribute('download','');files.append(a);}copy.append(files);
      const b=button('打开',null,()=>{dialog.close();onOpen(t);});b.className='soft-button';row.append(icon(taskKind(t)==='model'?'cube':'bone'),copy,b);return row;
    }));
  }
  function details(id,focus=false) {
    const g=groupFor(id); if(!g)return;
    dialogId=g.id;
    $('#assetDialogTitle').textContent='每一版，都有新可能。';
    $('#assetName').value=titleOf(g.root).slice(0,120);
    $('#assetCollection').value=g.root.collection || '';
    $('#assetSaveMsg').textContent='';
    renderVersions(g);
    dialog.showModal();
    if(focus) $('#assetName').select();
  }
  $('#assetMetaForm').addEventListener('submit',async e=>{
    e.preventDefault(); const g=groupFor(dialogId);if(!g)return;
    const b=e.submitter;b.disabled=true;
    try {await patch(g,{title:$('#assetName').value.trim(),collection:$('#assetCollection').value.trim()});$('#assetSaveMsg').textContent='已保存';toast('资产信息已保存');}
    catch(err){$('#assetSaveMsg').textContent=err.message;}finally{b.disabled=false;}
  });
  document.querySelector('[data-close-dialog]').addEventListener('click',()=>dialog.close());
  $('#assetFilters').addEventListener('click',e=>{const b=e.target.closest('[data-filter]');if(!b)return;filter=b.dataset.filter;for(const x of $('#assetFilters').children){const active=x===b;x.classList.toggle('is-active',active);x.setAttribute('aria-pressed',String(active));}render();});
  $('#assetSearch').addEventListener('input',render);
  $('#collectionFilter').addEventListener('change',render);
  $('#assetSort').addEventListener('change',render);
  return {render,details,rootTitle,groupFor};
}
