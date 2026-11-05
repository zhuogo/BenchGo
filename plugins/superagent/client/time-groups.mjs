export function timestamp(value) {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

export function groupByDay(entries, getTime, now = new Date()) {
  const dayKey = date => `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
  const today = dayKey(now), yesterdayDate = new Date(now);
  yesterdayDate.setDate(yesterdayDate.getDate() - 1);
  const yesterday = dayKey(yesterdayDate), groups = new Map();
  for (const entry of [...entries].sort((a, b) => timestamp(getTime(b)) - timestamp(getTime(a)))) {
    const value = getTime(entry), valid = timestamp(value), date = valid ? new Date(value) : null;
    const key = date ? dayKey(date) : 'unknown';
    if (!groups.has(key)) groups.set(key, { key, label: !date ? '时间未记录' : key === today ? '今天' : key === yesterday ? '昨天' : date.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }), entries: [] });
    groups.get(key).entries.push(entry);
  }
  return [...groups.values()];
}
