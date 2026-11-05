/** Written authority stays in AGENTS.md; configuration only enables exact section IDs. */
export function readAdmissionRules(content) {
  const rules = [], seen = new Set();
  let active = null, fence = null;
  const finish = () => {
    if (!active) return;
    const instruction = active.lines.join('\n').trim();
    if (seen.has(active.id)) throw new Error(`Duplicate written rule ID: ${active.id}`);
    seen.add(active.id);
    if (instruction) rules.push({ id: active.id, instruction });
    active = null;
  };
  for (const line of String(content).split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})/u.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length && line.trim() === marker) fence = null;
      if (active) active.lines.push(line);
      continue;
    }
    if (!fence) {
      const heading = /^(#{1,6}) +(.+?)\s*$/u.exec(line);
      if (heading) {
        if (active && heading[1].length <= active.level) finish();
        const rule = /^rule: (.+)$/u.exec(heading[2]);
        if (rule) {
          finish();
          active = { id: rule[1], level: heading[1].length, lines: [] };
          continue;
        }
      }
    }
    if (active) active.lines.push(line);
  }
  finish();
  return rules;
}
