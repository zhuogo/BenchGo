export const petActionLibrary = Object.freeze({ acknowledge: '点头', focus: '侧倾', happy: '轻跃', waiting: '摇摆' });
export const petWorkEvents = Object.freeze({ idle: '待机', acknowledge: '回应', focus: '专注', waiting: '等待用户', completed: '完成' });
export const petActionForEvent = (pet, event) => pet?.appearance?.bindings?.[event] ?? (event === 'completed' ? 'happy' : event);
export const petActionOptions = pet => Object.entries({ ...petActionLibrary, ...Object.fromEntries(
  Object.entries(pet?.appearance?.actions || {}).map(([id, action]) => [id, action.label || id]),
) }).map(([value, label]) => ({ value, label }));
