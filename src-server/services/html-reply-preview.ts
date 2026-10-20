import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildHtmlReplyDocument } from '@kontourai/station-shared/html-reply-document';
import { ChromiumAcquisition } from './browser/chromium-acquisition.js';
import {
  BrowserHostPolicyError,
  ChromiumServerHost,
} from './browser/hosts/chromium-server-host.js';
import { HtmlReplyRefusal } from './html-reply-errors.js';

const LIMIT = {
  milliseconds: 15_000,
  consoleBytes: 64 * 1024,
  entries: 128,
  pngBytes: 8 * 1024 * 1024,
  height: 2000,
};

// Keep authored values in CDP call arguments, never in JavaScript source.
const PREVIEW_BOOTSTRAP = `function(documentHtml, token, theme, appearance) {
  return new Promise(resolve=>{const frame=document.createElement('iframe');frame.sandbox='allow-scripts';frame.style='border:0;width:100%;height:100%';frame.srcdoc=documentHtml;document.documentElement.style='height:100%';document.body.style='margin:0;height:100%';const capture=globalThis.__htmlPreview={height:0,entries:[],bytes:0,exceeded:false};let settled=false;addEventListener('message',event=>{if(event.source!==frame.contentWindow||event.data?.token!==token)return;const data=event.data;if(data?.type==='html-preview-overflow')capture.exceeded=true;if(data?.type==='html-preview-console'&&typeof data.text==='string'){capture.bytes+=new TextEncoder().encode(JSON.stringify(data)).length;if(capture.entries.length>=128||capture.bytes>65536)capture.exceeded=true;else capture.entries.push({level:data.level,text:data.text,stack:data.stack});}if(data?.type==='html-preview-size'){capture.height=data.height;if(!settled){settled=true;setTimeout(()=>resolve(true),150)}}});frame.onload=()=>frame.contentWindow.postMessage({type:'html-reply-theme',theme:theme,tokens:appearance},'*');document.body.append(frame)});
}`;

/** A fresh profile/process per render; never the person's browser-pane profile. */
export class HtmlReplyPreview {
  private active = 0;
  constructor(private readonly home: string) {}

