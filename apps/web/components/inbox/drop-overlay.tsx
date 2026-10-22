import { PaperclipIcon } from "lucide-react";

/**
 * Shown over a compose surface while files are dragged across it, so a drop
 * target that is otherwise invisible says what it will do. The parent must be
 * `relative`. Pointer events pass through, so the drop lands on the parent's
 * handlers.
 */
export function DropOverlay({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] border-2 border-dashed border-primary bg-background/85 backdrop-blur-sm"
    >
      <span className="flex items-center gap-2 text-sm font-medium text-primary">
        <PaperclipIcon className="size-4" />
        Drop files to attach
      </span>
    </div>
  );
}
