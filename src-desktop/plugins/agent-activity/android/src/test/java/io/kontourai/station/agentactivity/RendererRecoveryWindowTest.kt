package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Test

class RendererRecoveryWindowTest {
  @Test fun stopsRepeatedCrashesAcrossClientsAndAllowsExplicitReloadOrWindowExpiry() {
    val window = RendererRecoveryWindow()
    var recreated = 0
    var errors = 0
    // Each closure represents a fresh client after Activity.recreate().
    repeat(5) { window.recover(1_000L + it, { recreated++ }, { errors++ }) }
    assertEquals(3, recreated)
    assertEquals(2, errors)
    window.recover(61_000, { recreated++ }, { errors++ })
    assertEquals(4, recreated)
    window.reset()
    repeat(3) { window.recover(61_000, { recreated++ }, { errors++ }) }
    assertEquals(7, recreated)
    assertEquals(2, errors)
  }
}
