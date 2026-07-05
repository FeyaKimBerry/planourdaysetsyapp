import React from "react";
import { STORAGE_KEY } from "./App.jsx";

/* ============================================================
   TOP-LEVEL ERROR BOUNDARY
   ------------------------------------------------------------
   One unhandled render error used to white-screen the whole app,
   which reads to a user as "it ate my wedding data". This catches
   any such crash and shows a calm, reassuring screen instead —
   their data is still safe in this browser's localStorage. It also
   offers a one-tap download of that raw data as a backup, just in
   case, before they reload.

   Error boundaries must be class components (no hook equivalent).
   ============================================================ */

export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidCatch(error, info) {
    // No telemetry backend yet — log so it's visible in the console.
    console.error("Planourdays crashed:", error, info);
  }

  downloadBackup = () => {
    try {
      const raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const blob = new Blob([raw], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `planourdays-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      // Storage blocked — nothing we can safely do from here.
    }
  };

  render() {
    if (!this.state.hasError) return this.props.children;

    const hasData = (() => {
      try {
        return !!window.localStorage.getItem(STORAGE_KEY);
      } catch {
        return false;
      }
    })();

    return (
      <div style={styles.page}>
        <div style={styles.card}>
          <div style={styles.emoji}>🤍</div>
          <h1 style={styles.title}>Something went wrong</h1>
          <p style={styles.body}>
            Sorry about that. Your wedding plan is still saved safely on this
            device — nothing has been lost.
          </p>
          {hasData && (
            <button style={styles.primary} onClick={this.downloadBackup}>
              Download my data (backup)
            </button>
          )}
          <button
            style={{ ...styles.ghost, marginTop: hasData ? 10 : 0 }}
            onClick={() => window.location.reload()}
          >
            Reload the app
          </button>
          <p style={styles.fine}>
            If this keeps happening, download your backup and contact us at
            plannerstorebymaki@gmail.com.
          </p>
        </div>
      </div>
    );
  }
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 24,
    background: "#fdf7f5",
    fontFamily:
      '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif',
    color: "#3a2e2c",
  },
  card: {
    maxWidth: 420,
    width: "100%",
    textAlign: "center",
    background: "#ffffff",
    border: "1px solid #f0dfdb",
    borderRadius: 22,
    padding: "36px 28px",
  },
  emoji: { fontSize: 40, marginBottom: 8 },
  title: { fontSize: 24, fontWeight: 600, margin: "0 0 10px" },
  body: { fontSize: 16, lineHeight: 1.6, color: "#7a655f", margin: "0 0 22px" },
  primary: {
    display: "block",
    width: "100%",
    border: "none",
    borderRadius: 999,
    padding: "13px 22px",
    background: "#b07a72",
    color: "#fff",
    fontWeight: 600,
    fontSize: 15,
    cursor: "pointer",
  },
  ghost: {
    display: "block",
    width: "100%",
    border: "1px solid #f0dfdb",
    borderRadius: 999,
    padding: "13px 22px",
    background: "#fff",
    color: "#3a2e2c",
    fontWeight: 600,
    fontSize: 15,
    cursor: "pointer",
  },
  fine: { fontSize: 13, color: "#b58e87", margin: "22px 0 0", lineHeight: 1.5 },
};
