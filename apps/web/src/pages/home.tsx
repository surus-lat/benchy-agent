import {
  useState,
  useEffect,
  useRef,
  useCallback,
  forwardRef,
  useImperativeHandle,
  createContext,
  useContext,
  useMemo,
} from "react";

// ---------------------------------------------------------------------------
// NotepadAPI — the programmable interface for the notepads
// ---------------------------------------------------------------------------

export type NotepadId = "left" | "right";

export interface NotepadAPI {
  read(id: NotepadId): string;
  write(id: NotepadId, text: string): void;
  insert(id: NotepadId, text: string, at: number): void;
}

export const NotepadAPIContext = createContext<NotepadAPI | null>(null);

export function useNotepadAPI(): NotepadAPI | null {
  return useContext(NotepadAPIContext);
}

// ---------------------------------------------------------------------------
// Imperative handle exposed by each DraggableNotepad
// ---------------------------------------------------------------------------

export interface NotepadHandle {
  syncContent(text: string): void;
}

// ---------------------------------------------------------------------------
// Tab & Stage config types
// ---------------------------------------------------------------------------

export interface SkillChip {
  id: string;
  label: string;
  prompt: string;
}

export interface TabDef {
  id: string;
  label: string;
  textKey: string;
  defaultText: string;
}

export interface StageConfig {
  id: 1 | 2 | 3 | 4;
  title: string;
  subtitle: string;
  layout: "two" | "single-center" | "export";
  left: TabDef[];
  right: TabDef[];
  skills: SkillChip[];
}

// ---------------------------------------------------------------------------
// STAGES — 3 stages of the benchmark builder
// ---------------------------------------------------------------------------

const EXTRACTION_OUTPUT_DEFAULT = `{
  "sender_full_name": "John Smith",
  "recipient": "transport@medservice.com",
  "number_of_ambulance_transports_needed": "3",
  "date_when_transports_need_to_be_delivered": "2024-03-15",
  "medical_unit": "St. Mary's Hospital ICU"
}`;

const CLASSIFICATION_OUTPUT_DEFAULT = `{
  "labels": ["invoice", "form", "receipt"]
}`;

const STAGES: StageConfig[] = [
  {
    id: 1,
    title: "Define",
    subtitle: "Task definition and I/O specification",
    layout: "two",
    left: [
      {
        id: "text",
        label: "Text",
        textKey: "benchy-s1-input-text:text",
        defaultText: `From: John Smith <j.smith@cityhealth.com>
To: transport@medservice.com
Subject: Ambulance Transport Request

Dear Transport Team,

We need to arrange 3 ambulance transports for patients at St. Mary's Hospital ICU.
The transports are required on 2024-03-15.

Please confirm availability at your earliest convenience.

Best regards,
John Smith
Medical Transport Coordinator
City Health Network`,
      },
      {
        id: "image",
        label: "Image",
        textKey: "benchy-s1-input-image:text",
        defaultText: `[Image input]

Describe the image your AI processes:
  e.g. scanned invoices, medical X-rays,
  product photos, receipts`,
      },
    ],
    right: [
      {
        id: "output",
        label: "Expected Output",
        textKey: "benchy-s1-output:text",
        defaultText: EXTRACTION_OUTPUT_DEFAULT,
      },
    ],
    skills: [
      {
        id: "define_task",
        label: "Define task",
        prompt: "Read both notepads. Walk me through defining my benchmark task step by step: What task should the benchmark test? What does the AI receive as input, and what should it produce as output? Then write sample input to the left notepad and expected output to the right.",
      },
    ],
  },
  {
    id: 2,
    title: "Score",
    subtitle: "Scoring method and evaluation rules",
    layout: "single-center",
    left: [
      {
        id: "per_field",
        label: "Per-field",
        textKey: "benchy-s2-perfield:text",
        defaultText: `scoring:
  type: per_field
  partial_credit: true
  case_sensitive: false
  numeric_tolerance: 0.0
  weights:
    sender_full_name: 1
    recipient: 1
    number_of_ambulance_transports_needed: 1
    date_when_transports_need_to_be_delivered: 1
    medical_unit: 1`,
      },
      {
        id: "passfail",
        label: "Pass/fail",
        textKey: "benchy-s2-passfail:text",
        defaultText: `scoring:
  type: binary
  case_sensitive: false`,
      },
    ],
    right: [],
    skills: [
      {
        id: "define_scoring",
        label: "Define scoring",
        prompt: "Read the scoring notepad. Help me configure the scoring method for my benchmark. The active tab (Per-field or Pass/fail) is my current choice. Suggest field weights or adjustments based on the task defined in Stage 1.",
      },
    ],
  },
  {
    id: 3,
    title: "Config",
    subtitle: "Data source and target AI system",
    layout: "two",
    left: [
      {
        id: "input",
        label: "Input",
        textKey: "benchy-s3-data-input:text",
        defaultText: `data:
  source: local
  count: 10
  path: .data/email-request/train.jsonl
  seed_description: emails from clients requesting ambulance
    transport with the data detailed in the extraction schema

# Drop a file here or paste your data
# Supported formats:
#   .jsonl  one JSON object per line
#   .json   JSON array
#   .csv    comma-separated values`,
      },
      {
        id: "adapt",
        label: "Adapt",
        textKey: "benchy-s3-data-adapt:text",
        defaultText: `[
  {
    "input": "From: John Smith <j.smith@cityhealth.com>\\nTo: transport@medservice.com\\nSubject: Ambulance Transport Request\\n\\nWe need 3 ambulance transports at St. Mary's Hospital ICU on 2024-03-15.",
    "expected_output": {
      "sender_full_name": "John Smith",
      "recipient": "transport@medservice.com",
      "number_of_ambulance_transports_needed": "3",
      "date_when_transports_need_to_be_delivered": "2024-03-15",
      "medical_unit": "St. Mary's Hospital ICU"
    }
  }
]`,
      },
    ],
    right: [
      {
        id: "target",
        label: "Model Config",
        textKey: "benchy-s3-target:text",
        defaultText: `target:
  type: model
  provider: together
  model: google/gemma-4-31B-it
  system_prompt: You are an expert information extractor for a medical transport company`,
      },
    ],
    skills: [
      {
        id: "configure_model",
        label: "Configure model",
        prompt: "Read both notepads. Ask me how my AI is accessed: custom API endpoint, a named cloud model (OpenAI/Anthropic/Together/etc), or a local server. Then write the target config to the right notepad.",
      },
      {
        id: "setup_data",
        label: "Setup data",
        prompt: "Read both notepads. Ask me about my test data: do I have a ready file, data in a different format, or no data at all? Then write the data config to the left notepad.",
      },
      {
        id: "synthesize_data",
        label: "Synthesize data",
        prompt: "Use the generate_data tool to create synthetic test examples based on the task spec from Stage 1. Generate 10 examples. Write the generated data to the left notepad (Adapt tab), then summarize what was generated.",
      },
      {
        id: "validate",
        label: "Validate",
        prompt: "Use the validate_spec tool to check the complete benchmark specification across all three stages. Report any issues found and which stage to fix them in.",
      },
      {
        id: "run_benchmark",
        label: "Run benchmark",
        prompt: "Read both notepads and validate the full spec first. If valid, summarize what will be run: the task, scoring method, data source, and target model. Confirm I'm ready to execute.",
      },
      {
        id: "read_results",
        label: "Read results",
        prompt: "Read both notepads. Summarize the current benchmark configuration and any results or generated data visible in the notepads. Highlight key metrics and areas for improvement.",
      },
    ],
  },
  {
    id: 4,
    title: "Export",
    subtitle: "Assembled benchmark spec",
    layout: "export",
    left: [{ id: "export", label: "Export", textKey: "benchy-s4-export:text", defaultText: "" }],
    right: [],
    skills: [
      {
        id: "review_spec",
        label: "Review spec",
        prompt: "Use validate_spec to check the complete benchmark spec. Then summarize what this benchmark tests: the task type, input format, scoring method, data source, and target model. Flag any issues.",
      },
    ],
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function useTypingAnimation(text: string, enabled: boolean, delay = 600) {
  const [charIndex, setCharIndex] = useState(0);
  const [done, setDone] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) { setCharIndex(text.length); setDone(true); return; }
    const tick = (current: number) => {
      const next = current + 1;
      setCharIndex(next);
      if (next >= text.length) { setDone(true); return; }
      timerRef.current = setTimeout(() => tick(next), 1000 / 22 + Math.random() * 20);
    };
    timerRef.current = setTimeout(() => tick(0), delay);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, []);

  return { charIndex, done };
}

function loadStored<T>(key: string): T | null {
  try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : null; } catch { return null; }
}
function saveStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch { /* ignore */ }
}

