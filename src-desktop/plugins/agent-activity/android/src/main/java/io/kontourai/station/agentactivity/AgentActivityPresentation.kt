// Adapted from T3 Code (https://github.com/pingdotgg/t3code,
// apps/mobile/modules/t3-agent-notifications), MIT License,
// Copyright (c) 2026 T3 Tools Inc.

package io.kontourai.station.agentactivity

import android.content.Context
import android.graphics.Typeface
import android.text.SpannableStringBuilder
import android.text.Spanned
import android.text.style.ForegroundColorSpan
import android.text.style.StyleSpan
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

private fun ActivityPhase.color() = when (this) {
  ActivityPhase.STARTING, ActivityPhase.RUNNING -> R.color.agent_activity_working
  ActivityPhase.APPROVAL -> R.color.agent_activity_attention
  ActivityPhase.INPUT -> R.color.agent_activity_input
  ActivityPhase.STALE -> R.color.agent_activity_waiting
  ActivityPhase.COMPLETED -> R.color.agent_activity_done
  ActivityPhase.FAILED -> R.color.agent_activity_failed
}

/**
 * The header carries the state, the title says what needs you (or which
 * thread, when there is only one), and the body lists every thread with its
 * status in front. System UI renders all of it, so one builder serves the
 * shade, the lock screen and the status-bar chip.
 */
internal fun ActivityModel.applyTo(builder: NotificationCompat.Builder, context: Context) {
  val tint = phase?.let { ContextCompat.getColor(context, it.color()) }
  builder.setSmallIcon(R.drawable.agent_activity_mark)
  if (tint != null) builder.setColor(tint)
  // Tint the summary only when it names an outcome or a request; a plain
  // "3 working" stays neutral so the accent keeps meaning something.
  val tintedSummary = tint != null && rows.size > 1 &&
    phase != ActivityPhase.RUNNING && phase != ActivityPhase.STARTING
  builder.setContentTitle(if (tintedSummary) tinted(summary, tint!!) else summary)
  if (rows.size > 1) {
    builder.setSubText(
      listOfNotNull(
        hero!!.project.takeIf { singleProject && it.isNotBlank() },
        if (activeCount > 0) "$activeCount active" else "$threadCount threads"
      ).joinToString(" · ")
    )
  }
  val body = body(context)
  // The collapsed card gets the priority row; the expanded card gets them all.
  val lineBreak = body.indexOf('\n')
  val firstLine = if (lineBreak >= 0) body.subSequence(0, lineBreak) else body
  builder.setContentText(firstLine).setStyle(NotificationCompat.BigTextStyle().bigText(body))
  // Thread timestamps change while an approval stays pending, so a timer
  // would restart on every update. Hide it until there is a phase-entry time.
  builder.setShowWhen(false).setUsesChronometer(false)
}

private fun ActivityModel.body(context: Context): CharSequence {
  val hero = hero ?: return ""
  // A single thread is already named by the title; the body only needs its status and project.
  if (rows.size == 1) return statusLine(context, hero.copy(title = hero.project), "")
  return SpannableStringBuilder().apply {
    rows.forEachIndexed { index, row ->
      if (index > 0) append("\n")
      append(statusLine(context, row, row.project.takeUnless { singleProject }.orEmpty()))
    }
  }
}

private fun statusLine(context: Context, row: ActivityRow, trailing: String): CharSequence =
  SpannableStringBuilder().apply {
    val color = ContextCompat.getColor(
      context,
      ActivityPhase.forStatus(row.status)?.color() ?: R.color.agent_activity_waiting
    )
    append(tinted(row.status, color, bold = true))
    append(" ").append(row.title)
    // Promoted cards drop text colour, so the separator does the dimming.
    if (trailing.isNotBlank()) {
      val start = length
      append(" · ").append(trailing)
      setSpan(
        ForegroundColorSpan(ContextCompat.getColor(context, R.color.agent_activity_waiting)),
        start,
        length,
        Spanned.SPAN_EXCLUSIVE_EXCLUSIVE
      )
    }
  }

private fun tinted(text: String, color: Int, bold: Boolean = false) =
  SpannableStringBuilder(text).apply {
    setSpan(ForegroundColorSpan(color), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
    if (bold) setSpan(StyleSpan(Typeface.BOLD), 0, length, Spanned.SPAN_EXCLUSIVE_EXCLUSIVE)
  }
