package io.kontourai.station.discovery

import android.app.Activity
import android.content.Context
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Build
import android.os.Handler
import android.os.Looper
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import org.json.JSONArray

@InvokeArg
class ScanArgs { lateinit var scanId: String }

/** System DNS-SD only: no subnet probes, connections, profile writes or trust. */
@TauriPlugin
class StationDiscoveryPlugin(private val activity: Activity) : Plugin(activity) {
  private val handler = Handler(Looper.getMainLooper())
  private val manager get() = activity.getSystemService(Context.NSD_SERVICE) as? NsdManager
  private val cancelledIds = ArrayDeque<String>()
  private var scan: Scan? = null

  private inner class Scan(val id: String, val invoke: Invoke, val nsd: NsdManager) : NsdManager.DiscoveryListener {
    var finished = false
    var started = false
    var resolutionFailed = false
    var resolving = false
    var resolver: NsdManager.ResolveListener? = null
    val pending = ArrayDeque<NsdServiceInfo>()
    val present = mutableSetOf<String>()
    val candidates = linkedMapOf<String, JSObject>()
    val deadline = Runnable { finish(if (candidates.isNotEmpty()) "available" else if (!started || resolving || pending.isNotEmpty()) "timed-out" else if (resolutionFailed) "failed" else "empty") }

    fun start() {
      handler.postDelayed(deadline, 5000)
      try { nsd.discoverServices("_station._tcp.", NsdManager.PROTOCOL_DNS_SD, this) }
      catch (_: SecurityException) { finish("permission-denied") }
      catch (_: Exception) { finish("unavailable") }
    }
    fun finish(status: String) {
      if (finished) return
      finished = true
      handler.removeCallbacks(deadline)
      try { nsd.stopServiceDiscovery(this) } catch (_: Exception) { }
      if (Build.VERSION.SDK_INT >= 34) { resolver?.let { try { nsd.stopServiceResolution(it) } catch (_: Exception) { } } }
      resolver = null
      pending.clear()
      invoke.resolve(JSObject().put("status", status).put("candidates", JSONArray(if (status == "available") candidates.values.toList() else emptyList<JSObject>())))
      candidates.clear()
      present.clear()
      if (scan === this) scan = null
    }
    override fun onDiscoveryStarted(type: String) { handler.post { if (!finished) started = true } }
    override fun onDiscoveryStopped(type: String) { handler.post { if (!finished) finish("cancelled") } }
    override fun onStartDiscoveryFailed(type: String, code: Int) { handler.post { finish("unavailable") } }
    override fun onStopDiscoveryFailed(type: String, code: Int) { handler.post { if (!finished) finish("failed") } }
    override fun onServiceFound(service: NsdServiceInfo) { handler.post {
      if (!finished && (service.serviceType == "_station._tcp." || service.serviceType == "_station._tcp") && present.size < 32 && present.add(service.serviceName)) {
        pending.add(service)
        resolveNext()
      }
    } }
    override fun onServiceLost(service: NsdServiceInfo) { handler.post {
      present.remove(service.serviceName)
      candidates.remove(service.serviceName)
      pending.removeAll { it.serviceName == service.serviceName }
    } }
    @Suppress("DEPRECATION")
    fun resolveNext() {
      if (finished || resolving || pending.isEmpty()) return
      val service = pending.removeFirst()
      resolving = true
      val listener = object : NsdManager.ResolveListener {
        override fun onResolveFailed(info: NsdServiceInfo, code: Int) { handler.post { resolutionFailed = true; resolver = null; resolving = false; resolveNext() } }
        override fun onServiceResolved(info: NsdServiceInfo) { handler.post {
          if (!finished && present.contains(info.serviceName)) {
            val host = info.host
            val transport = info.attributes["transport"]?.toString(Charsets.UTF_8)
            if (info.attributes["v"]?.toString(Charsets.UTF_8) == "1" && (transport == "http" || transport == "https") && host != null && !host.isLoopbackAddress && !host.isAnyLocalAddress && !host.isMulticastAddress && (host.isSiteLocalAddress || host.isLinkLocalAddress || (host.address.size == 16 && (host.address[0].toInt() and 0xfe) == 0xfc)) && info.port in 1..65535) {
              val address = host.hostAddress
              if (address != null && !address.contains('%')) {
                candidates[info.serviceName] = JSObject().put("name", info.serviceName.take(100)).put("host", address).put("port", info.port).put("transport", transport)
              }
            }
          }
          resolving = false
          resolveNext()
        } }
      }
      resolver = listener
      try { nsd.resolveService(service, listener) } catch (_: SecurityException) { finish("permission-denied") }
      catch (_: Exception) { resolver = null; resolving = false; resolveNext() }
    }
  }

  @Command
  fun discover(invoke: Invoke) {
    val args = invoke.parseArgs(ScanArgs::class.java)
    handler.post {
      if (args.scanId.isEmpty() || args.scanId.length > 100) { invoke.reject("Invalid discovery request"); return@post }
      if (cancelledIds.remove(args.scanId)) { invoke.resolve(JSObject().put("status", "cancelled").put("candidates", JSONArray())); return@post }
      scan?.finish("cancelled")
      val nsd = manager
      if (Build.VERSION.SDK_INT < 34 || nsd == null) { invoke.resolve(JSObject().put("status", "unavailable").put("candidates", JSONArray())); return@post }
      Scan(args.scanId, invoke, nsd).also { scan = it; it.start() }
    }
  }
  @Command
  fun cancel(invoke: Invoke) {
    val args = invoke.parseArgs(ScanArgs::class.java)
    handler.post {
      if (scan?.id == args.scanId) scan?.finish("cancelled")
      else if (args.scanId.length <= 100) { cancelledIds.add(args.scanId); if (cancelledIds.size > 32) cancelledIds.removeFirst() }
      invoke.resolve()
    }
  }
  override fun onPause() { handler.post { scan?.finish("cancelled") } }
  override fun onDestroy() { handler.post { scan?.finish("cancelled") } }
}