function gatherAllNotepads() {
  const activeS2Tab = loadStored<string>("benchy-s2-tab") ?? "per_field";
  const s2ScoringYaml = activeS2Tab === "per_field"
    ? (loadStored<string>("benchy-s2-perfield:text") ?? STAGES[1].left[0].defaultText)
    : (loadStored<string>("benchy-s2-passfail:text") ?? STAGES[1].left[1].defaultText);
  return {
    s1: {
      left: loadStored<string>("benchy-s1-input-text:text") ?? STAGES[0].left[0].defaultText,
      right: loadStored<string>("benchy-s1-output:text") ?? STAGES[0].right[0].defaultText,
    },
    s2: { left: s2ScoringYaml, right: s2ScoringYaml },
    s3: {
      left: loadStored<string>("benchy-s3-data-adapt:text") ?? STAGES[2].left[1].defaultText,
      right: loadStored<string>("benchy-s3-target:text") ?? STAGES[2].right[0].defaultText,
    },
  };
}

function useDrag(initialX: number, initialY: number, storageKey: string) {
  const stored = loadStored<{ x: number; y: number }>(storageKey + ":pos");
  const [pos, setPos] = useState(stored ?? { x: initialX, y: initialY });
  const dragging = useRef(false);
  const startPointer = useRef({ x: 0, y: 0 });
  const startPos = useRef({ x: 0, y: 0 });
  const nodeRef = useRef<HTMLDivElement | null>(null);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    dragging.current = true;
    startPointer.current = { x: e.clientX, y: e.clientY };
    startPos.current = { ...pos };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, [pos]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragging.current) return;
    const dx = e.clientX - startPointer.current.x;
    const dy = e.clientY - startPointer.current.y;
    const node = nodeRef.current;
    const w = node?.offsetWidth ?? 200;
    const h = node?.offsetHeight ?? 100;
    setPos({
      x: Math.max(0, Math.min(window.innerWidth - w, startPos.current.x + dx)),
      y: Math.max(0, Math.min(window.innerHeight - h, startPos.current.y + dy)),
    });
  }, []);

  const onPointerUp = useCallback(() => {
    dragging.current = false;
    setPos(current => { saveStored(storageKey + ":pos", current); return current; });
  }, [storageKey]);

  return { pos, nodeRef, onPointerDown, onPointerMove, onPointerUp };
}

function useResize(storageKey: string, initialSize: { w: number; h: number } | null = null, minW = 140, minH = 56) {
  const stored = loadStored<{ w: number; h: number }>(storageKey + ":size");
  const [size, setSize] = useState<{ w: number; h: number } | null>(stored ?? initialSize);
  const resizing = useRef(false);
  const startPointer = useRef({ x: 0, y: 0 });
  const startSize = useRef({ w: 0, h: 0 });
  const containerRef = useRef<HTMLDivElement | null>(null);

  const onResizePointerDown = useCallback((e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    resizing.current = true;
    startPointer.current = { x: e.clientX, y: e.clientY };
    const el = containerRef.current;
    startSize.current = el ? { w: el.offsetWidth, h: el.offsetHeight } : { w: 200, h: 120 };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  }, []);

  const onResizePointerMove = useCallback((e: React.PointerEvent) => {
    if (!resizing.current) return;
    const dx = e.clientX - startPointer.current.x;
    const dy = e.clientY - startPointer.current.y;
    setSize({ w: Math.max(minW, startSize.current.w + dx), h: Math.max(minH, startSize.current.h + dy) });
  }, [minW, minH]);

  const onResizePointerUp = useCallback(() => {
    resizing.current = false;
    setSize(current => { if (current) saveStored(storageKey + ":size", current); return current; });
  }, [storageKey]);

  return { size, containerRef, onResizePointerDown, onResizePointerMove, onResizePointerUp };
}

function Cursor({ blink = false }: { blink?: boolean }) {
  return (
    <span
      className={`inline-block h-[1em] w-[0.55em] rounded-[1px] align-middle${blink ? " animate-blink" : ""}`}
      style={{ background: "var(--accent-p-500)", opacity: 0.7, marginLeft: "1px", verticalAlign: "text-bottom" }}
    />
  );
}

// ---------------------------------------------------------------------------
// DraggableNotepad — now supports optional tab bar
// ---------------------------------------------------------------------------

interface DraggableNotepadProps {
  initialX: number;
  initialY: number;
  initialSize?: { w: number; h: number };
  value: string;
  onChange: (text: string) => void;
  animate?: boolean;
  animDelay?: number;
  storageKey: string;
  textKey: string;
  label?: string;
  fontSize?: number;
  tabs?: { id: string; label: string }[];
  activeTab?: string;
  onTabChange?: (id: string) => void;
}

const DraggableNotepad = forwardRef<NotepadHandle, DraggableNotepadProps>(
  function DraggableNotepad(
    { initialX, initialY, initialSize, value, onChange, animate = false, animDelay = 600, storageKey, textKey, label, fontSize = 1.1, tabs, activeTab, onTabChange },
    ref,
  ) {
    const shouldAnimate = animate && loadStored<string>(textKey) === null;
    const { charIndex, done } = useTypingAnimation(value, shouldAnimate, animDelay);
    const [focused, setFocused] = useState(false);
    const [hovered, setHovered] = useState(false);
    const editRef = useRef<HTMLDivElement>(null);
    const animatingRef = useRef(shouldAnimate);
    const externalWriteRef = useRef(false);

    const { pos, nodeRef, onPointerDown, onPointerMove, onPointerUp } = useDrag(initialX, initialY, storageKey);
    const { size, containerRef, onResizePointerDown, onResizePointerMove, onResizePointerUp } = useResize(storageKey, initialSize ?? null);

    useImperativeHandle(ref, () => ({
      syncContent: (text: string) => {
        if (!editRef.current) return;
        animatingRef.current = false;
        externalWriteRef.current = true;
        editRef.current.textContent = text;
        const range = document.createRange();
        const sel = window.getSelection();
        range.selectNodeContents(editRef.current);
        range.collapse(false);
        sel?.removeAllRanges();
        sel?.addRange(range);
        externalWriteRef.current = false;
      },
    }), []);

    useEffect(() => {
      if (!editRef.current) return;
      editRef.current.textContent = shouldAnimate ? "" : value;
    }, []);

    useEffect(() => {
      if (!editRef.current || !animatingRef.current) return;
      editRef.current.textContent = value.slice(0, charIndex);
    }, [charIndex]);

    useEffect(() => {
      if (!shouldAnimate || !done || !editRef.current) return;
      const range = document.createRange();
      const sel = window.getSelection();
      range.selectNodeContents(editRef.current);
      range.collapse(false);
      sel?.removeAllRanges();
      sel?.addRange(range);
    }, [done]);

    const handlePointerDownOnText = (e: React.PointerEvent) => { e.stopPropagation(); };
    const handleFocus = () => { animatingRef.current = false; setFocused(true); };

    const handleInput = useCallback(() => {
      if (externalWriteRef.current) return;
      const text = editRef.current?.textContent ?? "";
      saveStored(textKey, text);
      onChange(text);
    }, [textKey, onChange]);

    const handleBlur = useCallback(() => {
      setFocused(false);
      const text = editRef.current?.textContent ?? "";
      saveStored(textKey, text);
      onChange(text);
    }, [textKey, onChange]);

    const textStyle: React.CSSProperties = {
      fontSize: `${fontSize}rem`,
      fontWeight: 400,
      letterSpacing: "0",
      lineHeight: 1.7,
      fontFamily: "var(--app-font-mono)",
      color: "var(--foreground)",
      opacity: 0.5,
      whiteSpace: size ? "pre-wrap" : "pre",
      wordBreak: "break-word",
      width: size ? "100%" : undefined,
      minHeight: size ? "100%" : undefined,
      minWidth: size ? undefined : "2ch",
      maxWidth: size ? "100%" : "80vw",
      outline: "none",
      cursor: "text",
      userSelect: "text",
      overflowY: size ? "auto" : undefined,
      boxSizing: "border-box",
    };

    const hasTabs = tabs && tabs.length > 1;

    return (
      <div
        ref={nodeRef}
        onPointerMove={(e) => { onPointerMove(e); onResizePointerMove(e); }}
        onPointerUp={() => { onPointerUp(); onResizePointerUp(); }}
        onPointerCancel={() => { onPointerUp(); onResizePointerUp(); }}
        style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 30, userSelect: "none", touchAction: "none" }}
      >
        <div
          onPointerDown={onPointerDown}
          aria-label="Drag handle"
          style={{ cursor: "grab", height: "24px", width: "100%", display: "flex", alignItems: "center", paddingLeft: 2 }}
        >
          {hasTabs ? (
            <div style={{ display: "flex", gap: 0 }}>
              {tabs!.map(tab => (
                <button
                  key={tab.id}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={() => onTabChange?.(tab.id)}
                  style={{
                    fontSize: "0.58rem",
                    fontFamily: "var(--app-font-mono)",
                    letterSpacing: "0.1em",
                    textTransform: "uppercase",
                    opacity: tab.id === activeTab ? 0.55 : 0.2,
                    userSelect: "none",
                    color: tab.id === activeTab ? "var(--accent-p-500)" : "var(--foreground)",
                    background: "none",
                    border: "none",
                    borderBottom: tab.id === activeTab ? "1.5px solid var(--accent-p-500)" : "1.5px solid transparent",
                    cursor: "pointer",
                    padding: "2px 10px 2px 0",
                    transition: "opacity 0.2s ease, color 0.2s ease",
                  }}
                >
                  {tab.label}
                </button>
              ))}
            </div>
          ) : label ? (
            <span style={{
              fontSize: "0.58rem",
              fontFamily: "var(--app-font-mono)",
              letterSpacing: "0.1em",
              textTransform: "uppercase",
              opacity: 0.28,
              userSelect: "none",
              color: "var(--foreground)",
            }}>
              {label}
            </span>
          ) : null}
        </div>

        <div
          ref={containerRef}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          className={hovered || focused ? "notepad-glow" : ""}
          style={{
            borderRadius: "14px",
            padding: "10px 14px 18px 14px",
            background: hovered || focused ? "rgba(251, 185, 60, 0.04)" : "transparent",
            border: "1px solid transparent",
            transition: "background 0.4s ease",
            display: "flex",
            alignItems: "baseline",
            gap: "3px",
            width: size ? size.w : undefined,
            height: size ? size.h : undefined,
            position: "relative",
            overflow: size ? "hidden" : undefined,
            boxSizing: "border-box",
          }}
        >
          <div
            ref={editRef}
            contentEditable
            suppressContentEditableWarning
            spellCheck={false}
            onPointerDown={handlePointerDownOnText}
            onFocus={handleFocus}
            onBlur={handleBlur}
            onInput={handleInput}
            style={textStyle}
          />
          {!focused && <Cursor blink={shouldAnimate ? done : true} />}

          <div
            onPointerDown={onResizePointerDown}
            title="Drag to resize"
            style={{
              position: "absolute",
              bottom: 4,
              right: 4,
              width: 18,
              height: 18,
              cursor: "se-resize",
              display: "flex",
              alignItems: "flex-end",
              justifyContent: "flex-end",
              opacity: hovered || focused ? 0.35 : 0,
              transition: "opacity 0.25s ease",
            }}
          >
            <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
              <path d="M2 9 L9 2 M5 9 L9 5 M8 9 L9 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </div>
        </div>
      </div>
    );
  },
);

