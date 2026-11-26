import * as sidebar from 'benchgo-workbench-vendor:sidebar';
import { contextFacade } from '../src/boundary.mjs';
import { mountWorkbenchPreviews } from './previews.jsx';

export function mountLocalWorkbench(ctx, runtime, update) {
  ctx.inject(sidebar.inject, child => {
    const provide = (name, service) => {
      if (name === 'betterSidebar') {
        const register = service.registerTab.bind(service);
        service.registerTab = descriptor => {
          if (['sidechat', 'subagent'].includes(descriptor.id)) return () => {};
          const { settings, ...builtin } = descriptor;
          return register(builtin);
        };
        runtime.sidebar = service;
        update({ sidebar: true });
      }
      return child.provide(name, service);
    };
    const slots = new Proxy(child.slots, { get(target, key) {
      if (key === 'inject') return (name, callback) => name.startsWith('settings.') ? () => {} : target.inject(name, callback);
      if (key === 'register') return (options, component) => options.name.startsWith('settings.') ? () => {} : target.register(options, component);
      const value = target[key];
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    child.effect(() => () => { runtime.sidebar = null; update({ sidebar: false }); });
    sidebar.apply(contextFacade(child, { provide, slots }));
    if (runtime.sidebar) mountWorkbenchPreviews(child, runtime.sidebar);
  });
}
