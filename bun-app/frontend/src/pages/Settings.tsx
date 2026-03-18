import { useState, useEffect } from "react";
import { fetchSettings, saveSettings } from "../api";

export default function Settings() {
  const [apiKey, setApiKey] = useState("");
  const [visible, setVisible] = useState(false);
  const [hasKey, setHasKey] = useState(false);
  const [status, setStatus] = useState<"idle" | "success" | "error">("idle");
  const [statusMsg, setStatusMsg] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetchSettings().then((data) => {
      setHasKey(!!data.has_key);
      if (data.has_key) {
        setApiKey("");
      }
    }).catch(() => {
      setStatus("error");
      setStatusMsg("could not connect to server");
    });
  }, []);

  const handleSave = async () => {
    if (!apiKey.trim() && !hasKey) return;
    setSaving(true);
    setStatus("idle");
    try {
      const res = await saveSettings({ openai_api_key: apiKey.trim() || undefined });
      if (res.ok) {
        setStatus("success");
        setStatusMsg("saved");
        setApiKey("");
        const data = await fetchSettings();
        setHasKey(!!data.has_key);
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
    <div style={pageStyle}>
      <div style={headerStyle}>
        <div style={titleStyle}>settings</div>
        <div style={subStyle}>configure interpretation and other options</div>
      </div>
      <div style={cardStyle}>
        <div style={sectionStyle}>
          <div style={labelStyle}>interpretation</div>
          <div style={fieldLabelStyle}>openai api key</div>
          <div style={fieldSubStyle}>
            used to generate event interpretations (gpt-5-mini). can also be set via OPENAI_API_KEY in .env
          </div>
          <div style={inputRowStyle}>
            <div style={inputWrapStyle}>
              <input
                type={visible ? "text" : "password"}
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder={hasKey ? "••••••••" : "sk-..."}
                style={inputStyle}
                autoComplete="off"
                spellCheck={false}
              />
              <button
                style={visBtnStyle}
                onClick={() => setVisible(!visible)}
              >
                {visible ? "◉" : "◎"}
              </button>
            </div>
            <button
              style={{ ...btnStyle, ...btnPrimaryStyle }}
              onClick={handleSave}
              disabled={saving}
            >
              {saving ? "saving..." : "save"}
            </button>
          </div>
        </div>
        {status !== "idle" && (
          <div style={statusRowStyle}>
            <div style={{ ...statusDotStyle, background: status === "success" ? "var(--green)" : "var(--red)" }} />
            <span>{statusMsg}</span>
          </div>
        )}
      </div>
    </div>
  );
}

const pageStyle: React.CSSProperties = {
  maxWidth: 480,
  width: "100%",
  padding: "28px 24px",
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

const visBtnStyle: React.CSSProperties = {
  position: "absolute",
  right: 6,
  background: "transparent",
  border: "none",
  color: "var(--text3)",
  fontSize: 11,
  cursor: "pointer",
  padding: 0,
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
