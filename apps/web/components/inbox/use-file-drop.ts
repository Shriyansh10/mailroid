"use client";

import { useCallback, useRef, useState, type DragEvent } from "react";
import { dragHasFiles } from "./attachment-files";

/**
 * Drop-to-attach for a compose surface.
 *
 * Only drags that carry files are claimed: dragging selected text or a link
 * keeps its normal behaviour. Enter/leave are counted rather than toggled,
 * because they fire for every child the pointer crosses and a boolean would
 * flicker the overlay off and on over the textarea.
 */
export function useFileDrop(onFiles: (files: File[]) => void, disabled?: boolean) {
  const [dragging, setDragging] = useState(false);
  const depth = useRef(0);

  const onDragEnter = useCallback(
    (e: DragEvent) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    },
    [disabled],
  );

  const onDragOver = useCallback(
    (e: DragEvent) => {
      if (disabled || !dragHasFiles(e.dataTransfer)) return;
      // Required for the element to accept a drop at all.
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    },
    [disabled],
  );

  const onDragLeave = useCallback((e: DragEvent) => {
    if (!dragHasFiles(e.dataTransfer)) return;
    depth.current = Math.max(0, depth.current - 1);
    if (depth.current === 0) setDragging(false);
  }, []);

  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!dragHasFiles(e.dataTransfer)) return;
      // Prevented even when disabled: an unhandled file drop makes the browser
      // navigate away to the file, taking the unsent message with it.
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      if (disabled) return;
      const files = Array.from(e.dataTransfer.files);
      if (files.length > 0) onFiles(files);
    },
    [disabled, onFiles],
  );

  return { dragging, dropHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop } };
}
