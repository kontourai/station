import Darwin
import Foundation
import Network
import SwiftRs
import Tauri
import UIKit

private class ScanArgs: Decodable { let scanId: String }

/// No network request is sent to a discovered endpoint. Bonjour's resolved
/// host and port are routing hints, never an authenticated Station identity.
private final class DiscoveryScan: NSObject, NetServiceDelegate {
  let id: String
  private let invoke: Invoke
  private var browser: NWBrowser?
  private var deadline: DispatchWorkItem?
  private var services: [String: NetService] = [:]
  private var candidates: [String: JsonObject] = [:]
  private var resolved = Set<String>()
  private var resolutionFailed = false
  private var finished = false
  private var becameReady = false
  private var permissionNeeded = false

  init(id: String, invoke: Invoke) { self.id = id; self.invoke = invoke }

  func start() {
    let browser = NWBrowser(for: .bonjour(type: "_station._tcp", domain: nil), using: .tcp)
    self.browser = browser
    browser.stateUpdateHandler = { [weak self] state in
      guard let self, !self.finished else { return }
      switch state {
      case .ready: self.becameReady = true; self.permissionNeeded = false
      case .waiting(let error), .failed(let error):
        if case .dns(let code) = error, code == -65570 {
          self.permissionNeeded = true
        } else if case .posix(let code) = error, code == .EACCES || code == .EPERM {
          self.permissionNeeded = true
        } else { self.finish("unavailable") }
      default: break
      }
    }
    browser.browseResultsChangedHandler = { [weak self] results, _ in
      guard let self, !self.finished else { return }
      var present = Set<String>()
      for result in results.prefix(32) {
        guard case let .service(name, type, domain, _) = result.endpoint,
          type == "_station._tcp." || type == "_station._tcp" else { continue }
        let key = "\(name)|\(type)|\(domain)"
        present.insert(key)
        guard self.services[key] == nil else { continue }
        let service = NetService(domain: domain, type: type, name: name)
        service.delegate = self
        self.services[key] = service
        service.resolve(withTimeout: 3)
      }
      for (key, service) in self.services where !present.contains(key) {
        service.stop()
        self.services.removeValue(forKey: key)
        self.candidates.removeValue(forKey: key)
        self.resolved.remove(key)
      }
    }
    let deadline = DispatchWorkItem { [weak self] in
      guard let self else { return }
      let status: String
      if self.permissionNeeded { status = "permission-required" }
      else if !self.candidates.isEmpty { status = "available" }
      else if !self.becameReady || self.resolved.count < self.services.count { status = "timed-out" }
      else if self.resolutionFailed { status = "failed" }
      else { status = "empty" }
      self.finish(status)
    }
    self.deadline = deadline
    DispatchQueue.main.asyncAfter(deadline: .now() + 15, execute: deadline)
    browser.start(queue: .main)
  }

  func netServiceDidResolveAddress(_ sender: NetService) {
    guard !finished, sender.port > 0, sender.port <= 65535,
      let key = services.first(where: { $0.value === sender })?.key else { return }
    resolved.insert(key)
    let txt = sender.txtRecordData().map(NetService.dictionary(fromTXTRecord:)) ?? [:]
    guard txt["v"].flatMap({ String(data: $0, encoding: .utf8) }) == "1",
      let transport = txt["transport"].flatMap({ String(data: $0, encoding: .utf8) }),
      transport == "http" || transport == "https" else { return }
    for data in sender.addresses ?? [] {
      let host: String? = data.withUnsafeBytes { bytes in
        guard let address = bytes.baseAddress?.assumingMemoryBound(to: sockaddr.self),
          address.pointee.sa_family == sa_family_t(AF_INET) || address.pointee.sa_family == sa_family_t(AF_INET6) else { return nil }
        var name = [CChar](repeating: 0, count: Int(NI_MAXHOST))
        guard getnameinfo(address, socklen_t(data.count), &name, socklen_t(name.count), nil, 0, NI_NUMERICHOST) == 0 else { return nil }
        return String(cString: name)
      }
      guard let host, !host.contains("%") else { continue }
      let parts = host.split(separator: ".").compactMap { Int($0) }
      let privateV4 = parts.count == 4 && (parts[0] == 10 || (parts[0] == 172 && (16...31).contains(parts[1])) || (parts[0] == 192 && parts[1] == 168) || (parts[0] == 169 && parts[1] == 254))
      let privateV6 = host.lowercased().hasPrefix("fc") || host.lowercased().hasPrefix("fd")
      guard privateV4 || privateV6 else { continue }
      candidates[key] = ["name": String(sender.name.prefix(100)), "host": host, "port": sender.port, "transport": transport]
      break
    }
  }

  func netService(_ sender: NetService, didNotResolve errorDict: [String: NSNumber]) {
    guard !finished, let key = services.first(where: { $0.value === sender })?.key else { return }
    resolved.insert(key)
    resolutionFailed = true
  }

  func finish(_ status: String) {
    guard !finished else { return }
    finished = true
    deadline?.cancel()
    deadline = nil
    browser?.cancel()
    browser = nil
    for service in services.values { service.stop(); service.delegate = nil }
    services.removeAll()
    invoke.resolve(["status": status, "candidates": status == "available" ? Array(candidates.values) : []])
    candidates.removeAll()
  }
}

class StationDiscoveryPlugin: Plugin {
  private var cancelledIds: [String] = []
  private var scan: DiscoveryScan?
  private var backgroundObserver: NSObjectProtocol?

  override init() {
    super.init()
    backgroundObserver = NotificationCenter.default.addObserver(forName: UIApplication.didEnterBackgroundNotification, object: nil, queue: .main) { [weak self] _ in
      self?.scan?.finish("cancelled")
      self?.scan = nil
    }
  }
  deinit {
    if let observer = backgroundObserver { NotificationCenter.default.removeObserver(observer) }
    scan?.finish("cancelled")
  }
  @objc public func discover(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScanArgs.self)
    DispatchQueue.main.async {
      guard !args.scanId.isEmpty, args.scanId.count <= 100 else { invoke.reject("Invalid discovery request"); return }
      if let cancelled = self.cancelledIds.firstIndex(of: args.scanId) {
        self.cancelledIds.remove(at: cancelled)
        invoke.resolve(["status": "cancelled", "candidates": []]); return
      }
      self.scan?.finish("cancelled")
      let scan = DiscoveryScan(id: args.scanId, invoke: invoke)
      self.scan = scan
      scan.start()
    }
  }
  @objc public func cancel(_ invoke: Invoke) throws {
    let args = try invoke.parseArgs(ScanArgs.self)
    DispatchQueue.main.async {
      if self.scan?.id == args.scanId { self.scan?.finish("cancelled"); self.scan = nil }
      else if args.scanId.count <= 100 {
        self.cancelledIds.append(args.scanId)
        if self.cancelledIds.count > 32 { self.cancelledIds.removeFirst() }
      }
      invoke.resolve()
    }
  }
}
@_cdecl("init_plugin_station_discovery")
func initPlugin() -> Plugin { StationDiscoveryPlugin() }