// ---------------------------------------------------------------------------
// ScoringPanel — structured scoring editor for Stage 2
// ---------------------------------------------------------------------------

interface FieldWeight {
  name: string;
  weight: number;
}

function extractFieldsFromOutput(outputStr: string): FieldWeight[] {
  try {
    const parsed = JSON.parse(outputStr.trim());
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return Object.keys(parsed).map(name => ({ name, weight: 1 }));
    }
  } catch {}
  return [{ name: "field_1", weight: 1 }];
}

function parseWeightsFromYaml(yaml: string): FieldWeight[] {
  const lines = yaml.split("\n");
  let inWeights = false;
  const fields: FieldWeight[] = [];
  for (const line of lines) {
    if (/^\s*weights:\s*$/.test(line)) { inWeights = true; continue; }
    if (inWeights) {
      const m = line.match(/^\s{4}(\w[\w_]*):\s*([\d.]+)/);
      if (m) {
        fields.push({ name: m[1], weight: parseFloat(m[2]) || 1 });
      } else if (line.trim() && !/^\s{4}/.test(line)) {
        inWeights = false;
      }
    }
  }
  return fields;
}

function buildScoringYaml(tab: string, fields: FieldWeight[], caseSensitive: boolean): string {
  if (tab === "passfail") {
    return `scoring:\n  type: binary\n  case_sensitive: ${caseSensitive}`;
  }
  const weightLines = fields.map(f => `    ${f.name}: ${f.weight}`).join("\n");
  return `scoring:\n  type: per_field\n  partial_credit: true\n  case_sensitive: ${caseSensitive}\n  weights:\n${weightLines}`;
}

