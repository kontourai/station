/**
 * Production wiring for the plugin command effect coordinator (kontourai/
 * station#1418, #1419). This module (and the coordinator it wires) is
 * dynamically imported only when a plugin command row is actually chosen —
 * see `CommandPalette.tsx` — so it never lands in the eager entry chunk.
 */
import {
  admitPluginCommandEffect,
  settlePluginCommandEffects,
} from '@kontourai/station-sdk/client/plugin-command-effects';
import {
  createPluginCommandEffectCoordinator,
  type PluginCommandEffectCoordinator,
  type PluginCommandEffectTransport,
} from './plugin-command-effect-coordinator';
import { registerPluginCommandEffectAuthoritySwitchHandler } from './plugin-command-effect-switch-signal';

const transport: PluginCommandEffectTransport = {
  admit: (apiBase, pluginId, request, signal) =>
    admitPluginCommandEffect(apiBase, pluginId, request, { signal }),
  settle: (apiBase, request, options) =>
    settlePluginCommandEffects(apiBase, request, options),
};

let singleton: PluginCommandEffectCoordinator | null = null;

export function getPluginCommandEffectCoordinator(): PluginCommandEffectCoordinator {
  if (!singleton) {
    singleton = createPluginCommandEffectCoordinator({
      transport,
      storage: window.sessionStorage,
      windowLike: window,
    });
    registerPluginCommandEffectAuthoritySwitchHandler(() =>
      singleton?.resetForAuthorityChange(),
    );
  }
  return singleton;
}
