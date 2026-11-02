import type { MobileDeviceSession } from '@kontourai/station-contracts/mobile-device';
import type { TaskReviewCreateCaptureRequest } from '@kontourai/station-contracts/task-review';
import { redactSecrets } from '@kontourai/station-shared/redaction';
import type { DeviceAccess } from '../devices/device-access.js';
import type { DeviceSessionService } from '../devices/device-session-service.js';
import {
  DeviceToolsError,
  type DeviceToolsService,
  isDeviceAppId,
} from '../devices/device-tools.js';
import type { LiveSurfaceRegistry } from '../live-surface/registry.js';
import type { LocalMobileDeviceHost } from '../mobile-device/mobile-device-host.js';
import type { TaskReviewAccess } from '../orchestration/project-task-room-runtime.js';
import {
  TaskBrowserCapture,
  TaskBrowserCaptureError,
} from './task-browser-capture.js';
import type { RecordingSource } from './task-browser-recording.js';

type HostServices = {
  host: Pick<LocalMobileDeviceHost, 'capture'>;
  sessions: Pick<DeviceSessionService, 'list' | 'get'> &
    Partial<Pick<DeviceSessionService, 'actionHistory' | 'latestInstallation'>>;
  tools?: Pick<DeviceToolsService, 'foreground'> &
    Partial<Pick<DeviceToolsService, 'logs'>>;
};

/** Person Task capture, with host-qualified selection and fresh device access. */
export class TaskDeviceCapture {
  constructor(
    private readonly deps: {
      captures: Pick<TaskBrowserCapture, 'captureSource'>;
      access: DeviceAccess;
      hostIds(): string[];
      host(id: string): HostServices | undefined;
      hostRevision(id: string): number | undefined;
      projectMatches(request: Request, projectId: string): boolean;
      requestCurrent(request: Request): boolean;
    },
  ) {}

  private current(request: Request, access: TaskReviewAccess): boolean {
    return (
      this.deps.requestCurrent(request) &&
      access.write.beforeCommit() &&
      this.deps.projectMatches(request, access.write.projectId)
    );
  }

  async list(request: Request, access: TaskReviewAccess) {
    if (!this.current(request, access))
      throw new TaskBrowserCaptureError(
        'forbidden',
        'Device capture is unavailable.',
      );
    const sessions: Array<MobileDeviceSession & { sourceSessionId: string }> =
      [];
    for (const hostId of this.deps.hostIds()) {
      const services = this.deps.host(hostId);
      const revision = this.deps.hostRevision(hostId);
      if (!services || revision === undefined) continue;
      for (const session of services.sessions.list()) {
        if (
          session.hostId === hostId &&
          (await this.deps.access.mayAccessDevice(
            request,
            session.platform,
            session.deviceId,
            'view',
            hostId,
          )) &&
          this.deps.hostRevision(hostId) === revision &&
          this.deps.host(hostId)?.sessions === services.sessions &&
          services.sessions.get(session.sessionId)?.surfaceId ===
            session.surfaceId
        )
          sessions.push({
            ...session,
            sourceSessionId: `${hostId}:${session.sessionId}`,
          });
        if (sessions.length > 200)
          throw new TaskBrowserCaptureError(
            'capture-unavailable',
            'Too many Device sessions to list.',
          );
      }
    }
    if (!this.current(request, access))
      throw new TaskBrowserCaptureError(
        'forbidden',
        'Device capture is unavailable.',
      );
    return sessions;
  }

