/** The official workspace clears its main reference even when a separate panel is showing. */
export function preservePanelOnSessionArchive({ layout, sessions, workspaces }) {
  const isMain = session => (session?.retainedBy?.mainView ?? 0) > 0;
  const readSessions = () => sessions.list.getSnapshot().byId;
  const findMain = byId => Object.values(byId).find(isMain)?.id;
  let mainId = findMain(readSessions());
  let panelToKeep;

  const stopSessions = sessions.list.subscribe(() => {
    const byId = readSessions();
    if (isMain(byId[mainId])) return;
    const released = mainId;
    mainId = findMain(byId);
    if (mainId) panelToKeep = undefined;
    if (mainId || !released || !workspaces.list.getSnapshot().archivedSessionIds.includes(released)) return;

    panelToKeep = layout.panelInfo.getSnapshot().activePanelId;
    // The official workspace releases its reference and clears the panel in the same call.
    queueMicrotask(() => { panelToKeep = undefined; });
  });
  const stopPanel = layout.panelInfo.subscribe(() => {
    const active = layout.panelInfo.getSnapshot().activePanelId;
    if (panelToKeep == null || active === panelToKeep) return;
    const panel = panelToKeep;
    panelToKeep = undefined;
    if (active === null) layout.selectPanel(panel);
  });
  return () => { stopPanel(); stopSessions(); };
}
