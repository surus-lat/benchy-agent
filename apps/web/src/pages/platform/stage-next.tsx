import type { ReactNode } from "react";

// The end of every stage says, in plain words, what comes next and why. The
// pilot showed researchers unsure of the flow: a stage never ends in silence.

export function StageNext({
  eyebrow = "Siguiente paso",
  title,
  text,
  action,
  onClick,
  disabled,
  tone = "next",
  icon = "→",
}: {
  eyebrow?: string;
  title: string;
  text: ReactNode;
  action: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "next" | "done";
  icon?: string;
}) {
  return (
    <div className={`ws-next ${tone}`} role="note">
      <div className="b">
        <p className="ws-eyebrow">{eyebrow}</p>
        <p className="t">{title}</p>
        <p className="d">{text}</p>
      </div>
      <button className="ws-btn-dark sm" onClick={onClick} disabled={disabled}>
        {action} <span className="amber">{icon}</span>
      </button>
    </div>
  );
}
