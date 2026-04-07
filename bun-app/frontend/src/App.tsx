import { Routes, Route } from "react-router-dom";
import Nav from "./Nav";
import Events from "./pages/Events";
import Tasks from "./pages/Tasks";
import Logs from "./pages/Logs";
import Settings from "./pages/Settings";
import Insights from "./pages/Insights";

export default function App() {
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh", overflow: "hidden" }}>
      <Nav />
      <div style={{ flex: 1, display: "flex", flexDirection: "column", overflow: "hidden" }}>
        <Routes>
          <Route path="/" element={<Events />} />
          <Route path="/events" element={<Events />} />
          <Route path="/tasks" element={<Tasks />} />
          <Route path="/insights" element={<Insights />} />
          <Route path="/logs" element={<Logs />} />
          <Route path="/settings" element={<Settings />} />
        </Routes>
      </div>
    </div>
  );
}
