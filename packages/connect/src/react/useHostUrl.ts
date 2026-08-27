import { useEffect, useState } from 'react';

export interface UseHostUrlOptions {
  port: number;
  /** Fallback URL used when IP detection fails or is still in progress */
  fallback?: string;
}

export interface UseHostUrlResult {
  hostUrl: string;
  isDetecting: boolean;
}

/**
 * Resolves the best URL for this app to advertise via QR.
 * Tries to detect the local LAN IP via RTCPeerConnection ICE candidates
 * (works inside WebView without server-side help). Falls back to localhost.
 */
export function useHostUrl({
  port,
  fallback,
}: UseHostUrlOptions): UseHostUrlResult {
  const defaultFallback = fallback ?? `http://localhost:${port}`;
  const [hostUrl, setHostUrl] = useState(defaultFallback);
  const [isDetecting, setIsDetecting] = useState(true);

  useEffect(() => {
    let cancelled = false;

    const detect = async () => {
      try {
        const ip = await detectLocalIp();
        if (!cancelled && ip) {
          setHostUrl(`http://${ip}:${port}`);
        }
      } catch {
        // keep fallback
      } finally {
        if (!cancelled) setIsDetecting(false);
      }
    };

    detect();
    return () => {
      cancelled = true;
    };
  }, [port]);

  return { hostUrl, isDetecting };
}

async function detectLocalIp(): Promise<string | null> {
  return new Promise((resolve) => {
    const timeout = setTimeout(() => resolve(null), 3000);

    try {
      // RTCPeerConnection trick: gather ICE candidates to find LAN IP
      const pc = new RTCPeerConnection({ iceServers: [] });
      const dc = pc.createDataChannel('');

      pc.onicecandidate = (e) => {
        if (!e.candidate) return;
        const match = /([0-9]{1,3}\.){3}[0-9]{1,3}/.exec(e.candidate.candidate);
        if (match) {
          const ip = match[0];
          // Skip link-local and loopback
          if (!ip.startsWith('127.') && !ip.startsWith('169.254.')) {
            clearTimeout(timeout);
            pc.close();
            dc.close();
            resolve(ip);
          }
        }
      };

      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === 'complete') {
          clearTimeout(timeout);
          resolve(null);
        }
      };

      pc.createOffer().then((offer) => pc.setLocalDescription(offer));
    } catch {
      clearTimeout(timeout);
      resolve(null);
    }
  });
}
