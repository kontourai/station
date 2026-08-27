import { useCallback, useEffect, useRef, useState } from 'react';
import { decodeDevicePairingPayload } from '../core/devicePairing';

export interface QRScannerProps {
  onScan: (payload: string) => void;
  onCancel: () => void;
  /**
   * Invoked when the user chooses to enter the pairing code by hand instead of
   * scanning. When provided, a camera failure (denied permission, no secure
   * context, no device) offers this path directly from the error state so the
   * user is never dead-ended on a permission wall — the native shell may not
   * grant camera access at all.
   */
  onManualEntry?: () => void;
}

/**
 * Opens the device camera and scans QR codes using jsqr.
 * Calls onScan(payload) only for a valid, unexpired Station pairing offer.
 */
export function QRScanner({ onScan, onCancel, onManualEntry }: QRScannerProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number>(0);
  const streamRef = useRef<MediaStream | null>(null);
  const completedRef = useRef(false);
  const onScanRef = useRef(onScan);
  const onCancelRef = useRef(onCancel);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(true);
  // `scanning` flips true before getUserMedia resolves and the first frame
  // decodes. A <video> with no frames paints the platform's default poster —
  // on Android that is a large play glyph, which flashed up every time the
  // scanner opened and read as a broken video rather than a starting camera.
  const [videoReady, setVideoReady] = useState(false);

  onScanRef.current = onScan;
  onCancelRef.current = onCancel;

  const stopStream = useCallback(() => {
    cancelAnimationFrame(rafRef.current);
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
  }, []);

  const handleCancel = useCallback(() => {
    completedRef.current = true;
    stopStream();
    onCancelRef.current();
  }, [stopStream]);

  useEffect(() => {
    let cancelled = false;
    completedRef.current = false;

    const startCamera = async () => {
      try {
        if (!navigator.mediaDevices?.getUserMedia) {
          throw Object.assign(
            new Error('Camera requires a secure context (HTTPS or localhost).'),
            { name: 'InsecureContext' },
          );
        }
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
        if (cancelled) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }
        streamRef.current = stream;
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play();
        }
        scan();
      } catch (err: any) {
        if (!cancelled) {
          setError(
            err.name === 'NotAllowedError'
              ? 'Camera permission denied. Please allow camera access.'
              : `Camera error: ${err.message}`,
          );
          setScanning(false);
          setVideoReady(false);
        }
      }
    };

    const scan = () => {
      if (cancelled || completedRef.current) return;
      const video = videoRef.current;
      const canvas = canvasRef.current;
      if (!video || !canvas || video.readyState < 2) {
        rafRef.current = requestAnimationFrame(scan);
        return;
      }
      const ctx = canvas.getContext('2d');
      if (!ctx) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);

      import('jsqr').then(({ default: jsQR }) => {
        if (cancelled || completedRef.current) return;
        const result = jsQR(imageData.data, imageData.width, imageData.height);
        if (result?.data) {
          const text = result.data.trim();
          if (decodeDevicePairingPayload(text)) {
            completedRef.current = true;
            setScanning(false);
            setVideoReady(false);
            stopStream();
            onScanRef.current(text);
            return;
          }
        }
        if (!cancelled && !completedRef.current) {
          rafRef.current = requestAnimationFrame(scan);
        }
      });
    };

    startCamera();
    return () => {
      cancelled = true;
      completedRef.current = true;
      stopStream();
    };
  }, [stopStream]);

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 16,
        padding: 16,
      }}
    >
      {error ? (
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div
            style={{
              color: 'var(--error-text, #ef4444)',
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            {error}
          </div>
          {onManualEntry && (
            <button
              type="button"
              onClick={onManualEntry}
              style={{
                padding: '8px 20px',
                fontSize: 13,
                borderRadius: 6,
                border: '1px solid var(--accent-primary, #3b82f6)',
                background: 'var(--accent-primary, #3b82f6)',
                color: '#fff',
                cursor: 'pointer',
              }}
            >
              Enter the pairing code manually
            </button>
          )}
        </div>
      ) : (
        <>
          <div style={{ position: 'relative', width: '100%', maxWidth: 320 }}>
            <video
              ref={videoRef}
              style={{
                width: '100%',
                borderRadius: 8,
                background: '#000',
                display: scanning && videoReady ? 'block' : 'none',
              }}
              playsInline
              muted
              // `playing` is the first moment there is actually something to
              // show; `loadedmetadata` still precedes the first painted frame.
              onPlaying={() => setVideoReady(true)}
            />
            {scanning && !videoReady && (
              <div
                aria-live="polite"
                style={{
                  width: '100%',
                  aspectRatio: '4 / 3',
                  borderRadius: 8,
                  background: '#000',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: 'var(--text-muted, #9ca3af)',
                  fontSize: 13,
                }}
              >
                Starting camera…
              </div>
            )}
            <canvas ref={canvasRef} style={{ display: 'none' }} />
            {scanning && (
              <div
                style={{
                  position: 'absolute',
                  inset: 0,
                  border: '2px solid var(--accent-primary, #3b82f6)',
                  borderRadius: 8,
                  pointerEvents: 'none',
                }}
              />
            )}
          </div>
          {scanning && (
            <p
              style={{
                margin: 0,
                fontSize: 13,
                color: 'var(--text-secondary, #999)',
                textAlign: 'center',
              }}
            >
              Point the camera at a Station pairing code
            </p>
          )}
        </>
      )}
      <button
        type="button"
        onClick={handleCancel}
        style={{
          padding: '8px 20px',
          fontSize: 13,
          borderRadius: 6,
          border: '1px solid var(--border-primary, #333)',
          background: 'transparent',
          color: 'var(--text-primary, #e5e5e5)',
          cursor: 'pointer',
        }}
      >
        Cancel
      </button>
    </div>
  );
}
