package io.kontourai.station.agentactivity

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** #2588: a sealed Station notification, and what the phone does with each delivery. */
class StationNotificationsTest {
  /**
   * NATIVE_PUSH_NOTIFICATION_TEST_VECTOR from @kontourai/station-contracts/native-push: the Station's own sealer output.
   * A copy, pinned to the contract by agent-activity-seal.test.ts on the server side: update both together.
   */
  private val payloadKey = "AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8"
  private val registrationId = "AAECAwQFBgcICQoLDA0ODw"
  private val stationSealed =
    "DA0ODxAREhMUFRYX49wf-kVUzXEbCD2m9Pl5jjEh18zHTAqbqpPL0cmR8csd2l4U0PQLWS7CP3_fnSvrvWeK4JjFJYJs01g13s9w" +
      "mnVFNKKX278wgRHYFW08OrgLCuBlOr9uUrQX7apywVfvl4_8nFRCNsFLtwnkme5WnxdOEBybGkgQAITmtkGfi0pGxdFfMSn0EWW9" +
      "coEptTZP-q9-Z_e4oGlNwX_reD16cy4LPIm8HHztnP__FO2bi78BGsjrQ51YuzZETY-qsIUKnJEh3xt1dgueHC-vAXJ-dq9-u2E4" +
      "Ydx8HMKN9uLGkQxyvT9KVw-We2VSvf_D1boEwL-8GUoYB6EinIib_WbSBtR9Mg6zhXQ76mlxocHnBmdHYe4MSijiK_jHxyIao_bZ" +
      "5HD5gmGWv3GPpFkv5SUPNvWcqfZYQnkkLRxhRvnn"
  private val stationId = "11111111-1111-4111-8111-111111111111"
  private val stationKey = "K".repeat(43)
  private val registration = Registration(registrationId, stationId, stationKey, payloadKey)
  private val push = mapOf(
    "station_kind" to "station_notification",
    "device_id" to registrationId,
    "station_key" to stationKey,
    "sealed" to stationSealed,
  )
  private val sentAt = 1_800_000_000_000L

  private fun alert(createdAt: Long = sentAt, id: String = "notification-0001") =
    StationNotification(id, false, "Title", "", NotificationUrgency.ATTENTION, createdAt, createdAt + 3_600_000, null)

  private fun retract(createdAt: Long, id: String = "notification-0001") =
    StationNotification(id, true, "", "", NotificationUrgency.INFO, createdAt, createdAt + 3_600_000, null)

  @Test
  fun opensTheStationsNotificationVector() {
    val fields = unseal(payloadKey, registrationId, stationSealed, NOTIFICATION_AAD_PREFIX + registrationId)
    assertEquals("alert", fields?.get("kind"))
    assertEquals("Fix the flaky login test · Login App", fields?.get("body"))
    val notification = openStationNotification(registration, push)
    assertEquals(
      StationNotification(
        id = "notification-0001",
        retract = false,
        title = "Approval needed",
        body = "Fix the flaky login test · Login App",
        urgency = NotificationUrgency.ATTENTION,
        createdAt = sentAt,
        expiresAt = sentAt + 3_600_000,
        route = SessionRoute(stationId, "thread-1", "login-app")
      ),
      notification
    )
  }

  @Test
  fun onlyItsOwnStationKindAndRegistrationOpenIt() {
    // Under the card's AAD the same bytes do not authenticate, and the reverse.
    assertNull(unseal(payloadKey, registrationId, stationSealed))
    val card = "AAECAwQFBgcICQoLPCCjaKCXnXLpY62pgNhJXLLntgXdSm5NCUrRtCxYLYowIZ_RnvAjqUWVTty5thkJzHVC-Cqywq"
    assertNull(openStationNotification(registration, push + ("sealed" to card)))
    assertNull("another Station key", openStationNotification(registration, push + ("station_key" to "J".repeat(43))))
    assertNull("another registration", openStationNotification(registration, push + ("device_id" to "reg_0123456789abcdef")))
    assertNull(
      "another Station",
      openStationNotification(registration.copy(stationId = "22222222-2222-4222-8222-222222222222"), push)
    )
  }

  @Test
  fun aDuplicateIdIsDropped() {
    val (first, history) = NotificationHistory(emptyList()).decide(alert(), sentAt)
    assertEquals(NotificationAction.POST, first)
    // FCM redelivers, or the Station's send is retried: the same delivery again.
    assertEquals(NotificationAction.DROP, history.decide(alert(), sentAt + 1).first)
    // Persisted: the refusal survives a reload of the stored history.
    assertEquals(NotificationAction.DROP, NotificationHistory.parse(history.serialize()).decide(alert(), sentAt + 1).first)
    // A later delivery of the same id (re-delivered, or edited) replaces it.
    assertEquals(NotificationAction.POST, history.decide(alert(sentAt + 5_000), sentAt + 5_000).first)
    // Another id is its own notification.
    assertEquals(NotificationAction.POST, history.decide(alert(id = "notification-0002"), sentAt + 1).first)
  }

  @Test
  fun aRetractCancelsAndTheAlertItRetractedCannotComeBack() {
    val (_, shown) = NotificationHistory(emptyList()).decide(alert(), sentAt)
    val (action, retracted) = shown.decide(retract(sentAt + 2_000), sentAt + 2_000)
    assertEquals(NotificationAction.CANCEL, action)
    // FCM does not order messages: the original alert arriving late stays retracted.
    assertEquals(NotificationAction.DROP, retracted.decide(alert(), sentAt + 3_000).first)
    // A retract that overtook its own alert still cancels, and the alert is dropped.
    val (early, beforeAlert) = NotificationHistory(emptyList()).decide(retract(sentAt + 2_000), sentAt)
    assertEquals(NotificationAction.CANCEL, early)
    assertEquals(NotificationAction.DROP, beforeAlert.decide(alert(), sentAt + 3_000).first)
    // Retracting again is harmless.
    assertEquals(NotificationAction.CANCEL, retracted.decide(retract(sentAt + 2_000), sentAt + 4_000).first)
  }

  @Test
  fun anExpiredOrFutureDatedAlertIsNotShown() {
    val empty = NotificationHistory(emptyList())
    assertEquals(NotificationAction.DROP, empty.decide(alert(), sentAt + 3_600_000).first)
    assertEquals(NotificationAction.DROP, empty.decide(alert(sentAt + 11 * 60_000), sentAt).first)
    assertEquals(NotificationAction.POST, empty.decide(alert(), sentAt + 3_599_999).first)
  }

  @Test
  fun theHistoryIsBoundedAndRevalidated() {
    var history = NotificationHistory(emptyList())
    for (i in 1..(NOTIFICATION_HISTORY + 5)) history = history.decide(alert(id = "n-$i"), sentAt).second
    assertEquals(NOTIFICATION_HISTORY, history.seen.size)
    assertEquals(NotificationAction.DROP, history.decide(alert(id = "n-${NOTIFICATION_HISTORY + 5}"), sentAt).first)
    assertTrue(NotificationHistory.parse(null).seen.isEmpty())
    assertTrue(NotificationHistory.parse("bad id with spaces\t1\nok\tnot-a-number").seen.isEmpty())
    assertNotNull(NotificationHistory.parse("ok\t1").seen.singleOrNull())
  }
}
