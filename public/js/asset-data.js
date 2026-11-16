export const taskKind = (t) => t.kind || 'model';
export const isPending = (t) => !['done', 'failed'].includes(t.status);
export const titleOf = (t) => t.title || t.prompt || '未命名资产';

/** A missing ancestor remains a valid root; cycles must never hang the library. */
export function groupAssets(tasks) {
  const byId = new Map(tasks.map(t => [t.id, t]));
  const groups = new Map();
  for (const task of tasks) {
    let root = task;
    const seen = new Set([root.id]);
    while (root.parentId && byId.has(root.parentId) && !seen.has(root.parentId)) {
      root = byId.get(root.parentId);
      seen.add(root.id);
    }
    const group = groups.get(root.id) || { id:root.id, root, versions:[] };
    group.versions.push(task);
    groups.set(root.id, group);
  }
  for (const g of groups.values()) {
    g.versions.sort((a,b) => a.createdAt - b.createdAt);
    g.latest = g.versions.at(-1);
    g.preview = g.root.preview || g.versions.find(t => t.preview)?.preview || '';
    g.trashed = Boolean(g.root.trashedAt);
    g.animated = g.versions.some(t => taskKind(t) !== 'model');
  }
  return [...groups.values()];
}

export function filterAssets(groups, { filter='all', query='', collection='', sort='newest' } = {}) {
  const q = query.trim().toLocaleLowerCase();
  return groups.filter(g => {
    if (g.trashed !== (filter === 'trash')) return false;
    if (filter === 'model' && taskKind(g.root) !== 'model') return false;
    if (filter === 'animated' && !g.animated) return false;
    if (collection && (g.root.collection || '') !== collection) return false;
    return !q || g.versions.some(t => [titleOf(g.root), t.prompt, t.modelLabel, g.root.collection].join(' ').toLocaleLowerCase().includes(q));
  }).sort((a,b) => sort === 'name' ? titleOf(a.root).localeCompare(titleOf(b.root),'zh-CN') : (a.root.createdAt-b.root.createdAt) * (sort === 'oldest' ? 1 : -1));
}
