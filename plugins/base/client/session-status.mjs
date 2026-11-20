/** Read the independent service on rc.5 and the owned field on earlier Hosts. */
export function sessionStatusSource(ctx) {
  const status = ctx?.get?.('uiSession.sessionStatus');
  if (status) return status;
  const session = ctx?.uiSession;
  return session && Object.hasOwn(session, 'sessionStatus') ? session.sessionStatus : undefined;
}
