import { targetLocales } from '../locales.js';

export type Plugin = {
  name: string;
  translations?: Record<typeof targetLocales[number], string>;
  src: string;
  icon: string;
  requireDoc?: boolean;
  active?: boolean;
};

export type ConfigurePluginDetail = {
  name: string;
  kind: 'menu' | 'editor';
  config: Plugin | null;
};

export type ConfigurePluginEvent = CustomEvent<ConfigurePluginDetail>;

/** The combination of name and kind uniquely identifies the plugin to be configured.
 * If config is null, the plugin is removed. Otherwise, the plugin is added or reconfigured. */
export function newConfigurePluginEvent(
  name: string,
  kind: 'menu' | 'editor',
  config: Plugin | null
): ConfigurePluginEvent {
  return new CustomEvent<ConfigurePluginDetail>('oscd-configure-plugin', {
    bubbles: true,
    composed: true,
    detail: { name, kind, config },
  });
}

declare global {
  interface ElementEventMap {
    ['oscd-configure-plugin']: ConfigurePluginEvent;
  }
}
