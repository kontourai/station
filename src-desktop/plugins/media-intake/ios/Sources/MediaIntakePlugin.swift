import Foundation
import SwiftRs
import Tauri
import UIKit
import UniformTypeIdentifiers

/// The chat-attachment contract's bounds
/// (`packages/contracts/src/chat-attachment.ts`), pinned there by
/// `src-ui/src/platform/native/__tests__/media-intake-native-limits.test.ts`.
let maxImageCount = 5
let maxImageBytes = 5 * 1024 * 1024
let maxTotalImageBytes = 15 * 1024 * 1024
let maxImageNameLength = 160

private struct IntakeRefused: Error { let message: String }

/// The admitted representations, in preference order, with the MIME type and
/// extension each is delivered as. HEIC, TIFF and other types are not
/// admitted by the contract and are never offered.
private let admittedTypes: [(uti: String, mimeType: String, ext: String)] = [
  (UTType.png.identifier, "image/png", "png"),
  (UTType.jpeg.identifier, "image/jpeg", "jpg"),
  (UTType.gif.identifier, "image/gif", "gif"),
  (UTType.webP.identifier, "image/webp", "webp"),
]

/// Mirrors the contract's `sniffChatImageMimeType`: the delivered type comes
/// from the bytes, not from the pasteboard's claim.
func sniffImageMimeType(_ data: Data) -> String? {
  let head = [UInt8](data.prefix(12))
  func at(_ index: Int) -> Int { index < head.count ? Int(head[index]) : -1 }
  func starts(_ bytes: [Int]) -> Bool { bytes.enumerated().allSatisfy { at($0.offset) == $0.element } }
  if starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) { return "image/png" }
  if starts([0xff, 0xd8, 0xff]) { return "image/jpeg" }
  if starts([0x47, 0x49, 0x46, 0x38]) && (at(4) == 0x37 || at(4) == 0x39) && at(5) == 0x61 { return "image/gif" }
  if starts([0x52, 0x49, 0x46, 0x46]) && at(8) == 0x57 && at(9) == 0x45 && at(10) == 0x42 && at(11) == 0x50 {
    return "image/webp"
  }
  return nil
}

/// Clipboard image reads. `takeSharedImages` answers an empty list until the
/// iOS Share Extension lands; the native host reports `image-share-intake`
/// disabled on iOS, so the web layer does not call it in practice.
class MediaIntakePlugin: Plugin {
  @objc public func takeSharedImages(_ invoke: Invoke) {
    invoke.resolve(["files": []])
  }

  /// `{ files: [] }` when the pasteboard holds no image. Refuses the whole
  /// read past the contract's count or byte bounds, or when an image item
  /// offers no admitted type, rather than delivering part of it.
  @objc public func readClipboardImages(_ invoke: Invoke) {
    DispatchQueue.main.async {
      do {
        invoke.resolve(["files": try self.clipboardImages(UIPasteboard.general)])
      } catch let refused as IntakeRefused {
        invoke.reject(refused.message)
      } catch {
        invoke.reject("Station could not read the clipboard.")
      }
    }
  }

  private func clipboardImages(_ pasteboard: UIPasteboard) throws -> [[String: String]] {
    guard pasteboard.hasImages else { return [] }
    let imageItems = pasteboard.items.enumerated().filter { _, item in
      item.keys.contains { key in UTType(key)?.conforms(to: .image) == true }
    }
    if imageItems.count > maxImageCount {
      throw IntakeRefused(message: "Station can take at most \(maxImageCount) images at once.")
    }
    var total = 0
    var files: [[String: String]] = []
    for (position, (index, _)) in imageItems.enumerated() {
      let set = IndexSet(integer: index)
      let offered = admittedTypes.lazy.compactMap { admitted in
        pasteboard.data(forPasteboardType: admitted.uti, inItemSet: set)?.first
      }
      guard let data = offered.first else {
        throw IntakeRefused(message: "Only PNG, JPEG, GIF and WebP images can be attached.")
      }
      guard !data.isEmpty else { throw IntakeRefused(message: "An image could not be read.") }
      if data.count > maxImageBytes { throw IntakeRefused(message: "An image is larger than 5 MB.") }
      total += data.count
      if total > maxTotalImageBytes { throw IntakeRefused(message: "The images are larger than 15 MB together.") }
      guard let mimeType = sniffImageMimeType(data),
        let ext = admittedTypes.first(where: { $0.mimeType == mimeType })?.ext
      else {
        throw IntakeRefused(message: "Only PNG, JPEG, GIF and WebP images can be attached.")
      }
      files.append([
        "name": "pasted-image-\(position + 1).\(ext)",
        "mimeType": mimeType,
        "dataUrl": "data:\(mimeType);base64,\(data.base64EncodedString())",
      ])
    }
    return files
  }
}

@_cdecl("init_plugin_station_media_intake")
func initPlugin() -> Plugin { MediaIntakePlugin() }
