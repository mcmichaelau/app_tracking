import { useState, useEffect, useRef } from "react";
import { fetchSettings, saveSettings, fetchUsage, type ApiUsageSummary } from "../api";

type KeySource = "env" | "config" | "none";
type Provider = "openai" | "anthropic" | "gemini";
type RoutingConfig = "interpretation_llm" | "task_classifier_llm" | "interpretation_base_url";

const INTERPRETATION_LLM_OPTIONS = [
  { value: "", label: "default (groq/llama-3.3-70b-versatile)" },
  { value: "groq/llama-3.3-70b-versatile", label: "groq / llama-3.3-70b-versatile" },
  { value: "groq/llama-3.1-8b-instant", label: "groq / llama-3.1-8b-instant" },
  { value: "openai/gpt-5-mini", label: "openai / gpt-5-mini" },
  { value: "openai/gpt-4.1", label: "openai / gpt-4.1" },
  { value: "openai/gpt-4.1-mini", label: "openai / gpt-4.1-mini" },
  { value: "openai/gpt-4.1-nano", label: "openai / gpt-4.1-nano" },
  { value: "openai/o4-mini", label: "openai / o4-mini" },
  { value: "anthropic/claude-opus-4-5", label: "anthropic / claude-opus-4-5" },
  { value: "anthropic/claude-sonnet-4-5", label: "anthropic / claude-sonnet-4-5" },
  { value: "anthropic/claude-haiku-4-5", label: "anthropic / claude-haiku-4-5" },
  { value: "anthropic/claude-3-5-haiku-20241022", label: "anthropic / claude-3-5-haiku-20241022" },
  { value: "gemini/gemini-2.0-flash", label: "gemini / gemini-2.0-flash" },
  { value: "gemini/gemini-2.5-pro-preview-03-25", label: "gemini / gemini-2.5-pro" },
];

const CLASSIFIER_LLM_OPTIONS = [
  { value: "", label: "default (groq/llama-3.3-70b-versatile)" },
  { value: "groq/llama-3.3-70b-versatile", label: "groq / llama-3.3-70b-versatile" },
  { value: "groq/qwen/qwen3-32b", label: "groq / qwen/qwen3-32b" },
  { value: "anthropic/claude-haiku-4-5-20251001", label: "anthropic / claude-haiku-4-5-20251001" },
  { value: "anthropic/claude-haiku-4-5", label: "anthropic / claude-haiku-4-5" },
  { value: "anthropic/claude-3-5-haiku-20241022", label: "anthropic / claude-3-5-haiku-20241022" },
  { value: "anthropic/claude-sonnet-4-5", label: "anthropic / claude-sonnet-4-5" },
  { value: "openai/gpt-5-mini", label: "openai / gpt-5-mini" },
  { value: "openai/gpt-4.1-mini", label: "openai / gpt-4.1-mini" },
  { value: "openai/gpt-4.1-nano", label: "openai / gpt-4.1-nano" },
  { value: "gemini/gemini-2.0-flash", label: "gemini / gemini-2.0-flash" },
];