  private async select(
    request: Request,
    access: TaskReviewAccess,
    sourceSessionId: string,
  ) {
    const split = sourceSessionId.indexOf(':');
    const hostId = sourceSessionId.slice(0, split);
    const sessionId = sourceSessionId.slice(split + 1);
    if (
      split < 1 ||
      !sessionId ||
      !this.current(request, access) ||
      !this.deps.hostIds().includes(hostId)
    )
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device capture is unavailable.',
      );
    const services = this.deps.host(hostId);
    const revision = this.deps.hostRevision(hostId);
    const session = services?.sessions.get(sessionId);
    if (
      !services ||
      revision === undefined ||
      !session ||
      session.hostId !== hostId ||
      !(await this.deps.access.mayAccessDevice(
        request,
        session.platform,
        session.deviceId,
        'drive',
        hostId,
      ))
    )
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device capture is unavailable.',
      );
    const isFenceCurrent = () => {
      const live = this.deps.host(hostId);
      const current = live?.sessions.get(sessionId);
      return (
        this.current(request, access) &&
        this.deps.hostRevision(hostId) === revision &&
        live?.host === services.host &&
        live.sessions === services.sessions &&
        live.tools === services.tools &&
        current?.surfaceId === session.surfaceId &&
        current.hostId === session.hostId &&
        current.platform === session.platform &&
        current.deviceId === session.deviceId
      );
    };
    const isCurrent = async () =>
      isFenceCurrent() &&
      (await this.deps.access.mayAccessDevice(
        request,
        session.platform,
        session.deviceId,
        'drive',
        hostId,
      )) &&
      isFenceCurrent();
    return { services, session, isFenceCurrent, isCurrent };
  }

  async capture(
    request: Request,
    access: TaskReviewAccess,
    input: TaskReviewCreateCaptureRequest,
  ) {
    const { services, session, isFenceCurrent, isCurrent } = await this.select(
      request,
      access,
      input.sourceSessionId,
    );
    return this.deps.captures.captureSource(access, input, {
      screenshot: async () => {
        const shot = await services.host.capture(session);
        return {
          data: Buffer.from(shot.pngBase64, 'base64'),
          mimeType: shot.mimeType,
        };
      },
      isCurrent,
      isFenceCurrent,
    });
  }
  async reproduction(
    request: Request,
    access: TaskReviewAccess,
    sourceSessionId: string,
    appId: string,
  ) {
    if (!isDeviceAppId(appId))
      throw new TaskBrowserCaptureError(
        'invalid-request',
        'Give a valid app ID.',
      );
    const selected = await this.select(request, access, sourceSessionId);
    const readHistory = selected.services.sessions.actionHistory;
    const logs = selected.services.tools?.logs;
    if (!readHistory || !logs)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device diagnostics are unavailable.',
      );
    const beforeRun = async () => {
      if (!(await selected.isCurrent()))
        throw new TaskBrowserCaptureError(
          'forbidden',
          'Device access changed.',
        );
    };
    await beforeRun();
    let sample: Awaited<ReturnType<typeof logs>> | null;
    try {
      sample = await logs.call(
        selected.services.tools,
        selected.session,
        appId,
        beforeRun,
        request.signal,
      );
    } catch (error) {
      if (
        !(error instanceof DeviceToolsError) ||
        error.code !== 'app-not-running'
      )
        throw error;
      sample = null;
    }
    await beforeRun();
    const shot = await selected.services.host.capture(selected.session);
    await beforeRun();
    const bytes = Buffer.from(shot.pngBase64, 'base64');
    if (
      shot.mimeType !== 'image/png' ||
      bytes.length < 1 ||
      bytes.length > 3 * 1024 * 1024
    )
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device screenshot is unavailable.',
      );
    const history = readHistory.call(
      selected.services.sessions,
      selected.session.sessionId,
    );
    if (!history || !(await selected.isCurrent()))
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device session changed.',
      );
    return {
      current: selected.isCurrent,
      data: {
        schema: 'station.device-reproduction/v1',
        capturedAt: new Date().toISOString(),
        device: {
          hostId: selected.session.hostId,
          platform: selected.session.platform,
          deviceId: selected.session.deviceId,
          name: selected.session.name,
          runtime: selected.session.runtime,
        },
        app: {
          appId,
          installation: (() => {
            const value = selected.services.sessions.latestInstallation?.(
              selected.session.sessionId,
            );
            return value?.metadata.appId === appId ? value : null;
          })(),
          revision: null,
        },
        logs: sample
          ? {
              state: 'sampled',
              output: redactSecrets(sample.output),
              processId: sample.processId,
              truncated: sample.truncated,
            }
          : { state: 'app-not-running' },
        screenshot: { mimeType: 'image/png', data: bytes.toString('base64') },
        actions: history,
      },
    };
  }

  async recordingSource(
    request: Request,
    access: TaskReviewAccess,
    sourceSessionId: string,
    surfaces: Pick<LiveSurfaceRegistry, 'get'>,
    enabled: () => boolean,
  ): Promise<RecordingSource> {
    const selected = await this.select(request, access, sourceSessionId);
    const entry = surfaces.get(selected.session.surfaceId);
    if (!entry)
      throw new TaskBrowserCaptureError(
        'capture-unavailable',
        'Device surface is unavailable.',
      );
    const current = () =>
      enabled() &&
      selected.isFenceCurrent() &&
      surfaces.get(selected.session.surfaceId) === entry;
    const authorize = async () =>
      current() && (await selected.isCurrent()) && current();
    if (!(await authorize()))
      throw new TaskBrowserCaptureError(
        'forbidden',
        'Device capture is unavailable.',
      );
    const beforeRun = async () => {
      if (!(await authorize()))
        throw new TaskBrowserCaptureError(
          'forbidden',
          'Device capture is unavailable.',
        );
    };
    const snapshot = await selected.services.tools?.foreground(
      selected.session,
      beforeRun,
    );
    if (!(await authorize()))
      throw new TaskBrowserCaptureError(
        'forbidden',
        'Device capture is unavailable.',
      );
    const appId =
      snapshot?.foregroundApp.state === 'read'
        ? (snapshot.foregroundApp.value?.appId ?? null)
        : null;
    return {
      entry,
      current,
      authorize,
      checkEachFrame: true,
      platform: selected.session.platform,
      adapter: 'device-live-surface',
      device: {
        hostId: selected.session.hostId,
        deviceId: selected.session.deviceId,
        name: selected.session.name,
        runtime: selected.session.runtime,
        appId,
        appObservedAt: appId === null || !snapshot ? null : snapshot.readAt,
      },
    };
  }
}
