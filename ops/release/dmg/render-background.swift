// Renders the macOS disk-image window background at 1x and 2x.
//
//   swift ops/release/dmg/render-background.swift <output-directory>
//
// The geometry here must match ops/release/dmg/dmgbuild-settings.py: a
// 660x400 window with the app icon centered at (170, 210) and the
// Applications link at (490, 210). The committed background.tiff is the
// reviewed output; rerun this and `tiffutil -cathidpicheck` to change it.
import AppKit
import CoreGraphics

let width: CGFloat = 660
let height: CGFloat = 400
let appCenter = CGPoint(x: 170, y: 210)
let applicationsCenter = CGPoint(x: 490, y: 210)

func color(_ hex: UInt32, alpha: CGFloat = 1) -> CGColor {
  CGColor(
    srgbRed: CGFloat((hex >> 16) & 0xff) / 255,
    green: CGFloat((hex >> 8) & 0xff) / 255,
    blue: CGFloat(hex & 0xff) / 255,
    alpha: alpha)
}

func render(scale: CGFloat, to url: URL) throws {
  let pixelsWide = Int(width * scale)
  let pixelsHigh = Int(height * scale)
  guard
    let context = CGContext(
      data: nil, width: pixelsWide, height: pixelsHigh, bitsPerComponent: 8,
      bytesPerRow: 0, space: CGColorSpace(name: CGColorSpace.sRGB)!,
      bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
  else { throw NSError(domain: "render", code: 1) }
  context.scaleBy(x: scale, y: scale)
  // Finder draws the background with a top-left origin; flip once so the
  // coordinates below read the same way as the icon positions.
  context.translateBy(x: 0, y: height)
  context.scaleBy(x: 1, y: -1)

  // Station's dark surface, with a soft lift behind the icon row.
  let gradient = CGGradient(
    colorsSpace: CGColorSpace(name: CGColorSpace.sRGB),
    colors: [color(0x14181f), color(0x0d1015)] as CFArray, locations: [0, 1])!
  context.drawLinearGradient(
    gradient, start: CGPoint(x: 0, y: 0), end: CGPoint(x: 0, y: height), options: [])
  let lift = CGRect(x: 40, y: appCenter.y - 110, width: width - 80, height: 200)
  context.setFillColor(color(0xffffff, alpha: 0.035))
  context.addPath(CGPath(roundedRect: lift, cornerWidth: 18, cornerHeight: 18, transform: nil))
  context.fillPath()

  // Observed in a mounted image on macOS 26 with the system in Dark Mode:
  // Finder still painted the icon names near-black on this custom background,
  // and 13pt ink under these 128pt icons sat at content y 288.5–299.5. Light
  // Mode uses dark names as well, so a light plate under each name is the
  // contrast surface for both. The floor width covers the widest name seen
  // with filename extensions shown (Station MacProof.app, 130.6pt), plus padding.
  let labelFont = NSFont.systemFont(ofSize: 13)
  let labelWidth = ["Station Nightly.app", "Station Beta.app", "Station.app", "Applications"]
    .map { ($0 as NSString).size(withAttributes: [.font: labelFont]).width }.max()!
  let plateWidth = max(ceil(labelWidth) + 24, 156)
  let plateHeight: CGFloat = 28
  let plateTop: CGFloat = 280
  context.setShadow(offset: CGSize(width: 0, height: 1), blur: 4, color: color(0x000000, alpha: 0.55))
  context.setFillColor(color(0xf4f6f8))
  for center in [appCenter, applicationsCenter] {
    let plate = CGRect(
      x: center.x - plateWidth / 2, y: plateTop, width: plateWidth, height: plateHeight)
    context.addPath(CGPath(roundedRect: plate, cornerWidth: 8, cornerHeight: 8, transform: nil))
    context.fillPath()
  }
  context.setShadow(offset: .zero, blur: 0, color: nil)

  // Arrow from the app toward Applications, clear of both 128pt icons.
  let teal = color(0x7ad9c4)
  let shaftStart = CGPoint(x: appCenter.x + 92, y: appCenter.y)
  let shaftEnd = CGPoint(x: applicationsCenter.x - 104, y: appCenter.y)
  context.setStrokeColor(teal)
  context.setLineWidth(5)
  context.setLineCap(.round)
  context.setLineDash(phase: 0, lengths: [2, 12])
  context.move(to: shaftStart)
  context.addLine(to: shaftEnd)
  context.strokePath()
  context.setLineDash(phase: 0, lengths: [])
  context.setFillColor(teal)
  context.move(to: CGPoint(x: shaftEnd.x + 16, y: shaftEnd.y))
  context.addLine(to: CGPoint(x: shaftEnd.x - 4, y: shaftEnd.y - 14))
  context.addLine(to: CGPoint(x: shaftEnd.x - 4, y: shaftEnd.y + 14))
  context.closePath()
  context.fillPath()

  // Instruction, above the icons so it never collides with Finder labels.
  let graphics = NSGraphicsContext(cgContext: context, flipped: true)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = graphics
  let paragraph = NSMutableParagraphStyle()
  paragraph.alignment = .center
  let title: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 22, weight: .semibold),
    .foregroundColor: NSColor(cgColor: color(0xf2f5f8))!,
    .paragraphStyle: paragraph,
  ]
  let hint: [NSAttributedString.Key: Any] = [
    .font: NSFont.systemFont(ofSize: 13, weight: .regular),
    .foregroundColor: NSColor(cgColor: color(0x9aa4b2))!,
    .paragraphStyle: paragraph,
  ]
  NSAttributedString(string: "Install Station", attributes: title)
    .draw(in: CGRect(x: 0, y: 34, width: width, height: 30))
  NSAttributedString(
    string: "Drag Station onto the Applications folder, then open it from Applications.",
    attributes: hint
  ).draw(in: CGRect(x: 40, y: 68, width: width - 80, height: 20))
  NSGraphicsContext.restoreGraphicsState()

  guard let image = context.makeImage() else { throw NSError(domain: "render", code: 2) }
  let rep = NSBitmapImageRep(cgImage: image)
  rep.size = NSSize(width: width, height: height)
  guard let png = rep.representation(using: .png, properties: [:]) else {
    throw NSError(domain: "render", code: 3)
  }
  try png.write(to: url)
}

let output = URL(fileURLWithPath: CommandLine.arguments.dropFirst().first ?? ".")
try render(scale: 1, to: output.appendingPathComponent("background.png"))
try render(scale: 2, to: output.appendingPathComponent("background@2x.png"))
