package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2515 review: a tap opens a session only by redeeming a nonce this phone issued, once. */
class TapLedgerTest {
  private val route = SessionRoute("station-1", "thread-1", "login-app")
  private val now = 1_800_000_000_000L
  private fun nonce(n: Int) = "%032x".format(n)
  private val card = "activity:reg-1"
  private val empty = TapLedger(emptyList())

  @Test
  fun anIssuedNonceIsRedeemedOnceAndAReplayIsRefused() {
    val issued = empty.issue(card, 7, route, nonce(1), now)
    val redeemed = issued.redeem(nonce(1), now + 1, nonce(2))
    assertEquals(route, redeemed?.route)
    // A launch intent restored after process death replays nonce 1.
    assertNull(redeemed!!.ledger.redeem(nonce(1), now + 2, nonce(3)))
    // Persisted: the refusal survives a reload of the stored ledger.
    assertNull(TapLedger.parse(redeemed.ledger.serialize()).redeem(nonce(1), now + 2, nonce(3)))
  }

  @Test
  fun tappingTheSameCardAgainRedeemsTheReissuedNonce() {
    val first = empty.issue(card, 7, route, nonce(1), now).redeem(nonce(1), now + 1, nonce(2))!!
    assertEquals(IssuedTap(nonce(2), card, 7, route, now + 1), first.reissued)
    // The card's PendingIntent now carries nonce 2 (re-armed with FLAG_UPDATE_CURRENT).
    val second = TapLedger.parse(first.ledger.serialize()).redeem(nonce(2), now + 2, nonce(3))
    assertEquals(route, second?.route)
    assertEquals(7, second?.reissued?.requestCode)
    assertEquals(card, second?.reissued?.identity)
  }

  @Test
  fun unknownOrMalformedNoncesOpenNothing() {
    val issued = empty.issue(card, 7, route, nonce(0xab), now)
    assertNotNull(issued.redeem(nonce(0xab), now, nonce(2)))
    assertNull(issued.redeem(nonce(9), now, nonce(2)))
    assertNull(issued.redeem(null, now, nonce(2)))
    assertNull(issued.redeem("", now, nonce(2)))
    assertNull(issued.redeem(nonce(0xab).uppercase(), now, nonce(2)))
    assertNull(issued.redeem(nonce(0xab) + "0", now, nonce(2)))
  }

  @Test
  fun aNonceExpiresWithTheLongestCardLifetime() {
    val issued = empty.issue(card, 7, route, nonce(1), now)
    assertNotNull(issued.redeem(nonce(1), now + TAP_LIFETIME_MS, nonce(2)))
    assertNull(issued.redeem(nonce(1), now + TAP_LIFETIME_MS + 1, nonce(2)))
    // A clock set back before issue does not make it live either.
    assertNull(issued.redeem(nonce(1), now - 1, nonce(2)))
  }

  @Test
  fun reissuingACardRetiresItsPreviousNonceButNotOtherNotifications() {
    val alert = "alert:reg-1:abc"
    val ledger = empty
      .issue(card, 7, route, nonce(1), now)
      .issue(alert, 8, route, nonce(2), now)
      .issue(card, 7, SessionRoute("station-1", "thread-2", null), nonce(3), now + 1)
    assertNull(ledger.redeem(nonce(1), now + 2, nonce(9)))
    assertEquals("thread-2", ledger.redeem(nonce(3), now + 2, nonce(9))?.route?.sessionId)
    assertEquals("thread-1", ledger.redeem(nonce(2), now + 2, nonce(9))?.route?.sessionId)
    // A card that stops naming a session stops opening one.
    assertNull(ledger.forget(card, now + 2).redeem(nonce(3), now + 2, nonce(9)))
  }

  @Test
  fun theLedgerIsBounded() {
    var ledger = empty
    for (i in 1..(MAX_TAPS + 5)) ledger = ledger.issue("alert:$i", i, route, nonce(i), now)
    assertEquals(MAX_TAPS, ledger.taps.size)
    assertNull(ledger.redeem(nonce(1), now, nonce(999)))
    assertNotNull(ledger.redeem(nonce(MAX_TAPS + 5), now, nonce(999)))
  }

  @Test
  fun storedEntriesAreRevalidated() {
    assertTrue(TapLedger.parse(null).taps.isEmpty())
    assertTrue(TapLedger.parse("not json").taps.isEmpty())
    val tampered = """[{"nonce":"${nonce(1)}","identity":"x","requestCode":1,"stationId":"s","sessionId":"../etc","projectSlug":null,"issuedAt":$now}]"""
    assertTrue(TapLedger.parse(tampered).taps.isEmpty())
    val roundTrip = TapLedger.parse(empty.issue(card, 7, SessionRoute("s", "t", null), nonce(1), now).serialize())
    assertEquals(listOf(IssuedTap(nonce(1), card, 7, SessionRoute("s", "t", null), now)), roundTrip.taps)
  }

  @Test
  fun onlyLaunchIntentsNotReplayedFromRecentsAreCardTaps() {
    assertTrue(isCardTapIntent("android.intent.action.MAIN", hasData = false, launchedFromHistory = false))
    assertFalse(isCardTapIntent("android.intent.action.VIEW", hasData = false, launchedFromHistory = false))
    assertFalse(isCardTapIntent(null, hasData = false, launchedFromHistory = false))
    assertFalse(isCardTapIntent("android.intent.action.MAIN", hasData = true, launchedFromHistory = false))
    assertFalse(isCardTapIntent("android.intent.action.MAIN", hasData = false, launchedFromHistory = true))
  }
}
