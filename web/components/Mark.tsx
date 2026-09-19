// The TeleKey mark: a telegraph key in profile. Base, pivot post, a lever that
// rests raised, and a knob that is also the T of the name. The amber contact
// shows in the gap under the lever.
//
// Drawn inline so the structure follows the surface it sits on (`currentColor`:
// glow on graphite, ink on paper) while the amber never changes. The lever's
// resting angle and its press live in styles/global.css (`.mark-lever`); the
// `transform` attribute is the same resting angle for anything that renders the
// SVG without that stylesheet. Static copies are in public/brand/, and the app
// icon and menubar glyph are built from the same drawing (src-tauri/icons/).

type MarkProps = {
  className?: string;
};

export function Mark({ className = "" }: MarkProps) {
  return (
    <svg viewBox="0 0 64 64" className={`mark ${className}`} aria-hidden="true" focusable="false">
      <rect x="13.5" y="40" width="7" height="9" rx="2" className="fill-voice" />
      <rect x="4" y="48" width="56" height="8" rx="4" fill="currentColor" />
      <rect x="42" y="36" width="10" height="14" rx="3" fill="currentColor" />
      <g className="mark-lever" transform="rotate(8 47 36.5)">
        <rect x="6" y="33" width="52" height="7" rx="3.5" fill="currentColor" />
        <rect x="14" y="17" width="6" height="17" rx="2" className="fill-voice" />
        <rect x="4" y="10" width="26" height="9" rx="4.5" className="fill-voice" />
      </g>
    </svg>
  );
}
