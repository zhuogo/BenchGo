export const SETTINGS_SHELL_SLOT = 'sidebar.settings';

export function findSettingsShell(slots) {
  return slots.entries(SETTINGS_SHELL_SLOT).find(entry =>
    entry.locale === 'settings' && entry.children?.['settings.launcher'],
  );
}

export function openSettingsSection(slots, id) {
  const actions = findSettingsShell(slots)?.store?.create().actions;
  if (!actions?.openSection) return false;
  actions.openSection(id);
  return true;
}
