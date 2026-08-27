import { useEffect, useRef } from 'react';
import { QR_COLOR, QR_MARGIN } from './qr-render-options';

export interface QRDisplayProps {
  url: string;
  size?: number;
  label?: string;
}

/**
 * Renders a QR code canvas for the supplied value. The historical `url` prop
 * name remains for compatibility; pairing callers pass an opaque offer payload.
 * Uses the `qrcode` npm package (dynamically imported to keep bundle lazy).
 */
export function QRDisplay({ url, size = 160, label }: QRDisplayProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    if (!canvasRef.current || !url) return;
    const canvas = canvasRef.current;

    // Dynamic import so bundlers can tree-shake if unused
    import('qrcode').then((QRCode) => {
      QRCode.toCanvas(canvas, url, {
        width: size,
        margin: QR_MARGIN,
        color: QR_COLOR,
      }).catch(() => {
        // Ignore render errors
      });
    });
  }, [url, size]);

  return (
    <div
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
      }}
    >
      <canvas
        ref={canvasRef}
        width={size}
        height={size}
        style={{ borderRadius: 8, display: 'block' }}
      />
      {label && (
        <span
          style={{
            fontSize: 11,
            color: 'var(--text-secondary, #999)',
            maxWidth: size,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