function Select({ value, onChange, options }: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = options.find(o => o.value === value) ?? options[0];

  return (
    <div ref={ref} style={{ position: "relative", width: "100%" }}>
      <div onClick={() => setOpen(o => !o)} style={selectTriggerStyle}>
        <span>{selected.label}</span>
        <span style={chevronStyle}>▾</span>
      </div>
      {open && (
        <div style={selectMenuStyle}>
          {options.map(o => (
            <div
              key={o.value}
              style={{ ...selectOptionStyle, ...(o.value === value ? selectOptionActiveStyle : {}) }}
              onMouseDown={() => { onChange(o.value); setOpen(false); }}
            >
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const [keys, setKeys] = useState<Record<Provider, string>>({ openai: "", anthropic: "", gemini: "" });
  const [fallbackKeys, setFallbackKeys] = useState({ interpretation_api_key: "", groq_api_key: "" });
  const [routing, setRouting] = useState<Record<RoutingConfig, string>>({
    interpretation_llm: "",
    task_classifier_llm: "",
    interpretation_base_url: "",
  });
  const [maskedFallbackKeys, setMaskedFallbackKeys] = useState({ interpretation_api_key: "", groq_api_key: "" });
  const [state, setState] = useState<Record<Provider, { hasKey: boolean; source: KeySource; masked: string }>>({
    openai: { hasKey: false, source: "none", masked: "" },
    anthropic: { hasKey: false, source: "none", masked: "" },
    gemini: { hasKey: false, source: "none", masked: "" },
  });
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [saving, setSaving] = useState(false);
  const [usage, setUsage] = useState<ApiUsageSummary | null>(null);
  const [timezone, setTimezone] = useState("");

  const applySettings = (data: Awaited<ReturnType<typeof fetchSettings>>) => {
    setState({
      openai: { hasKey: !!data.openai?.has_key, source: data.openai?.source ?? "none", masked: data.openai_api_key ?? "" },
      anthropic: { hasKey: !!data.anthropic?.has_key, source: data.anthropic?.source ?? "none", masked: data.anthropic_api_key ?? "" },
      gemini: { hasKey: !!data.gemini?.has_key, source: data.gemini?.source ?? "none", masked: data.gemini_api_key ?? "" },
    });
    setRouting({
      interpretation_llm: data.interpretation_llm ?? "",
      task_classifier_llm: data.task_classifier_llm ?? "",
      interpretation_base_url: data.interpretation_base_url ?? "",
    });
    setMaskedFallbackKeys({
      interpretation_api_key: data.interpretation_api_key ?? "",
      groq_api_key: data.groq_api_key ?? "",
    });
    setTimezone(data.timezone ?? "");
  };

  useEffect(() => {
    fetchSettings().then(applySettings).catch(() => {
      setStatus("error");
      setStatusMsg("could not connect to server");
    });
    fetchUsage().then(setUsage).catch(() => {});
  }, []);

  const handleSave = async () => {
    const openai = keys.openai.trim();
    const anthropic = keys.anthropic.trim();
    const gemini = keys.gemini.trim();
    const interpretationApiKey = fallbackKeys.interpretation_api_key.trim();
    const groqApiKey = fallbackKeys.groq_api_key.trim();
    const interpretationLlm = routing.interpretation_llm.trim();
    const taskClassifierLlm = routing.task_classifier_llm.trim();
    const interpretationBaseUrl = routing.interpretation_base_url.trim();
    const tz = timezone.trim();
    if (!openai && !anthropic && !gemini && !interpretationApiKey && !groqApiKey && !interpretationLlm && !taskClassifierLlm && !interpretationBaseUrl && !tz) return;
    setSaving(true);
    setStatus("idle");
    try {
      const res = await saveSettings({
        openai_api_key: openai || undefined,
        anthropic_api_key: anthropic || undefined,
        gemini_api_key: gemini || undefined,
        interpretation_api_key: interpretationApiKey || undefined,
        groq_api_key: groqApiKey || undefined,
        interpretation_llm: interpretationLlm || undefined,
        task_classifier_llm: taskClassifierLlm || undefined,
        interpretation_base_url: interpretationBaseUrl || undefined,
        timezone: tz,
      });
      if (res.ok) {
        setStatus("success");
        setStatusMsg("saved");
        setKeys({ openai: "", anthropic: "", gemini: "" });
        setFallbackKeys({ interpretation_api_key: "", groq_api_key: "" });
        const data = await fetchSettings();
        applySettings(data);
      } else {
        setStatus("error");
        setStatusMsg("failed to save");
      }
    } catch {
      setStatus("error");
      setStatusMsg("could not connect to server");
    } finally {
      setSaving(false);
      setTimeout(() => setStatus("idle"), 3000);
    }
  };

  return (
    <div style={scrollWrapStyle}>
    <div style={pageStyle}>
      <div style={headerStyle}>
        <div style={titleStyle}>settings</div>
        <div style={subStyle}>configure interpretation and other options</div>
      </div>
      <div style={cardStyle}>
        <div style={sectionStyle}>
          <div style={labelStyle}>interpretation</div>
          <div style={fieldLabelStyle}>openai api key</div>
          <div style={fieldSubStyle}>optional — override interpretation key. env var: OPENAI_API_KEY</div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <input
                type="password"
                value={keys.openai}
                onChange={(e) => setKeys((prev) => ({ ...prev, openai: e.target.value }))}
                placeholder={state.openai.source === "env" ? "set via .env (OPENAI_API_KEY)" : state.openai.masked}
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div style={fieldSpacerStyle} />

          <div style={fieldLabelStyle}>anthropic api key</div>
          <div style={fieldSubStyle}>saved for config fallback. env var: ANTHROPIC_API_KEY</div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <input
                type="password"
                value={keys.anthropic}
                onChange={(e) => setKeys((prev) => ({ ...prev, anthropic: e.target.value }))}
                placeholder={state.anthropic.source === "env" ? "set via .env (ANTHROPIC_API_KEY)" : state.anthropic.masked}
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div style={fieldSpacerStyle} />

          <div style={fieldLabelStyle}>gemini api key</div>
          <div style={fieldSubStyle}>saved for config fallback. env var: GEMINI_API_KEY</div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <input
                type="password"
                value={keys.gemini}
                onChange={(e) => setKeys((prev) => ({ ...prev, gemini: e.target.value }))}
                placeholder={state.gemini.source === "env" ? "set via .env (GEMINI_API_KEY)" : state.gemini.masked}
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div style={fieldSpacerStyle} />

          <div style={fieldLabelStyle}>groq api key</div>
          <div style={fieldSubStyle}>used for groq/openai-compatible routing. env var: GROQ_API_KEY</div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <input
                type="password"
                value={fallbackKeys.groq_api_key}
                onChange={(e) => setFallbackKeys((prev) => ({ ...prev, groq_api_key: e.target.value }))}
                placeholder={maskedFallbackKeys.groq_api_key}
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
          <div style={fieldSpacerStyle} />

          <div style={fieldLabelStyle}>interpretation llm</div>
          <div style={fieldSubStyle}>model used for event interpretation</div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <Select
                value={routing.interpretation_llm}
                onChange={(v) => setRouting((prev) => ({ ...prev, interpretation_llm: v }))}
                options={INTERPRETATION_LLM_OPTIONS}
              />
            </div>
          </div>
          <div style={fieldSpacerStyle} />

          <div style={fieldLabelStyle}>task classifier llm</div>
          <div style={fieldSubStyle}>model used for task classification</div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <Select
                value={routing.task_classifier_llm}
                onChange={(v) => setRouting((prev) => ({ ...prev, task_classifier_llm: v }))}
                options={CLASSIFIER_LLM_OPTIONS}
              />
            </div>
          </div>
          <div style={fieldSpacerStyle} />

          <div style={fieldLabelStyle}>timezone</div>
          <div style={fieldSubStyle}>
            IANA name (e.g. America/New_York). Stored event times use this zone. Leave empty to use the server default.
          </div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <input
                type="text"
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
                placeholder="America/New_York"
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
            </div>
          </div>
        </div>
        <div style={actionsStyle}>
          <button
            style={{ ...btnStyle, ...btnPrimaryStyle }}
            onClick={handleSave}
            disabled={saving}
          >
            {saving ? "saving..." : "save"}
          </button>
        </div>
        {status !== "idle" && (
          <div style={statusRowStyle}>
            <div style={{ ...statusDotStyle, background: status === "success" ? "var(--green)" : "var(--red)" }} />
            <span>{statusMsg}</span>
          </div>
        )}
      </div>
      {usage && (
        <div style={cardStyle}>
          <div style={sectionStyle}>
            <div style={labelStyle}>api costs</div>
            <div style={usagePeriodRow}>
              {([
                ["today",    usage.today],
                ["7 days",   usage.week],
                ["30 days",  usage.month],
                ["all time", usage.allTime],
              ] as const).map(([label, p]) => (
                <div key={label} style={usagePeriodCell}>
                  <div style={usagePeriodLabel}>{label}</div>
                  <div style={usagePeriodCost}>${p.cost_usd.toFixed(4)}</div>
                  <div style={usagePeriodTokens}>
                    {fmtTokens(p.input_tokens + p.output_tokens)} tok
                  </div>
                </div>
              ))}
            </div>
            {usage.byModel.length > 0 && (
              <div style={{ marginTop: 14 }}>
                <div style={{ ...fieldLabelStyle, marginBottom: 6 }}>breakdown</div>
                <table style={usageTableStyle}>
                  <thead>
                    <tr>
                      {["model", "operation", "in tok", "out tok", "cost"].map(h => (
                        <th key={h} style={usageThStyle}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {usage.byModel.map((row, i) => (
                      <tr key={i}>
                        <td style={usageTdStyle}>{row.model}</td>
                        <td style={usageTdStyle}>{row.operation}</td>
                        <td style={{ ...usageTdStyle, ...usageTdNumStyle }}>{fmtTokens(row.input_tokens)}</td>
                        <td style={{ ...usageTdStyle, ...usageTdNumStyle }}>{fmtTokens(row.output_tokens)}</td>
                        <td style={{ ...usageTdStyle, ...usageTdNumStyle }}>${row.cost_usd.toFixed(4)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {usage.byModel.length === 0 && (
              <div style={{ fontSize: 10, color: "var(--text3)", marginTop: 10 }}>
                no usage recorded yet — costs will appear once the app processes events
              </div>
            )}
          </div>
        </div>
      )}
    </div>
    </div>
  );
}

function fmtTokens(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(2) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "k";
  return String(n);
}

const scrollWrapStyle: React.CSSProperties = {
  flex: 1,
  overflowY: "auto",
  display: "flex",
  justifyContent: "center",
};

const pageStyle: React.CSSProperties = {
  maxWidth: 480,
  width: "100%",
  padding: "28px 24px",
  boxSizing: "border-box",
};

const headerStyle: React.CSSProperties = { marginBottom: 20 };
const titleStyle: React.CSSProperties = { fontSize: 13, fontWeight: 600, marginBottom: 4 };
const subStyle: React.CSSProperties = { fontSize: 10, color: "var(--text3)" };

const cardStyle: React.CSSProperties = {
  background: "var(--bg2)",
  border: "0.5px solid var(--border)",
  borderRadius: 8,
  overflow: "hidden",
  marginBottom: 16,
};

const sectionStyle: React.CSSProperties = {
  padding: "14px 16px",
  borderBottom: "0.5px solid var(--border)",
};

const labelStyle: React.CSSProperties = {
  fontSize: 9,
  color: "var(--text3)",
  textTransform: "uppercase",
  letterSpacing: "0.06em",
  marginBottom: 12,
};

const fieldLabelStyle: React.CSSProperties = { fontSize: 10, fontWeight: 500, marginBottom: 2 };
const fieldSubStyle: React.CSSProperties = { fontSize: 10, color: "var(--text3)", marginBottom: 10 };
const fieldSpacerStyle: React.CSSProperties = { height: 10 };

const inputRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
};

const inputWrapStyle: React.CSSProperties = {
  flex: 1,
  position: "relative",
  display: "flex",
  alignItems: "center",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--bg)",
  border: "0.5px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "6px 30px 6px 8px",
  outline: "none",
};

const selectTriggerStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  width: "100%",
  background: "var(--bg3)",
  border: "0.5px solid var(--border)",
  borderRadius: 5,
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 10,
  padding: "5px 8px",
  cursor: "pointer",
  userSelect: "none",
};

const chevronStyle: React.CSSProperties = {
  color: "var(--text3)",
  fontSize: 10,
  marginLeft: 6,
  flexShrink: 0,
};

const selectMenuStyle: React.CSSProperties = {
  position: "absolute",
  top: "calc(100% + 2px)",
  left: 0,
  right: 0,
  zIndex: 100,
  background: "var(--bg3)",
  border: "0.5px solid var(--border)",
  borderRadius: 5,
  overflow: "hidden",
  boxShadow: "0 4px 12px rgba(0,0,0,0.4)",
};

const selectOptionStyle: React.CSSProperties = {
  padding: "6px 8px",
  fontSize: 10,
  color: "var(--text2)",
  fontFamily: "inherit",
  cursor: "pointer",
};

const selectOptionActiveStyle: React.CSSProperties = {
  color: "var(--text)",
  background: "var(--bg-hover)",
};

const btnStyle: React.CSSProperties = {
  background: "var(--bg3)",
  border: "0.5px solid var(--border)",
  color: "var(--text)",
  fontFamily: "inherit",
  fontSize: 10,
  fontWeight: 600,
  padding: "0 14px",
  height: 28,
  borderRadius: 5,
  cursor: "pointer",
  flexShrink: 0,
};

const btnPrimaryStyle: React.CSSProperties = {
  background: "var(--accent)",
  borderColor: "transparent",
  color: "#fff",
};

const actionsStyle: React.CSSProperties = {
  display: "flex",
  justifyContent: "flex-end",
  padding: "10px 16px",
};

const statusRowStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  padding: "10px 16px",
  fontSize: 10,
  color: "var(--text3)",
  minHeight: 36,
};

const statusDotStyle: React.CSSProperties = {
  width: 5,
  height: 5,
  borderRadius: "50%",
  flexShrink: 0,
};

const usagePeriodRow: React.CSSProperties = {
  display: "flex",
  gap: 2,
  marginTop: 8,
};

const usagePeriodCell: React.CSSProperties = {
  flex: 1,
  background: "var(--bg)",
  border: "0.5px solid var(--border)",
  borderRadius: 6,
  padding: "8px 10px",
};

const usagePeriodLabel: React.CSSProperties = {
  fontSize: 9,
  color: "var(--text3)",
  textTransform: "uppercase",
  letterSpacing: "0.04em",
  marginBottom: 4,
};

const usagePeriodCost: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: "var(--text)",
  marginBottom: 2,
  fontVariantNumeric: "tabular-nums",
};

const usagePeriodTokens: React.CSSProperties = {
  fontSize: 9,
  color: "var(--text3)",
  fontVariantNumeric: "tabular-nums",
};

const usageTableStyle: React.CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: 9,
};

const usageThStyle: React.CSSProperties = {
  textAlign: "left",
  color: "var(--text3)",
  fontWeight: 500,
  padding: "3px 6px 3px 0",
  borderBottom: "0.5px solid var(--border)",
  whiteSpace: "nowrap",
};

const usageTdStyle: React.CSSProperties = {
  padding: "4px 6px 4px 0",
  color: "var(--text2)",
  borderBottom: "0.5px solid rgba(255,255,255,0.04)",
  whiteSpace: "nowrap",
  overflow: "hidden",
  textOverflow: "ellipsis",
  maxWidth: 120,
};

const usageTdNumStyle: React.CSSProperties = {
  color: "var(--text)",
  fontVariantNumeric: "tabular-nums",
};
