export const fixtureRoute = (model = 'test/model') => ({ providerId: 'test-api', model });

export const fixtureRouteService = {
  async capture(value) { return { ...value, mode: 'managed' }; },
  async launch() { return {}; },
};

export const fixtureInstaller = { async resolveLaunch() { return { command: process.execPath, args: [] }; } };
