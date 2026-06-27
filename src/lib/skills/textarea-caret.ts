// Measure the pixel position of a character index within a textarea
// using the well-known mirror-div technique: clone the textarea's
// layout-relevant computed styles onto an off-screen div, render the
// text up to the index, and read the marker span's offset. Used by
// the slash menu to anchor itself directly above the typed `/`.

const COPY_PROPS: Array<keyof CSSStyleDeclaration> = [
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "borderStyle",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
];

export interface CaretCoordinates {
  /** Pixel offset from the textarea's content-box top (includes
   *  padding-top of the textarea). Does NOT account for scrollTop —
   *  callers translating to viewport coords should subtract it. */
  top: number;
  /** Pixel offset from the textarea's content-box left. */
  left: number;
  /** Height of the line at `position`, useful for sitting an anchor
   *  flush above the line. */
  height: number;
}

/** Measure where the character at `position` is rendered inside
 *  `textarea`. Synchronous — uses a hidden DOM clone, ~0.1ms per call.
 *  Safe to invoke from $derived. */
export function getCaretCoordinates(
  textarea: HTMLTextAreaElement,
  position: number,
): CaretCoordinates {
  const div = document.createElement("div");
  document.body.appendChild(div);

  const style = window.getComputedStyle(textarea);
  for (const prop of COPY_PROPS) {
    // CSSStyleDeclaration indexing requires `any` — we're only copying
    // string-valued layout props so this is safe.
    (div.style as unknown as Record<string, string>)[prop as string] =
      (style as unknown as Record<string, string>)[prop as string];
  }
  div.style.position = "absolute";
  div.style.visibility = "hidden";
  div.style.whiteSpace = "pre-wrap";
  div.style.wordWrap = "break-word";

  const before = textarea.value.substring(0, position);
  div.textContent = before;

  // The marker has content so it gets a layout box even at the end of
  // a string. We use "." as a safe single-char filler.
  const marker = document.createElement("span");
  marker.textContent = textarea.value.substring(position) || ".";
  div.appendChild(marker);

  const result: CaretCoordinates = {
    top: marker.offsetTop,
    left: marker.offsetLeft,
    height:
      parseInt(style.lineHeight, 10) || parseInt(style.fontSize, 10) || 16,
  };

  document.body.removeChild(div);
  return result;
}