  async render(
    page: { html: string; height: number },
    width: number,
    theme: 'light' | 'dark',
  ) {
    if (this.active >= 2)
      throw new HtmlReplyRefusal('HTML preview concurrency limit exceeded');
    if (!Number.isInteger(width) || width < 320 || width > 1920)
      throw new HtmlReplyRefusal('HTML preview width must be 320–1920');
    const executablePath = new ChromiumAcquisition(
      this.home,
    ).resolveExecutable();
    if (!executablePath)
      throw new HtmlReplyRefusal(
        'HTML preview needs Chromium. Install it through the Browser workspace first.',
      );
    this.active++;
    const host = new ChromiumServerHost({
      executablePath,
      launchTimeoutMs: 15_000,
      jsHeapLimitMb: 128,
      denyHostResolution: true,
      requireRestrictedWebRtc: true,
      egressPolicy: {
        listeners: () => ({ ports: [], hostnames: [] }),
        interfaceAddresses: () => [],
        reach: { kind: 'none' },
      },
    });
    let directory: string | undefined;
    let expired = false;
    let workPromise: Promise<unknown> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          expired = true;
          reject(new HtmlReplyRefusal('HTML preview exceeded 15 seconds'));
        }, LIMIT.milliseconds);
      });
      const work = async () => {
        directory = await mkdtemp(join(tmpdir(), 'station-html-preview-'));
        if (expired) throw new HtmlReplyRefusal('HTML preview expired');
        // The launch flag alone does not enforce this in every Chrome build.
        // Preferences apply to every realm, including fresh srcdoc windows.
        await mkdir(join(directory, 'Default'));
        await writeFile(
          join(directory, 'Default', 'Preferences'),
          JSON.stringify({
            webrtc: {
              ip_handling_policy: 'disable_non_proxied_udp',
            },
          }),
        );
        const target = await host.openTarget({
          profileDir: directory,
          viewport: { width, height: page.height, deviceScaleFactor: 1 },
        });
        const cdp = host.cdp();
        const send = <T>(method: string, params?: object) =>
          cdp.send<T>(method, params, target.cdpSessionId);
        await send('Runtime.enable');
        await send('Emulation.setEmulatedMedia', {
          features: [{ name: 'prefers-color-scheme', value: theme }],
        });
        const token = randomBytes(32).toString('base64url');
        const document = buildHtmlReplyDocument(page.html, token);
        const tokens =
          theme === 'dark'
            ? {
                background: '#0a0e13',
                foreground: '#eef3f8',
                muted: '#aebccb',
                border: '#263040',
                accent: '#5ce0c6',
              }
            : {
                background: '#f5f4ef',
                foreground: '#202124',
                muted: '#5b626b',
                border: '#d5d6d8',
                accent: '#0e7c64',
              };
        const appearance = {
          ...tokens,
          destructive: '#c83b3b',
          success: '#168257',
          warning: '#8a5a00',
          'chart-1': tokens.accent,
          'chart-2': '#3f6fd6',
          'chart-3': '#168257',
          'chart-4': '#8a5a00',
          'chart-5': '#c83b3b',
          'chart-6': '#966aff',
          radius: '8px',
          'font-sans': 'system-ui,sans-serif',
          'font-mono': 'monospace',
        };
        const global = await send<{
          result: { objectId?: string };
          exceptionDetails?: unknown;
        }>('Runtime.evaluate', { expression: 'globalThis' });
        if (global.exceptionDetails || !global.result.objectId)
          throw new HtmlReplyRefusal('HTML preview bootstrap failed');
        const evaluated = await send<{ exceptionDetails?: unknown }>(
          'Runtime.callFunctionOn',
          {
            objectId: global.result.objectId,
            functionDeclaration: PREVIEW_BOOTSTRAP,
            arguments: [document, token, theme, appearance].map((value) => ({
              value,
            })),
            awaitPromise: true,
            returnByValue: true,
          },
        );
        if (evaluated.exceptionDetails)
          throw new HtmlReplyRefusal('HTML preview bootstrap failed');
        const size = await send<{
          result: {
            value?: {
              height: number;
              entries: { level: string; text: string; stack?: string }[];
              exceeded: boolean;
            };
          };
        }>('Runtime.evaluate', {
          expression: 'globalThis.__htmlPreview',
          returnByValue: true,
        });
        if (!size.result.value)
          throw new HtmlReplyRefusal('HTML preview measurement failed');
        const capture = size.result.value;
        const contentHeight = capture.height;
        if (
          !Number.isInteger(contentHeight) ||
          typeof contentHeight !== 'number' ||
          contentHeight < 1 ||
          contentHeight > LIMIT.height
        )
          throw new HtmlReplyRefusal(
            'HTML preview content height exceeds 2000 pixels or is invalid',
          );
        if (capture.exceeded)
          throw new HtmlReplyRefusal(
            'HTML preview console exceeds 128 entries or 64 KiB',
          );
        await send('Emulation.setDeviceMetricsOverride', {
          width,
          height: contentHeight,
          deviceScaleFactor: 1,
          mobile: false,
        });
        const png = await send<{ data: string }>('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
        });
        if (Buffer.byteLength(png.data, 'base64') > LIMIT.pngBytes)
          throw new HtmlReplyRefusal('HTML preview screenshot exceeds 8 MiB');
        if (capture.exceeded)
          throw new HtmlReplyRefusal('HTML preview console exceeds its limit');
        return {
          png: png.data,
          contentHeight,
          width,
          console: capture.entries,
        };
      };
      const running = work();
      workPromise = running;
      return await Promise.race([running, timeout]);
    } catch (error) {
      if (
        error instanceof BrowserHostPolicyError &&
        error.code === 'webrtc-policy-unverified'
      )
        throw new HtmlReplyRefusal(
          'HTML preview requires effective WebRTC policy disable_non_proxied_udp without URL overrides. This browser is unsupported or enterprise policy overrides the profile.',
        );
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      await host.shutdown();
      await workPromise?.catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
      this.active--;
    }
  }
}
