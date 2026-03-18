import { NavLink } from "react-router-dom";

export default function Nav() {
  return (
    <nav style={navStyle}>
      <NavLink to="/" end style={({ isActive }) => ({ ...linkStyle, color: isActive ? "var(--text)" : "var(--text2)" })}>events</NavLink>
      <span style={sepStyle}>/</span>
      <NavLink to="/tasks" style={({ isActive }) => ({ ...linkStyle, color: isActive ? "var(--text)" : "var(--text2)" })}>tasks</NavLink>
      <span style={sepStyle}>/</span>
      <NavLink to="/logs" style={({ isActive }) => ({ ...linkStyle, color: isActive ? "var(--text)" : "var(--text2)" })}>logs</NavLink>
      <span style={sepStyle}>/</span>
      <NavLink to="/chat" style={({ isActive }) => ({ ...linkStyle, color: isActive ? "var(--text)" : "var(--text2)" })}>chat</NavLink>
      <span style={sepStyle}>/</span>
      <NavLink to="/settings" style={({ isActive }) => ({ ...linkStyle, color: isActive ? "var(--text)" : "var(--text2)" })}>settings</NavLink>
    </nav>
  );
}

const navStyle: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  padding: "0 16px",
  height: 38,
  borderBottom: "1px solid var(--border)",
  background: "var(--bg)",
  flexShrink: 0,
};

const linkStyle: React.CSSProperties = {
  fontSize: 10,
  padding: "4px 10px",
  borderRadius: 5,
  transition: "color 0.1s, background 0.1s",
};

const sepStyle: React.CSSProperties = {
  color: "var(--text3)",
  fontSize: 10,
  padding: "0 2px",
};