const ScoringPanel = forwardRef<NotepadHandle, {
  value: string;
  onChange: (text: string) => void;
  scoringTab: string;
  onTabChange: (tab: string) => void;
  storageKey: string;
  textKey: string;
  initialX: number;
  initialY: number;
  initialSize: { w: number; h: number };
}>(function ScoringPanel(
  { value, onChange, scoringTab, onTabChange, storageKey, textKey, initialX, initialY, initialSize },
  ref,
) {
  const [fields, setFields] = useState<FieldWeight[]>(() => {
    const stored = loadStored<FieldWeight[]>("benchy-s2-fields");
    if (stored && stored.length > 0) return stored;
    const fromYaml = parseWeightsFromYaml(value);
    if (fromYaml.length > 0) return fromYaml;
    return extractFieldsFromOutput(
      loadStored<string>("benchy-s1-output:text") ?? EXTRACTION_OUTPUT_DEFAULT
    );
  });
  const [caseSensitive, setCaseSensitive] = useState(() =>
    loadStored<boolean>("benchy-s2-case-sensitive") ?? value.includes("case_sensitive: true")
  );
  const [hovered, setHovered] = useState(false);

  const { pos, nodeRef, onPointerDown, onPointerMove, onPointerUp } = useDrag(initialX, initialY, storageKey);
  const { size, containerRef, onResizePointerDown, onResizePointerMove, onResizePointerUp } = useResize(storageKey, initialSize);

  useEffect(() => {
    saveStored("benchy-s2-fields", fields);
  }, [fields]);

  useEffect(() => {
    saveStored("benchy-s2-case-sensitive", caseSensitive);
  }, [caseSensitive]);

  const yamlRef = useRef("");
  useEffect(() => {
    const yaml = buildScoringYaml(scoringTab, fields, caseSensitive);
    if (yaml !== yamlRef.current) {
      yamlRef.current = yaml;
      onChange(yaml);
      saveStored(textKey, yaml);
    }
  }, [fields, caseSensitive, scoringTab, textKey]);

  useImperativeHandle(ref, () => ({
    syncContent: (text: string) => {
      const parsed = parseWeightsFromYaml(text);
      if (parsed.length > 0) setFields(parsed);
      if (text.includes("case_sensitive: true")) setCaseSensitive(true);
      else if (text.includes("case_sensitive: false")) setCaseSensitive(false);
    },
  }), []);

  const updateWeight = (idx: number, newWeight: number) => {
    setFields(prev => prev.map((f, i) => i === idx ? { ...f, weight: Math.max(0, newWeight) } : f));
  };

  const totalWeight = fields.reduce((sum, f) => sum + f.weight, 0);
  const exampleCorrect = Math.max(1, fields.length - 1);
  const exampleWeightSum = fields.slice(0, exampleCorrect).reduce((s, f) => s + f.weight, 0);
  const examplePct = totalWeight > 0 ? Math.round((exampleWeightSum / totalWeight) * 100) : 0;

  const tabs = [
    { id: "per_field", label: "Per-field" },
    { id: "passfail", label: "Pass/fail" },
  ];

  return (
    <div
      ref={nodeRef}
      onPointerMove={(e) => { onPointerMove(e); onResizePointerMove(e); }}
      onPointerUp={() => { onPointerUp(); onResizePointerUp(); }}
      onPointerCancel={() => { onPointerUp(); onResizePointerUp(); }}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 30, userSelect: "none", touchAction: "none" }}
    >
      <div
        onPointerDown={onPointerDown}
        aria-label="Drag handle"
        style={{ cursor: "grab", height: "24px", width: "100%", display: "flex", alignItems: "center", paddingLeft: 2 }}
      >
        <div style={{ display: "flex", gap: 0 }}>
          {tabs.map(tab => (
            <button
              key={tab.id}
              onPointerDown={(e) => e.stopPropagation()}
              onClick={() => onTabChange(tab.id)}
              style={{
                fontSize: "0.58rem",
                fontFamily: "var(--app-font-mono)",
                letterSpacing: "0.1em",
                textTransform: "uppercase",
                opacity: tab.id === scoringTab ? 0.55 : 0.2,
                userSelect: "none",
                color: tab.id === scoringTab ? "var(--accent-p-500)" : "var(--foreground)",
                background: "none",
                border: "none",
                borderBottom: tab.id === scoringTab ? "1.5px solid var(--accent-p-500)" : "1.5px solid transparent",
                cursor: "pointer",
                padding: "2px 10px 2px 0",
                transition: "opacity 0.2s ease, color 0.2s ease",
              }}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      <div
        ref={containerRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={hovered ? "notepad-glow" : ""}
        style={{
          borderRadius: "14px",
          padding: "14px 18px 24px 18px",
          background: hovered ? "rgba(251, 185, 60, 0.04)" : "transparent",
          border: "1px solid transparent",
          transition: "background 0.4s ease",
          width: size ? size.w : undefined,
          height: size ? size.h : undefined,
          position: "relative",
          overflow: size ? "auto" : undefined,
          boxSizing: "border-box",
          fontFamily: "var(--app-font-mono)",
          color: "var(--foreground)",
        }}
      >
        {scoringTab === "per_field" ? (
          <div style={{ opacity: 0.5, fontSize: "1rem", lineHeight: 1.9 }}>
            <div style={{ marginBottom: 10, fontWeight: 500, fontSize: "0.82rem", opacity: 0.7 }}>
              Each correct field earns points:
            </div>
            {fields.map((f, i) => (
              <div key={f.name} style={{ display: "flex", alignItems: "center", gap: 10, padding: "1px 0" }}>
                <span style={{ flex: 1, minWidth: 80 }}>{f.name}</span>
                <span style={{ color: "var(--accent-p-500)", opacity: 1, display: "flex", alignItems: "center", gap: 2 }}>
                  ×
                  <input
                    type="number"
                    min={0}
                    max={10}
                    step={0.5}
                    value={f.weight}
                    onChange={(e) => updateWeight(i, parseFloat(e.target.value) || 0)}
                    onPointerDown={(e) => e.stopPropagation()}
                    style={{
                      width: 38,
                      background: "transparent",
                      border: "none",
                      borderBottom: "1px dashed var(--accent-p-500)",
                      color: "var(--accent-p-500)",
                      fontFamily: "var(--app-font-mono)",
                      fontSize: "1rem",
                      textAlign: "center",
                      outline: "none",
                      padding: 0,
                      opacity: 1,
                    }}
                  />
                </span>
              </div>
            ))}
            <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", marginTop: 14, paddingTop: 10, fontSize: "0.82rem" }}>
              <div>total: {totalWeight} pts</div>
              <div style={{ marginTop: 4 }}>
                Example: {exampleCorrect}/{fields.length} correct → <span style={{ color: "var(--accent-p-500)", opacity: 1 }}>{examplePct}%</span>
              </div>
            </div>
            <div style={{ marginTop: 12, fontSize: "0.78rem", opacity: 0.6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} onPointerDown={(e) => e.stopPropagation()} />
                case sensitive
              </label>
            </div>
          </div>
        ) : (
          <div style={{ opacity: 0.5, fontSize: "1rem", lineHeight: 1.9 }}>
            <div style={{ marginBottom: 10, fontWeight: 500, fontSize: "0.82rem", opacity: 0.7 }}>
              All-or-nothing:
            </div>
            <div style={{ marginBottom: 6 }}>All fields must match exactly:</div>
            {fields.map(f => (
              <div key={f.name} style={{ padding: "1px 0", display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ color: "var(--accent-p-500)", opacity: 1 }}>✓</span>
                {f.name}
              </div>
            ))}
            <div style={{ borderTop: "1px solid rgba(0,0,0,0.06)", marginTop: 14, paddingTop: 10, fontSize: "0.82rem" }}>
              <div>✓ All correct → <span style={{ color: "var(--accent-p-500)", opacity: 1 }}>1 point</span></div>
              <div>✗ Any wrong  → 0 points</div>
            </div>
            <div style={{ marginTop: 12, fontSize: "0.78rem", opacity: 0.6 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                <input type="checkbox" checked={caseSensitive} onChange={(e) => setCaseSensitive(e.target.checked)} onPointerDown={(e) => e.stopPropagation()} />
                case sensitive
              </label>
            </div>
          </div>
        )}

        <div
          onPointerDown={onResizePointerDown}
          title="Drag to resize"
          style={{
            position: "absolute",
            bottom: 4,
            right: 4,
            width: 18,
            height: 18,
            cursor: "se-resize",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "flex-end",
            opacity: hovered ? 0.35 : 0,
            transition: "opacity 0.25s ease",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 9 L9 2 M5 9 L9 5 M8 9 L9 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// TaskTypePicker — center selector for extraction vs classification
// ---------------------------------------------------------------------------

function TaskTypePicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const options = [
    { id: "extraction", label: "Extraction", desc: "Extract structured fields" },
    { id: "classification", label: "Classification", desc: "Classify into categories" },
  ];
  return (
    <div style={{
      position: "fixed",
      left: "50%",
      top: "50%",
      transform: "translate(-50%, -50%)",
      zIndex: 35,
      display: "flex",
      flexDirection: "column",
      gap: 8,
    }}>
      {options.map(opt => {
        const active = opt.id === value;
        return (
          <button
            key={opt.id}
            onClick={() => onChange(opt.id)}
            style={{
              padding: "12px 18px",
              borderRadius: 12,
              border: active ? "2px solid var(--accent-p-500)" : "1px solid rgba(0,0,0,0.08)",
              background: active ? "rgba(251, 166, 42, 0.07)" : "rgba(255,255,255,0.5)",
              cursor: "pointer",
              textAlign: "left",
              backdropFilter: "blur(14px)",
              WebkitBackdropFilter: "blur(14px)",
              transition: "all 0.2s ease",
              boxShadow: active ? "0 2px 12px rgba(251,166,42,0.15)" : "0 1px 6px rgba(0,0,0,0.04)",
              width: 180,
            }}
          >
            <div style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              fontFamily: "var(--app-font-mono)",
              color: active ? "var(--accent-p-500)" : "var(--foreground)",
              opacity: active ? 1 : 0.45,
              letterSpacing: "0.02em",
            }}>
              {opt.label}
            </div>
            <div style={{
              fontSize: "0.6rem",
              fontFamily: "var(--app-font-mono)",
              opacity: 0.35,
              marginTop: 3,
              letterSpacing: "0.01em",
            }}>
              {opt.desc}
            </div>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StageNavBar — top-center pill showing 3 stages
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// BenchmarkNameInput — small fixed top-left editable name field
// ---------------------------------------------------------------------------

function BenchmarkNameInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [editing, setEditing] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const display = value.trim() || "untitled-benchmark";

  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: 16,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 6,
        padding: "5px 10px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.6)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(0,0,0,0.07)",
        boxShadow: "0 2px 14px rgba(0,0,0,0.07)",
        cursor: editing ? "text" : "pointer",
      }}
      title="Click to rename benchmark"
    >
      <span style={{ fontSize: "0.6rem", opacity: 0.45, fontFamily: "var(--app-font-mono)", userSelect: "none" }}>bench</span>
      {editing ? (
        <input
          ref={inputRef}
          value={value}
          onChange={e => onChange(e.target.value)}
          onBlur={() => setEditing(false)}
          onKeyDown={e => { if (e.key === "Enter" || e.key === "Escape") setEditing(false); }}
          placeholder="untitled-benchmark"
          style={{
            border: "none",
            outline: "none",
            background: "transparent",
            fontSize: "0.7rem",
            fontFamily: "var(--app-font-mono)",
            fontWeight: 500,
            color: "var(--foreground)",
            width: Math.max(120, display.length * 8),
            minWidth: 120,
            maxWidth: 240,
          }}
        />
      ) : (
        <span
          onClick={() => setEditing(true)}
          style={{
            fontSize: "0.7rem",
            fontFamily: "var(--app-font-mono)",
            fontWeight: 500,
            color: "var(--foreground)",
            opacity: value.trim() ? 1 : 0.35,
            userSelect: "none",
            minWidth: 120,
            maxWidth: 240,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            display: "inline-block",
          }}
        >
          {display}
        </span>
      )}
    </div>
  );
}

function StageNavBar({ stageIndex, onSelect }: { stageIndex: number; onSelect: (i: number) => void }) {
  return (
    <div
      style={{
        position: "fixed",
        top: 16,
        left: "50%",
        transform: "translateX(-50%)",
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        gap: 2,
        padding: "5px 8px",
        borderRadius: 999,
        background: "rgba(255,255,255,0.6)",
        backdropFilter: "blur(14px)",
        WebkitBackdropFilter: "blur(14px)",
        border: "1px solid rgba(0,0,0,0.07)",
        boxShadow: "0 2px 14px rgba(0,0,0,0.07)",
      }}
    >
      {STAGES.map((s, i) => {
        const active = i === stageIndex;
        return (
          <button
            key={s.id}
            onClick={() => onSelect(i)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 5,
              padding: "4px 11px",
              borderRadius: 999,
              border: "none",
              background: active ? "var(--accent-p-500)" : "transparent",
              color: active ? "#fff" : "var(--foreground)",
              opacity: active ? 1 : 0.4,
              fontSize: "0.7rem",
              fontWeight: active ? 600 : 400,
              cursor: "pointer",
              transition: "background 0.2s ease, opacity 0.2s ease, color 0.2s ease",
              letterSpacing: "0.02em",
              fontFamily: "var(--app-font-mono)",
              whiteSpace: "nowrap",
            }}
          >
            <span style={{ fontSize: "0.6rem", opacity: active ? 0.75 : 1 }}>{s.id}</span>
            {s.title}
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------------------
// StepPills — shows agent tool calls under a reply
// ---------------------------------------------------------------------------

type AgentStep = { tool: string; id: "left" | "right"; summary: string };

function StepPills({ steps }: { steps: AgentStep[] }) {
  if (!steps.length) return null;
  const labels = steps.map((s) => {
    if (s.tool === "read_notepad") return `Read ${s.id}`;
    if (s.tool === "write_notepad") return `Wrote ${s.id}`;
    if (s.tool === "insert_notepad") return `Inserted ${s.id}`;
    if (s.tool === "validate_spec") return "Validated spec";
    if (s.tool === "generate_data") return "Generated data";
    return s.summary;
  });
  const dedupedLabels = labels.filter((l, i) => labels.indexOf(l) === i);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 5 }}>
      {dedupedLabels.map((label, i) => (
        <span
          key={i}
          style={{
            fontSize: "0.68rem",
            padding: "1px 7px",
            borderRadius: 99,
            background: "rgba(251,166,42,0.13)",
            color: "var(--accent-p-500)",
            fontFamily: "var(--app-font-mono)",
            letterSpacing: "0.01em",
            opacity: 0.85,
          }}
        >
          {label}
        </span>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SkillPalette — clickable chips that fire structured prompts
// ---------------------------------------------------------------------------

function SkillPalette({
  skills,
  onSkill,
  disabled,
}: {
  skills: SkillChip[];
  onSkill: (prompt: string) => void;
  disabled: boolean;
}) {
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 5, paddingBottom: 6 }}>
      {skills.map((skill) => (
        <button
          key={skill.id}
          type="button"
          onClick={() => onSkill(skill.prompt)}
          disabled={disabled}
          style={{
            padding: "4px 11px",
            borderRadius: 999,
            border: "1px solid rgba(251,166,42,0.28)",
            background: "rgba(251,166,42,0.06)",
            color: "var(--accent-p-500)",
            fontSize: "0.71rem",
            fontFamily: "var(--app-font-mono)",
            cursor: disabled ? "not-allowed" : "pointer",
            opacity: disabled ? 0.35 : 1,
            transition: "background 0.15s ease, opacity 0.15s ease",
            letterSpacing: "0.01em",
          }}
          onMouseEnter={(e) => {
            if (!disabled) (e.currentTarget as HTMLElement).style.background = "rgba(251,166,42,0.14)";
          }}
          onMouseLeave={(e) => {
            (e.currentTarget as HTMLElement).style.background = "rgba(251,166,42,0.06)";
          }}
        >
          {skill.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// ChatBox — skill palette + optional freeform input + agent messages
// ---------------------------------------------------------------------------

type ChatMessage = { role: "user" | "assistant"; content: string; steps?: AgentStep[] };

function ChatBox({
  stage,
  skills,
  taskType,
  inputType,
  scoringTab,
  benchmarkName,
  onSetTaskType,
  onSwitchLeftTab,
}: {
  stage: 1 | 2 | 3 | 4;
  skills: SkillChip[];
  taskType: string;
  inputType: string;
  scoringTab: string;
  benchmarkName?: string;
  onSetTaskType?: (v: string) => void;
  onSwitchLeftTab?: (tabId: string) => void;
}) {
  const api = useNotepadAPI();
  const [input, setInput] = useState("");
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [focused, setFocused] = useState(false);
  const [inputOpen, setInputOpen] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "0px";
    ta.style.height = `${Math.max(ta.scrollHeight, 24)}px`;
  }, [input]);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages, loading]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "/" && document.activeElement === document.body) {
        e.preventDefault();
        setInputOpen(true);
        setTimeout(() => textareaRef.current?.focus(), 50);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  const send = useCallback(async (customPrompt?: string) => {
    const trimmed = (customPrompt ?? input).trim();
    if (!trimmed || loading) return;

    const userMsg: ChatMessage = { role: "user", content: trimmed };
    const next = [...messages, userMsg];
    setMessages(next);
    if (!customPrompt) setInput("");
    setLoading(true);

    try {
      const notepads = {
        left: api?.read("left") ?? "",
        right: api?.read("right") ?? "",
      };

      const allNotepads = gatherAllNotepads();

      if (stage === 1) {
        allNotepads.s1 = { left: notepads.left, right: notepads.right };
      } else if (stage === 2) {
        allNotepads.s2 = { left: notepads.left, right: notepads.left };
      } else if (stage === 3) {
        const s3LeftTabStored = loadStored<string>("benchy-s3-left-tab") ?? "input";
        const adaptText = s3LeftTabStored === "adapt"
          ? notepads.left
          : (loadStored<string>("benchy-s3-data-adapt:text") ?? STAGES[2].left[1].defaultText);
        allNotepads.s3 = { left: adaptText, right: notepads.right };
      }

      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages: next.map((m) => ({ role: m.role, content: m.content })),
          notepads,
          allNotepads,
          stage,
          taskType,
          inputType,
          scoringTab,
          benchmarkName: benchmarkName ?? "",
        }),
      });

      const data = await res.json() as {
        actions?: { op: string; id: "left" | "right"; text?: string; at?: number; tab?: string; value?: string }[];
        steps?: AgentStep[];
        reply?: string;
      };

      if (api && Array.isArray(data.actions)) {
        for (const action of data.actions) {
          if (action.op === "write" && action.text !== undefined) {
            if (action.tab && onSwitchLeftTab) {
              onSwitchLeftTab(action.tab);
              await new Promise(r => setTimeout(r, 50));
            }
            api.write(action.id, action.text);
          } else if (action.op === "insert" && action.text !== undefined && action.at !== undefined) {
            api.insert(action.id, action.text, action.at);
          } else if (action.op === "set_task_type" && action.value && onSetTaskType) {
            onSetTaskType(action.value);
          }
        }
      }

      const reply = data.reply ?? "Done.";
      setMessages((prev) => [...prev, { role: "assistant", content: reply, steps: data.steps ?? [] }]);
    } catch {
      setMessages((prev) => [...prev, { role: "assistant", content: "Something went wrong. Please try again." }]);
    } finally {
      setLoading(false);
      setTimeout(() => textareaRef.current?.focus(), 0);
    }
  }, [input, messages, loading, api, stage, taskType, inputType, scoringTab, onSetTaskType, onSwitchLeftTab]);

  const hasMessages = messages.length > 0;
  const empty = !input.trim();
  const innerShadow = focused ? "shadow-[inset_0_0_40px_0_oklch(0.968_0.033_83.7)]" : "";

  return (
    <div className="flex w-full flex-col gap-0">
      {hasMessages && (
        <div
          ref={scrollRef}
          style={{
            maxHeight: 200,
            overflowY: "auto",
            padding: "10px 14px 6px",
            display: "flex",
            flexDirection: "column",
            gap: 8,
          }}
        >
          {messages.map((m, i) => (
            <div key={i} style={{ alignSelf: m.role === "user" ? "flex-end" : "flex-start", maxWidth: "85%" }}>
              <div
                style={{
                  padding: "5px 10px",
                  borderRadius: m.role === "user" ? "12px 12px 3px 12px" : "12px 12px 12px 3px",
                  background: m.role === "user" ? "var(--accent-p-500)" : "rgba(0,0,0,0.06)",
                  color: m.role === "user" ? "#fff" : "var(--foreground)",
                  fontSize: "0.8rem",
                  lineHeight: 1.5,
                  opacity: m.role === "user" ? 0.9 : 0.7,
                }}
              >
                {m.content}
              </div>
              {m.role === "assistant" && m.steps && m.steps.length > 0 && (
                <StepPills steps={m.steps} />
              )}
            </div>
          ))}
          {loading && (
            <div style={{ alignSelf: "flex-start", padding: "5px 10px", borderRadius: "12px 12px 12px 3px", background: "rgba(0,0,0,0.06)", fontSize: "0.8rem", opacity: 0.4 }}>
              agent working…
            </div>
          )}
        </div>
      )}

      <div
        className={`relative flex w-full cursor-text flex-col rounded-xl border-2 bg-[var(--background)]`}
        style={{ borderColor: "#e4e4e4" }}
        onMouseDown={(e) => {
          if (!(e.target as HTMLElement).closest("textarea, button")) {
            e.preventDefault(); textareaRef.current?.focus();
          }
        }}
      >
        <div className="rounded-xl bg-[var(--background)] p-0.5">
          <div className={`flex flex-col gap-0 rounded-[11px] bg-gradient-to-b from-[var(--secondary)] to-transparent p-3 transition-shadow duration-500 ease-in-out ${innerShadow}`}>
            <SkillPalette skills={skills} onSkill={send} disabled={loading} />

            <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <button
                type="button"
                onClick={() => { setInputOpen((o) => !o); setTimeout(() => textareaRef.current?.focus(), 50); }}
                style={{
                  fontSize: "0.65rem",
                  fontFamily: "var(--app-font-mono)",
                  color: "var(--foreground)",
                  opacity: 0.3,
                  background: "none",
                  border: "none",
                  cursor: "pointer",
                  padding: "2px 0",
                  letterSpacing: "0.05em",
                  userSelect: "none",
                  transition: "opacity 0.15s ease",
                }}
                onMouseEnter={(e) => (e.currentTarget.style.opacity = "0.55")}
                onMouseLeave={(e) => (e.currentTarget.style.opacity = "0.3")}
              >
                {inputOpen ? "▲ close" : "▼ ask something specific"}
              </button>
            </div>

            {inputOpen && (
              <div className="relative mt-2 flex items-start border-t px-0.5 pt-2" style={{ borderColor: "rgba(0,0,0,0.06)" }}>
                <textarea
                  ref={textareaRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey && input.trim()) {
                      e.preventDefault(); send();
                    }
                  }}
                  onFocus={() => setFocused(true)}
                  onBlur={() => { if (!document.hidden) setFocused(false); }}
                  rows={1}
                  aria-label="Ask the agent something specific"
                  spellCheck={false}
                  placeholder="Ask something specific…"
                  className="w-full resize-none overflow-hidden bg-transparent pt-[2px] text-sm font-medium leading-5 text-[var(--foreground)] outline-none placeholder:text-[var(--neutral-400)]"
                />
                <button
                  type="button"
                  onClick={() => send()}
                  disabled={empty || loading}
                  aria-label="Send"
                  className="ml-2 flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-lg bg-[var(--primary)] text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CenterDivider
// ---------------------------------------------------------------------------

function CenterDivider() {
  const [hovered, setHovered] = useState(false);
  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ position: "fixed", left: "calc(50% - 48px)", top: 0, bottom: 0, width: 96, zIndex: 10, display: "flex", justifyContent: "center", pointerEvents: "auto", cursor: "default" }}
    >
      <div
        className={hovered ? "notepad-glow" : ""}
        style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: hovered ? "rgba(255,255,254,0.55)" : "transparent", opacity: hovered ? 1 : 0, transition: "opacity 0.5s ease, background 0.5s ease" }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// ExportPanel — Stage 4 read-only assembled YAML view
// ---------------------------------------------------------------------------

function ExportPanel({ taskType, inputType, benchmarkName, onAssembled }: { taskType: string; inputType: string; benchmarkName?: string; onAssembled?: (yaml: string) => void }) {
  const [assembledYaml, setAssembledYaml] = useState<string | null>(null);
  const [parseErrors, setParseErrors] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [validationErrors, setValidationErrors] = useState<string[] | null>(null);
  const [validating, setValidating] = useState(false);

  const { pos, nodeRef, onPointerDown, onPointerMove, onPointerUp } = useDrag(
    Math.round((typeof window !== "undefined" ? window.innerWidth : 1280) / 2 - 300),
    38,
    "notepad-export-v1",
  );
  const { size, containerRef, onResizePointerDown, onResizePointerMove, onResizePointerUp } = useResize(
    "notepad-export-v1",
    { w: 600, h: 625 },
  );
  const [hovered, setHovered] = useState(false);
  const [copiedYaml, setCopiedYaml] = useState(false);
  const [copiedCmd, setCopiedCmd] = useState(false);

  const copyToClipboard = (text: string, setter: (v: boolean) => void) => {
    navigator.clipboard.writeText(text).then(() => {
      setter(true);
      setTimeout(() => setter(false), 1800);
    });
  };

  const downloadYaml = () => {
    if (!assembledYaml) return;
    const blob = new Blob([assembledYaml], { type: "text/yaml" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${specName}.yaml`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  useEffect(() => {
    setLoading(true);
    setAssembledYaml(null);
    setParseErrors([]);
    setValidationErrors(null);
    setValidating(false);

    const notepads = gatherAllNotepads();
    const ctx = { notepads, taskType, inputType, benchmarkName: benchmarkName ?? "" };

    fetch("/api/benchmark/assemble", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(ctx),
    })
      .then(r => r.json())
      .then((data: { yaml?: string; parseErrors?: string[] }) => {
        const y = data.yaml ?? "";
        setAssembledYaml(y);
        setParseErrors(data.parseErrors ?? []);
        onAssembled?.(y);

        // Now validate with real benchy CLI
        setValidating(true);
        return fetch("/api/benchmark/validate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(ctx),
        });
      })
      .then(r => r?.json())
      .then((data: { valid?: boolean; errors?: string[] } | undefined) => {
        if (data) setValidationErrors(data.errors ?? []);
      })
      .catch(() => setParseErrors(["Failed to assemble benchmark spec."]))
      .finally(() => { setLoading(false); setValidating(false); });
  }, [taskType, inputType, benchmarkName]);

  const specName = (() => {
    if (!assembledYaml) return "untitled-benchmark";
    const m = assembledYaml.match(/\bname:\s*(.+)/);
    return m ? m[1].trim().replace(/^['"]|['"]$/g, "") : "untitled-benchmark";
  })();

  const w = size?.w ?? 600;
  const h = size?.h ?? 625;

  return (
    <div
      ref={nodeRef}
      style={{ position: "fixed", left: pos.x, top: pos.y, zIndex: 30, userSelect: "none" }}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
    >
      <div
        ref={containerRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        style={{
          width: w,
          height: h,
          borderRadius: 16,
          background: "rgba(255,255,255,0.62)",
          backdropFilter: "blur(28px)",
          WebkitBackdropFilter: "blur(28px)",
          border: "1px solid rgba(255,255,255,0.85)",
          boxShadow: "0 8px 40px rgba(0,0,0,0.10)",
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
          position: "relative",
        }}
      >
        <div
          onPointerDown={onPointerDown}
          style={{
            padding: "10px 16px 8px",
            cursor: "grab",
            borderBottom: "1px solid rgba(0,0,0,0.06)",
            display: "flex",
            alignItems: "center",
            gap: 8,
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "0.6rem", fontFamily: "var(--app-font-mono)", opacity: 0.4 }}>4</span>
          <span style={{ fontSize: "0.75rem", fontFamily: "var(--app-font-mono)", fontWeight: 600, opacity: 0.55, letterSpacing: "0.02em" }}>
            Export
          </span>
          {/* Validation status badge */}
          {!loading && (
            validating ? (
              <span style={{ fontSize: "0.6rem", fontFamily: "var(--app-font-mono)", opacity: 0.4, marginLeft: 6 }}>
                validating…
              </span>
            ) : validationErrors === null ? null
            : validationErrors.length === 0 && parseErrors.length === 0 ? (
              <span style={{
                fontSize: "0.6rem",
                fontFamily: "var(--app-font-mono)",
                fontWeight: 600,
                color: "#16a34a",
                background: "rgba(34,197,94,0.1)",
                border: "1px solid rgba(34,197,94,0.25)",
                borderRadius: 999,
                padding: "2px 7px",
                marginLeft: 6,
              }}>
                ✓ valid
              </span>
            ) : (
              <span style={{
                fontSize: "0.6rem",
                fontFamily: "var(--app-font-mono)",
                fontWeight: 600,
                color: "#dc2626",
                background: "rgba(220,38,38,0.08)",
                border: "1px solid rgba(220,38,38,0.2)",
                borderRadius: 999,
                padding: "2px 7px",
                marginLeft: 6,
              }}>
                ✗ {validationErrors.length + parseErrors.length} error{validationErrors.length + parseErrors.length !== 1 ? "s" : ""}
              </span>
            )
          )}
          <span style={{ marginLeft: "auto", fontSize: "0.62rem", fontFamily: "var(--app-font-mono)", opacity: 0.3 }}>
            benchmark.yaml
          </span>
          {!loading && assembledYaml && (
            <div style={{ display: "flex", gap: 4, marginLeft: 8 }}>
              <button
                onClick={() => copyToClipboard(assembledYaml, setCopiedYaml)}
                title="Copy YAML"
                style={{
                  background: copiedYaml ? "rgba(34,197,94,0.12)" : "rgba(0,0,0,0.04)",
                  border: "1px solid rgba(0,0,0,0.08)",
                  borderRadius: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: "0.62rem",
                  fontFamily: "var(--app-font-mono)",
                  color: copiedYaml ? "#16a34a" : "var(--foreground)",
                  opacity: copiedYaml ? 1 : 0.5,
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                {copiedYaml ? (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
                ) : (
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
                )}
                {copiedYaml ? "Copied" : "Copy"}
              </button>
              <button
                onClick={downloadYaml}
                title="Download YAML"
                style={{
                  background: "rgba(0,0,0,0.04)",
                  border: "1px solid rgba(0,0,0,0.08)",
                  borderRadius: 6,
                  padding: "3px 8px",
                  cursor: "pointer",
                  fontSize: "0.62rem",
                  fontFamily: "var(--app-font-mono)",
                  color: "var(--foreground)",
                  opacity: 0.5,
                  transition: "all 0.2s ease",
                  display: "flex",
                  alignItems: "center",
                  gap: 3,
                }}
              >
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                Download
              </button>
            </div>
          )}
        </div>

        <div style={{ flex: 1, overflow: "auto", padding: "14px 16px 8px" }}>
          {loading ? (
            <div style={{ opacity: 0.35, fontSize: "0.82rem", fontFamily: "var(--app-font-mono)" }}>
              Assembling spec…
            </div>
          ) : (
            <>
              {(parseErrors.length > 0 || (validationErrors && validationErrors.length > 0)) && (
                <div style={{ marginBottom: 12, padding: "8px 12px", borderRadius: 8, background: "rgba(220,38,38,0.05)", border: "1px solid rgba(220,38,38,0.15)" }}>
                  {[...parseErrors, ...(validationErrors ?? [])].map((e, i) => (
                    <div key={i} style={{ fontSize: "0.75rem", fontFamily: "var(--app-font-mono)", color: "#dc2626", lineHeight: 1.6 }}>
                      ✗ {e}
                    </div>
                  ))}
                </div>
              )}
              <pre
                style={{
                  margin: 0,
                  fontFamily: "var(--app-font-mono)",
                  fontSize: "0.82rem",
                  lineHeight: 1.65,
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  color: "var(--foreground)",
                  opacity: 0.75,
                }}
              >
                {assembledYaml ?? ""}
              </pre>
            </>
          )}
        </div>

        <div
          style={{
            flexShrink: 0,
            borderTop: "1px solid rgba(0,0,0,0.06)",
            padding: "10px 16px",
            background: "rgba(0,0,0,0.02)",
          }}
        >
          <div style={{ fontSize: "0.68rem", fontFamily: "var(--app-font-mono)", opacity: 0.4, marginBottom: 6 }}>
            Run your benchmark
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <div
              style={{
                flex: 1,
                padding: "8px 12px",
                borderRadius: 8,
                background: "rgba(0,0,0,0.04)",
                border: "1px solid rgba(0,0,0,0.06)",
                fontFamily: "var(--app-font-mono)",
                fontSize: "0.82rem",
                color: "var(--foreground)",
                opacity: 0.7,
                letterSpacing: "0.01em",
              }}
            >
              $ benchy eval benchmarks/{specName}.yaml
            </div>
            <button
              onClick={() => copyToClipboard(`benchy eval benchmarks/${specName}.yaml`, setCopiedCmd)}
              title="Copy command"
              style={{
                background: copiedCmd ? "rgba(34,197,94,0.12)" : "rgba(0,0,0,0.04)",
                border: "1px solid rgba(0,0,0,0.08)",
                borderRadius: 6,
                padding: "6px 10px",
                cursor: "pointer",
                fontSize: "0.62rem",
                fontFamily: "var(--app-font-mono)",
                color: copiedCmd ? "#16a34a" : "var(--foreground)",
                opacity: copiedCmd ? 1 : 0.5,
                transition: "all 0.2s ease",
                display: "flex",
                alignItems: "center",
                gap: 3,
                flexShrink: 0,
              }}
            >
              {copiedCmd ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
              ) : (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
              )}
              {copiedCmd ? "Copied" : "Copy"}
            </button>
          </div>
        </div>

        <div
          onPointerDown={onResizePointerDown}
          onPointerMove={onResizePointerMove}
          onPointerUp={onResizePointerUp}
          title="Drag to resize"
          style={{
            position: "absolute",
            bottom: 4,
            right: 4,
            width: 18,
            height: 18,
            cursor: "se-resize",
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "flex-end",
            opacity: hovered ? 0.35 : 0,
            transition: "opacity 0.25s ease",
          }}
        >
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path d="M2 9 L9 2 M5 9 L9 5 M8 9 L9 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sliders
// ---------------------------------------------------------------------------

function BrightnessSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ position: "fixed", bottom: 28, left: 24, zIndex: 40, display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 999, background: "rgba(255,255,255,0.55)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "1px solid rgba(0,0,0,0.07)", boxShadow: "0 2px 12px rgba(0,0,0,0.07)" }}>
      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity={0.4}>
        <circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" />
        <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
        <line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" />
        <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
      </svg>
      <input type="range" min={62} max={100} step={1} value={Math.round(value * 100)} onChange={(e) => onChange(parseInt(e.target.value) / 100)} className="brightness-slider" style={{ width: 88 }} />
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" opacity={0.55}>
        <circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="5" /><line x1="12" y1="19" x2="12" y2="22" />
        <line x1="4.22" y1="4.22" x2="6.34" y2="6.34" /><line x1="17.66" y1="17.66" x2="19.78" y2="19.78" />
        <line x1="2" y1="12" x2="5" y2="12" /><line x1="19" y1="12" x2="22" y2="12" />
        <line x1="4.22" y1="19.78" x2="6.34" y2="17.66" /><line x1="17.66" y1="6.34" x2="19.78" y2="4.22" />
      </svg>
    </div>
  );
}

function FontSizeSlider({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div style={{ position: "fixed", bottom: 28, right: 24, zIndex: 40, display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderRadius: 999, background: "rgba(255,255,255,0.55)", backdropFilter: "blur(12px)", WebkitBackdropFilter: "blur(12px)", border: "1px solid rgba(0,0,0,0.07)", boxShadow: "0 2px 12px rgba(0,0,0,0.07)" }}>
      <span style={{ fontSize: "10px", fontFamily: "var(--app-font-mono)", opacity: 0.4, lineHeight: 1, userSelect: "none" }}>A</span>
      <input type="range" min={60} max={200} step={1} value={Math.round(value * 100)} onChange={(e) => onChange(parseInt(e.target.value) / 100)} className="brightness-slider" style={{ width: 88 }} />
      <span style={{ fontSize: "16px", fontFamily: "var(--app-font-mono)", opacity: 0.55, lineHeight: 1, userSelect: "none" }}>A</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Home — owns stage state, tab state, notepad text, and NotepadAPI
// ---------------------------------------------------------------------------

const NOTEPAD_STORAGE_KEY: Record<NotepadId, string> = {
  right: "notepad-a-v3",
  left: "notepad-b-v5",
};

const DEFAULT_SIZE = { w: 569, h: 625 };
const CENTER_SIZE = { w: 600, h: 625 };
const DEFAULT_Y = 38;

function getActiveLeftTab(stageIndex: number, s1LeftTab: string, s2Tab: string, s3LeftTab: string): TabDef {
  const stage = STAGES[stageIndex];
  let tabId = "text";
  if (stageIndex === 0) tabId = s1LeftTab;
  else if (stageIndex === 1) tabId = s2Tab;
  else if (stageIndex === 2) tabId = s3LeftTab;
  return stage.left.find(t => t.id === tabId) ?? stage.left[0];
}

function getActiveRightTab(stageIndex: number): TabDef | null {
  const stage = STAGES[stageIndex];
  if (stage.right.length === 0) return null;
  return stage.right[0];
}

export default function Home() {
  const [brightness, setBrightness] = useState(0.955);
  const [fontSize, setFontSize] = useState(1.1);

  const [stageIndex, setStageIndex] = useState<number>(() => {
    const stored = loadStored<number>("benchy-stage-index") ?? 0;
    return Number.isInteger(stored) && stored >= 0 && stored < STAGES.length ? stored : 0;
  });

  const [s1LeftTab, setS1LeftTab] = useState(() => loadStored<string>("benchy-s1-left-tab") ?? "text");
  const [s1TaskType, setS1TaskType] = useState<string>(() => loadStored<string>("benchy-s1-task-type") ?? "extraction");
  const [s2Tab, setS2Tab] = useState(() => loadStored<string>("benchy-s2-tab") ?? "per_field");
  const [s3LeftTab, setS3LeftTab] = useState(() => loadStored<string>("benchy-s3-left-tab") ?? "input");
  const [benchmarkName, setBenchmarkName] = useState(() => loadStored<string>("benchy-benchmark-name") ?? "");

  const currentStage = STAGES[stageIndex] ?? STAGES[0];
  const isSingleCenter = currentStage.layout === "single-center";
  const isExport = currentStage.layout === "export";

  const stageRef = useRef(currentStage);
  stageRef.current = currentStage;

  const leftTabDef = getActiveLeftTab(stageIndex, s1LeftTab, s2Tab, s3LeftTab);
  const rightTabDef = getActiveRightTab(stageIndex);

  const leftTabRef = useRef(leftTabDef);
  leftTabRef.current = leftTabDef;
  const rightTabRef = useRef(rightTabDef);
  rightTabRef.current = rightTabDef;

  const [texts, setTexts] = useState<{ left: string; right: string }>(() => {
    const lt = leftTabDef;
    const rt = rightTabDef;
    return {
      left: loadStored<string>(lt.textKey) ?? lt.defaultText,
      right: rt ? (loadStored<string>(rt.textKey) ?? rt.defaultText) : "",
    };
  });

  const textsRef = useRef(texts);
  textsRef.current = texts;

  const leftRef = useRef<NotepadHandle>(null);
  const rightRef = useRef<NotepadHandle>(null);

  const handleChange = useCallback((id: NotepadId, text: string) => {
    setTexts((prev) => ({ ...prev, [id]: text }));
  }, []);

  const saveCurrentTexts = useCallback(() => {
    const lt = leftTabRef.current;
    const rt = rightTabRef.current;
    saveStored(lt.textKey, textsRef.current.left);
    if (rt) saveStored(rt.textKey, textsRef.current.right);
  }, []);

  const navigateToStage = useCallback((newIndex: number) => {
    if (newIndex === stageIndex) return;
    saveCurrentTexts();

    const newLeftTab = getActiveLeftTab(newIndex, s1LeftTab, s2Tab, s3LeftTab);
    const newRightTab = getActiveRightTab(newIndex);

    const newLeft = loadStored<string>(newLeftTab.textKey) ?? newLeftTab.defaultText;
    const newRight = newRightTab ? (loadStored<string>(newRightTab.textKey) ?? newRightTab.defaultText) : "";

    setTexts({ left: newLeft, right: newRight });
    setStageIndex(newIndex);
    saveStored("benchy-stage-index", newIndex);

    leftRef.current?.syncContent(newLeft);
    if (newRightTab) rightRef.current?.syncContent(newRight);
  }, [stageIndex, s1LeftTab, s2Tab, s3LeftTab, saveCurrentTexts]);

  const switchLeftTab = useCallback((newTabId: string) => {
    saveStored(leftTabRef.current.textKey, textsRef.current.left);

    if (stageIndex === 0) { setS1LeftTab(newTabId); saveStored("benchy-s1-left-tab", newTabId); }
    else if (stageIndex === 1) { setS2Tab(newTabId); saveStored("benchy-s2-tab", newTabId); }
    else if (stageIndex === 2) { setS3LeftTab(newTabId); saveStored("benchy-s3-left-tab", newTabId); }

    const newTab = currentStage.left.find(t => t.id === newTabId) ?? currentStage.left[0];
    const newText = loadStored<string>(newTab.textKey) ?? newTab.defaultText;
    setTexts(prev => ({ ...prev, left: newText }));
    leftRef.current?.syncContent(newText);
  }, [stageIndex, currentStage, saveCurrentTexts]);

  const handleTaskTypeChange = useCallback((newType: string) => {
    setS1TaskType(newType);
    saveStored("benchy-s1-task-type", newType);

    if (stageIndex === 0) {
      const rt = STAGES[0].right[0];
      const currentRight = textsRef.current.right;
      const isDefault = currentRight === EXTRACTION_OUTPUT_DEFAULT || currentRight === CLASSIFICATION_OUTPUT_DEFAULT;
      if (isDefault) {
        const newDefault = newType === "classification" ? CLASSIFICATION_OUTPUT_DEFAULT : EXTRACTION_OUTPUT_DEFAULT;
        setTexts(prev => ({ ...prev, right: newDefault }));
        saveStored(rt.textKey, newDefault);
        rightRef.current?.syncContent(newDefault);
      }
    }
  }, [stageIndex]);

  const notepadAPI = useMemo<NotepadAPI>(() => ({
    read(id) {
      return textsRef.current[id];
    },
    write(id, text) {
      setTexts((prev) => ({ ...prev, [id]: text }));
      const tabDef = id === "left" ? leftTabRef.current : rightTabRef.current;
      if (tabDef) {
        saveStored(tabDef.textKey, text);
        (id === "left" ? leftRef : rightRef).current?.syncContent(text);
      }
    },
    insert(id, text, at) {
      const current = textsRef.current[id];
      const clamped = Math.max(0, Math.min(at, current.length));
      const next = current.slice(0, clamped) + text + current.slice(clamped);
      setTexts((prev) => ({ ...prev, [id]: next }));
      const tabDef = id === "left" ? leftTabRef.current : rightTabRef.current;
      if (tabDef) {
        saveStored(tabDef.textKey, next);
        (id === "left" ? leftRef : rightRef).current?.syncContent(next);
      }
    },
  }), []);

  const activeLeftTabId = stageIndex === 0 ? s1LeftTab : stageIndex === 1 ? s2Tab : stageIndex === 2 ? s3LeftTab : "export";

  return (
    <NotepadAPIContext.Provider value={notepadAPI}>
      <main
        className="flex h-dvh flex-col overflow-x-hidden"
        style={{ background: `oklch(${brightness.toFixed(3)} 0 0)`, transition: "background 0.15s ease" }}
      >
        <BenchmarkNameInput
          value={benchmarkName}
          onChange={(v) => { setBenchmarkName(v); saveStored("benchy-benchmark-name", v); }}
        />
        <StageNavBar stageIndex={stageIndex} onSelect={navigateToStage} />

        {!isSingleCenter && !isExport && <CenterDivider />}

        {stageIndex === 0 && (
          <TaskTypePicker value={s1TaskType} onChange={handleTaskTypeChange} />
        )}

        {stageIndex === 1 ? (
          <ScoringPanel
            ref={leftRef}
            value={texts.left}
            onChange={(t) => handleChange("left", t)}
            scoringTab={s2Tab}
            onTabChange={switchLeftTab}
            storageKey="notepad-center-v2"
            textKey={leftTabDef.textKey}
            initialX={Math.round((typeof window !== "undefined" ? window.innerWidth : 1280) / 2 - CENTER_SIZE.w / 2)}
            initialY={DEFAULT_Y}
            initialSize={CENTER_SIZE}
          />
        ) : stageIndex === 3 ? (
          <ExportPanel
            taskType={s1TaskType}
            inputType={s1LeftTab}
            benchmarkName={benchmarkName}
            onAssembled={(yaml) => {
              setTexts(prev => ({ ...prev, left: yaml }));
              saveStored("benchy-s4-export:text", yaml);
            }}
          />
        ) : (
          <>
            <DraggableNotepad
              ref={leftRef}
              initialX={78}
              initialY={DEFAULT_Y}
              initialSize={DEFAULT_SIZE}
              value={texts.left}
              onChange={(t) => handleChange("left", t)}
              animate
              animDelay={1400}
              storageKey={NOTEPAD_STORAGE_KEY.left}
              textKey={leftTabDef.textKey}
              label={currentStage.left.length === 1 ? currentStage.left[0].label : undefined}
              fontSize={fontSize}
              tabs={currentStage.left.length > 1 ? currentStage.left.map(t => ({ id: t.id, label: t.label })) : undefined}
              activeTab={activeLeftTabId}
              onTabChange={switchLeftTab}
            />
            {rightTabDef && (
              <DraggableNotepad
                ref={rightRef}
                initialX={634}
                initialY={DEFAULT_Y}
                initialSize={DEFAULT_SIZE}
                value={texts.right}
                onChange={(t) => handleChange("right", t)}
                animate
                animDelay={500}
                storageKey={NOTEPAD_STORAGE_KEY.right}
                textKey={rightTabDef.textKey}
                label={rightTabDef.label}
                fontSize={fontSize}
              />
            )}
          </>
        )}

        <BrightnessSlider value={brightness} onChange={setBrightness} />
        <FontSizeSlider value={fontSize} onChange={setFontSize} />

        <div className="mt-auto sticky bottom-0 z-20 w-full px-4 pb-4 sm:px-8 sm:pb-6">
          <div className="mx-auto max-w-[640px]">
            <ChatBox
              key={stageIndex}
              stage={currentStage.id}
              skills={currentStage.skills}
              taskType={s1TaskType}
              inputType={s1LeftTab}
              scoringTab={s2Tab}
              benchmarkName={benchmarkName}
              onSetTaskType={handleTaskTypeChange}
              onSwitchLeftTab={switchLeftTab}
            />
          </div>
        </div>
      </main>
    </NotepadAPIContext.Provider>
  );
}
