package io.kontourai.station.agentactivity

/** Rust is already loaded before Wry installs the network observer. */
object NativeHttpNetwork {
  @JvmStatic external fun changed()
}
