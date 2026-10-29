package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Test

class RendererRecoveryWindowTest {
  @Test fun backgroundKillsCoalesceUntilForegroundWithoutSpendingReloads() {
    val window = RendererRecoveryWindow()
    var recreated = 0
    var errors = 0
    repeat(8) { window.recover(it.toLong(), false, { recreated++ }, { errors++ }) }
    assertEquals(0, recreated)
    assertEquals(0, errors)
    window.foreground(100, { recreated++ }, { errors++ })
    window.foreground(101, { recreated++ }, { errors++ })
    repeat(2) { window.recover(102L + it, true, { recreated++ }, { errors++ }) }
    assertEquals(3, recreated)
    assertEquals(0, errors)
    window.recover(104, true, { recreated++ }, { errors++ })
    assertEquals(1, errors)
  }

  @Test fun stopsRepeatedCrashesAcrossClientsAndAllowsExplicitReloadOrWindowExpiry() {
    val window = RendererRecoveryWindow()
    var recreated = 0
    var errors = 0
    // Each closure represents a fresh client after Activity.recreate().
    repeat(5) { window.recover(1_000L + it, true, { recreated++ }, { errors++ }) }
    assertEquals(3, recreated)
    assertEquals(2, errors)
    window.recover(61_000, true, { recreated++ }, { errors++ })
    assertEquals(4, recreated)
    window.reset()
    repeat(3) { window.recover(61_000, true, { recreated++ }, { errors++ }) }
    assertEquals(7, recreated)
    assertEquals(2, errors)
  }
}
