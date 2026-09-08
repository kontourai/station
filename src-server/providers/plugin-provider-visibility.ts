/** Issued only by the existing activation owner; never accepted from request JSON. */
export interface PluginProviderReadView {
  readonly __pluginProviderReadView: unique symbol;
}
export interface PluginProviderVisibility {
  ready(): boolean;
  permits(view: PluginProviderReadView): boolean;
}
