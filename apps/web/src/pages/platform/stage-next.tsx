import { useEffect, useRef } from "react";

// A stage never ends in silence: the pilot showed researchers unsure of the
// flow. But the bar each stage used to end with cost a slice of the screen the
// work needs, so the way forward now lives in the window's toolbar: one button,
// always in the same corner, whose tooltip says what comes next and what is
// still missing.

export type StageCta = {
  /** What the button says: "Ir a Fuentes". */
  label: string;
  /** Why this is next, or what the researcher still has to do. */
  tip: string;
  /** True while the next step is blocked: the button stays put, and says why. */
  disabled?: boolean;
  onClick: () => void;
};

/**
 * Publishes a stage's next step into the toolbar, and takes it back when the
 * stage unmounts. Only the values that change what the toolbar shows are
 * dependencies: `onClick` rides along in a ref, so a stage passing a fresh
 * arrow on every render does not re-render the workspace forever.
 */
export function useStageCta(publish: (cta: StageCta | null) => void, cta: StageCta) {
  const current = useRef(cta);
  current.current = cta;
  const { label, tip, disabled } = cta;
  useEffect(() => {
    publish({ label, tip, disabled, onClick: () => current.current.onClick() });
    return () => publish(null);
  }, [publish, label, tip, disabled]);
}
