/** Every cleanup runs; ownership transfers only after writers and stores stop. */
export async function cleanupAssistant({ halt = [], stop = [], detach = [], close = [], release }) {
  const errors = [];
  const run = async tasks => {
    const results = await Promise.allSettled(tasks.map(task => Promise.resolve().then(task)));
    for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
    return results.every(result => result.status === 'fulfilled');
  };
  const halted = await run(halt);
  const stopped = await run(stop);
  await run(detach);
  // Failed producer shutdown leaves its storage and lease intact rather than
  // granting a successor concurrent writes against an unverified old writer.
  if (halted && stopped) {
    const closed = await run(close);
    if (closed) await run([release]);
  }
  if (errors.length) throw new AggregateError(errors, 'SuperAgent 关闭失败');
}
