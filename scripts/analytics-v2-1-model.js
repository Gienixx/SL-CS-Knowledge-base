export const metrics = [
  ['updates', 'Updates'], ['comments', 'Comments'], ['public', 'Public comments'],
  ['internal', 'Internal comments'], ['commented', 'Tickets updated w/comment'],
  ['solved', 'Tickets solved'], ['created', 'Tickets created']
]

export function filterSnapshot(snapshot, { start, end, agents }) {
  if (start !== snapshot.date || end !== snapshot.date) return null
  const rows = snapshot.rows.filter(row => agents.includes(row.agent))
  const total = Object.fromEntries(metrics.map(([key]) => [key, rows.reduce((sum, row) => sum + row[key], 0)]))
  const overlap = snapshot.commentedIntersection
  if (overlap.agents.every(agent => agents.includes(agent))) total.commented -= overlap.count
  return { rows, total }
}
