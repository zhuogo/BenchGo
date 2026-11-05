export function canRemoveState({ childStopped, mainConfigurationUnchanged, fatal, scenarios }) {
  return childStopped && mainConfigurationUnchanged && !fatal && scenarios.length > 0 && scenarios.every(row => row.status === 'pass');
}

export function assertNoCredentials(value, secrets) {
  const serialized = JSON.stringify(value);
  for (const secret of Object.values(secrets)) {
    if (secret && serialized.includes(secret)) throw new Error('Supplier credential must not be written to isolated configuration');
  }
}
