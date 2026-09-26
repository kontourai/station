package io.kontourai.station.agentactivity

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/*
 * Android styling for an agent-activity card. What the card says is decided
 * in AgentActivityModel ([cardText]); this file only colours it and hands it
 * to the notification builder. The shade, the lock screen and the status-bar
 * chip are all rendered by System UI from this one builder.
 */

/** The colour resource for each phase, used for the accent and for row labels. */
private val PHASE_COLORS = mapOf(
  ActivityPhase.STARTING to R.color.agent_activity_working,
  ActivityPhase.RUNNING to R.color.agent_activity_working,
  ActivityPhase.APPROVAL to R.color.agent_activity_attention,
  ActivityPhase.INPUT to R.color.agent_activity_input,
  ActivityPhase.STALE to R.color.agent_activity_waiting,
  ActivityPhase.COMPLETED to R.color.agent_activity_done,
  ActivityPhase.FAILED to R.color.agent_activity_failed,
)

private fun Context.phaseColor(phase: ActivityPhase?): Int =
  ContextCompat.getColor(this, phase?.let { PHASE_COLORS.getValue(it) } ?: R.color.agent_activity_waiting)

private fun SpannableStringBuilder.spanAll(what: Any, from: Int = 0) {
  setSpan(what, from, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
}

/**
 * Writes the card's icon, accent, title, sub-text and body into [builder].
 * The collapsed card shows the first body line; the expanded card shows
 * every line.
 */
internal fun ActivityModel.applyTo(builder: NotificationCompat.Builder, context: Context) {
  val text = cardText()
  builder.setSmallIcon(R.drawable.agent_activity_mark)
  val accent = phase?.let { context.phaseColor(it) }
  if (accent != null) builder.setColor(accent)

  val title: CharSequence = if (text.accentTitle && accent != null) {
    SpannableStringBuilder(text.title).apply { spanAll(ForegroundColorSpan(accent)) }
  } else {
    text.title
  }
  builder.setContentTitle(title)
  if (text.subText != null) builder.setSubText(text.subText)

  val body = renderLines(context, text.lines)
  val newline = body.indexOf('\n')
  builder.setContentText(if (newline < 0) body else body.subSequence(0, newline))
  builder.setStyle(NotificationCompat.BigTextStyle().bigText(body))
  // Row timestamps move while an approval sits pending, so a timer would
  // keep restarting. No timer until the payload carries a phase-entry time.
  builder.setShowWhen(false)
  builder.setUsesChronometer(false)
}

private fun renderLines(context: Context, lines: List<CardLine>): CharSequence {
  if (lines.isEmpty()) return ""
  val out = SpannableStringBuilder()
  lines.forEachIndexed { index, line ->
    if (index > 0) out.append('\n')
    out.append(renderLine(context, line))
  }
  return out
}

private fun renderLine(context: Context, line: CardLine): CharSequence {
  val out = SpannableStringBuilder()
  val label = SpannableStringBuilder(line.status).apply {
    spanAll(ForegroundColorSpan(context.phaseColor(ActivityPhase.forStatus(line.status))))
    spanAll(StyleSpan(Typeface.BOLD))
  }
  out.append(label).append(' ').append(line.text)
  if (line.suffix.isNotBlank()) {
    // Promoted cards drop text colour, so the " · " separator is what sets
    // the suffix apart there; elsewhere it is also dimmed.
    val from = out.length
    out.append(" · ").append(line.suffix)
    out.spanAll(ForegroundColorSpan(ContextCompat.getColor(context, R.color.agent_activity_waiting)), from)
  }
  return out
}
