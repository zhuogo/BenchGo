export const INTERACTIVE_PROMPT = `When a form, comparison, chart or explicit choice would help the user, you may include a fenced benchgo-ui JSON block beside ordinary prose. Use only this BenchGo UI v1 protocol (not OpenTiny schema expressions): {"version":1,"title":"short title","blocks":[...]}. Block types:
- form: {"id":"f","type":"form","title":"Requirements","fields":[{"id":"name","type":"text","label":"Name","required":true}],"submitLabel":"Send answer"}. Field types: text, textarea, number (optional min/max/step), date, checkbox, select (options:[{label,value}]).
- choices: {"id":"c","type":"choices","title":"Choose","options":[{"label":"Option A","value":"a"}]}.
- table: {"id":"t","type":"table","columns":["Name","Count"],"rows":[["Actual item",3]]}.
- chart: {"id":"g","type":"chart","title":"Actual data","kind":"bar" or "line","unit":"unit","data":[{"label":"Actual label","value":3}]}.
Use at most 12 blocks, 30 form fields, 100 chart points and 200 table rows; keep JSON under 12000 characters so the reply fits the publication limit. No scripts, expressions, HTML, network actions, or arbitrary components. Values come from real supplied data; do not invent data. Forms and choices submit an ordinary user message, never grant approval or execute an action themselves. Do not use interactive blocks for permission approval, secrets, or passwords. Plain answers stay plain. When a channel cannot render the block, include a short plain-text equivalent. Unsupported formats show an error, so use only the schema above.`;

export function mountInteractivePrompt(ctx) {
  // systemPrompt lives in each Agent scope, not the host base context. The
  // official lifecycle dispatch completes before the first queued turn runs.
  ctx.inject(['agents'], child => {
    const installed = new Map();
    const attach = agent => {
      if (!agent?.ctx?.systemPrompt || installed.has(agent)) return;
      installed.set(agent, agent.ctx.systemPrompt.section({ name: 'benchgo:interactive', order: 80, interpolate: false, text: INTERACTIVE_PROMPT }));
    };
    child.on('agent/created', ({ agent }) => { attach(agent); });
    child.on('agent/disposed', ({ agent }) => { installed.get(agent)?.(); installed.delete(agent); });
    child.effect(() => {
      for (const agent of child.agents.list()) attach(agent);
      return () => { for (const dispose of installed.values()) dispose(); installed.clear(); };
    });
  });
}
