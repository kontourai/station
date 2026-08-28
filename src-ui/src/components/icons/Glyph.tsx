interface GlyphProps {
  className?: string;
}

function glyph(path: string) {
  return function Glyph({ className }: GlyphProps) {
    return (
      <svg
        aria-hidden="true"
        className={className}
        fill="none"
        focusable="false"
        height="1em"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.8"
        viewBox="0 0 16 16"
        width="1em"
      >
        <path d={path} />
      </svg>
    );
  };
}

export const AgentGlyph = /* @__PURE__ */ glyph(
  'M4 13v-1.5A2.5 2.5 0 0 1 6.5 9h3a2.5 2.5 0 0 1 2.5 2.5V13M8 2.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
);
export const ArchiveGlyph = /* @__PURE__ */ glyph(
  'M2.5 5.5h11v8h-11v-8ZM2 2.5h12v3H2v-3Zm4 6h4',
);
export const ArrowDownGlyph = /* @__PURE__ */ glyph('M3 6l5 5 5-5');
export const ArrowLeftGlyph = /* @__PURE__ */ glyph('M10.5 3 5.5 8l5 5');
export const ArrowRightGlyph = /* @__PURE__ */ glyph('M5.5 3l5 5-5 5');
export const ArrowUpGlyph = /* @__PURE__ */ glyph('M3 10l5-5 5 5');
export const AttachmentGlyph = /* @__PURE__ */ glyph(
  'm6 8.5 3.8-3.8a2 2 0 1 1 2.8 2.8L7.4 12.7a3 3 0 0 1-4.2-4.2l5-5',
);
export const BrainGlyph = /* @__PURE__ */ glyph(
  'M6.2 3.2A2.3 2.3 0 0 0 2.5 5a2.2 2.2 0 0 0 .7 4.2A2.4 2.4 0 0 0 6.5 12v1.5M9.8 3.2A2.3 2.3 0 0 1 13.5 5a2.2 2.2 0 0 1-.7 4.2A2.4 2.4 0 0 1 9.5 12v1.5M8 2.5v11M5.5 6H8m2.5 3H8',
);
export const CalendarGlyph = /* @__PURE__ */ glyph(
  'M3 3.5h10v10H3v-10Zm0 3h10M5.5 2v3m5-3v3',
);
export const CameraGlyph = /* @__PURE__ */ glyph(
  'M2.5 5h2l1-1.5h5L11.5 5h2v7h-11V5ZM8 6.5a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z',
);
export const ChartGlyph = /* @__PURE__ */ glyph(
  'M3 13V8m5 5V3m5 10V6M2 13.5h12',
);
export const CheckGlyph = /* @__PURE__ */ glyph('m3 8 3.2 3.2L13 4.5');
export const CloseGlyph = /* @__PURE__ */ glyph('M3.5 3.5l9 9m0-9-9 9');
export const DatabaseGlyph = /* @__PURE__ */ glyph(
  'M3 4c0-1 2.2-1.8 5-1.8S13 3 13 4s-2.2 1.8-5 1.8S3 5 3 4Zm0 0v4c0 1 2.2 1.8 5 1.8S13 9 13 8V4m-10 4v4c0 1 2.2 1.8 5 1.8s5-.8 5-1.8V8',
);
export const DocumentGlyph = /* @__PURE__ */ glyph(
  'M4 2.5h5l3 3v8H4v-11Zm5 0v3h3M6 8h4m-4 2.5h4',
);
export const EditGlyph = /* @__PURE__ */ glyph(
  'm3 11-.5 2.5L5 13l7.5-7.5-2-2L3 11Zm6.5-6.5 2 2',
);
export const EngineGlyph = /* @__PURE__ */ glyph(
  'm9 1.8-6 7h4l-1 5.4 7-8H9l0-4.4Z',
);
export const FolderGlyph = /* @__PURE__ */ glyph(
  'M2.5 4.5h4l1.3 1.5h5.7v7h-11v-8.5Z',
);
export const GlobeGlyph = /* @__PURE__ */ glyph(
  'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2Zm0 0c1.5 1.6 2.2 3.6 2.2 6S9.5 12.4 8 14M8 2C6.5 3.6 5.8 5.6 5.8 8s.7 4.4 2.2 6M2.3 8h11.4',
);
export const HandGlyph = /* @__PURE__ */ glyph(
  'M4.5 8V4.5a1 1 0 0 1 2 0V7m0-3.5a1 1 0 0 1 2 0V7m0-3a1 1 0 0 1 2 0v3m0-2a1 1 0 0 1 2 0v4a4 4 0 0 1-4 4H7a4 4 0 0 1-3.4-1.9L2 8.7a1.2 1.2 0 0 1 2-.7l1 1',
);
export const InboxGlyph = /* @__PURE__ */ glyph(
  'M3 3h10v10H3V3Zm0 6h3l1 1.5h2L10 9h3',
);
export const LightbulbGlyph = /* @__PURE__ */ glyph(
  'M5.5 11h5M6 13.5h4M8 2.2a4 4 0 0 0-2.5 7.1c.5.4.5.7.5 1.2h4c0-.5 0-.8.5-1.2A4 4 0 0 0 8 2.2Z',
);
export const InfoGlyph = /* @__PURE__ */ glyph(
  'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm0 4.7V11M8 5.2v.1',
);
export const LockGlyph = /* @__PURE__ */ glyph(
  'M3.5 7h9v6.5h-9V7Zm2-0V4.8a2.5 2.5 0 0 1 5 0V7M8 9.5v1.8',
);
export const MenuGlyph = /* @__PURE__ */ glyph('M2.5 4h11M2.5 8h11M2.5 12h11');
export const MessageGlyph = /* @__PURE__ */ glyph(
  'M2.5 3h11v8h-6L4 13.5V11H2.5V3Zm3 3h5m-5 2.5h3',
);
export const MicGlyph = /* @__PURE__ */ glyph(
  'M5.5 3.5a2.5 2.5 0 0 1 5 0V8a2.5 2.5 0 0 1-5 0V3.5ZM3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2m-2 0h4',
);
export const MoonGlyph = /* @__PURE__ */ glyph(
  'M13 10.5A6 6 0 0 1 5.5 3 5.5 5.5 0 1 0 13 10.5Z',
);
export const MoneyGlyph = /* @__PURE__ */ glyph(
  'M8 2v12m3-9.5H6.5a2 2 0 0 0 0 4h3a2 2 0 0 1 0 4H5',
);
export const MusicGlyph = /* @__PURE__ */ glyph(
  'M6 12V4l6-1v8M3.5 14A2.5 2.5 0 1 0 6 11.5 2.5 2.5 0 0 0 3.5 14Zm6-1A2.5 2.5 0 1 0 12 10.5 2.5 2.5 0 0 0 9.5 13Z',
);
export const OutboxGlyph = /* @__PURE__ */ glyph(
  'M3 3h10v10H3V3Zm0 6h3l1 1.5h2L10 9h3M8 8V2m-2 2 2-2 2 2',
);
export const PauseGlyph = /* @__PURE__ */ glyph('M5.5 3.5v9m5-9v9');
export const PinGlyph = /* @__PURE__ */ glyph(
  'm5 2 6 6-2 1.2-.8 3.3-1.5-1.4-3.6 2.8 2.8-3.6L4.5 8.3 7.8 7.5 9 5.5 5 2Z',
);
export const PlusGlyph = /* @__PURE__ */ glyph('M8 3v10M3 8h10');
export const PlugGlyph = /* @__PURE__ */ glyph(
  'M5 2v4m6-4v4M4 6h8v1.5a4 4 0 0 1-8 0V6Zm4 5.5V14',
);
export const QuestionGlyph = /* @__PURE__ */ glyph(
  'M5.7 5.5A2.5 2.5 0 1 1 9 7.9c-.8.3-1 .8-1 1.6M8 12.5h.01',
);
export const RefreshGlyph = /* @__PURE__ */ glyph(
  'M13 5V2.5L11.3 4A5.5 5.5 0 0 0 3 6m0 5v2.5L4.7 12A5.5 5.5 0 0 0 13 10',
);
export const ReturnGlyph = /* @__PURE__ */ glyph(
  'M5 4 2.5 6.5 5 9m-2.5-2.5H10a3 3 0 0 1 3 3V12',
);
export const SearchGlyph = /* @__PURE__ */ glyph(
  'M7 2.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9Zm3.3 7.8 3.2 3.2',
);
export const SettingsGlyph = /* @__PURE__ */ glyph(
  'M8 5.5A2.5 2.5 0 1 0 8 10a2.5 2.5 0 0 0 0-5Zm0-3 .7 1.4 1.5.4 1.3-.8 1 1-0.8 1.3.4 1.5 1.4.7v1.4l-1.4.7-.4 1.5.8 1.3-1 1-1.3-.8-1.5.4-.7 1.4H7l-.7-1.4-1.5-.4-1.3.8-1-1 .8-1.3-.4-1.5-1.4-.7V7l1.4-.7.4-1.5-.8-1.3 1-1 1.3.8 1.5-.4L7 2.5h1Z',
);
export const ShieldGlyph = /* @__PURE__ */ glyph(
  'M8 2 13 4v3.5c0 3-2 5.3-5 6.5-3-1.2-5-3.5-5-6.5V4l5-2Z',
);
export const SparkleGlyph = /* @__PURE__ */ glyph(
  'M8 1.5 9.2 5 12.5 6.5 9.2 8 8 11.5 6.8 8 3.5 6.5 6.8 5 8 1.5Zm4 8 .6 1.8 1.9.7-1.9.7-.6 1.8-.6-1.8-1.9-.7 1.9-.7.6-1.8Z',
);
export const SunGlyph = /* @__PURE__ */ glyph(
  'M8 3.5v-2m0 13v-2m4.5-4.5h2m-13 0h2m7.7-3.2 1.4-1.4m-9.2 9.2 1.4-1.4m6.4 0 1.4 1.4M3.4 3.4l1.4 1.4M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z',
);
export const TargetGlyph = /* @__PURE__ */ glyph(
  'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Zm0 3a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Zm0 1.5v1',
);
/** A terminal/shell prompt glyph — the Background tasks sheet's `tool` card icon. */
export const TerminalGlyph = /* @__PURE__ */ glyph(
  'M2.5 3.5h11v9h-11v-9Zm2 3 2.5 2-2.5 2M8 10.5h3',
);
export const ThumbDownGlyph = /* @__PURE__ */ glyph(
  'M6 3h6l1.5 5.5H10L9 13a1.5 1.5 0 0 1-2.8-.8L6 9H3V3h3Zm0 0v6',
);
export const ThumbUpGlyph = /* @__PURE__ */ glyph(
  'M6 13h6l1.5-5.5H10L9 3a1.5 1.5 0 0 0-2.8.8L6 7H3v6h3Zm0 0V7',
);
export const TimeGlyph = /* @__PURE__ */ glyph(
  'M8 2.5a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11ZM8 5v3l2 1.5',
);
export const VideoGlyph = /* @__PURE__ */ glyph(
  'M2.5 4h8v8h-8V4Zm8 2.5 3-2v7l-3-2',
);
export const WarningGlyph = /* @__PURE__ */ glyph(
  'M8 2 14 13H2L8 2Zm0 4v3.5m0 2h.01',
);
