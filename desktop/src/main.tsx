import React from "react";
import ReactDOM from "react-dom/client";
// Base styles first, so page stylesheets imported by components can override them.
import "./styles.css";
import App from "./App";
import { ToastProvider, TooltipLayer } from "./ui";
import { describe, installErrorLog, logError } from "./assistant/errors";

installErrorLog();

class RenderBoundary extends React.Component<
  { children: React.ReactNode },
  { failed: boolean; detail: string }
> {
  state = { failed: false, detail: "" };
  static getDerivedStateFromError(error: unknown) {
    return { failed: true, detail: describe(error) };
  }
  componentDidCatch(error: unknown, info: React.ErrorInfo) {
    logError(error, info.componentStack ?? "");
  }
  render() {
    if (this.state.failed)
      return (
        <div className="loading-screen">
          <h1>Let’s reopen your budget.</h1>
          <p>
            The screen encountered an error. Your last database save is safe,
            and any available recovery draft will be offered when you reload.
          </p>
          <button className="primary" onClick={() => location.reload()}>
            Reload application
          </button>
          <details className="crash-details">
            <summary>Details</summary>
            <pre>{this.state.detail}</pre>
          </details>
        </div>
      );
    return this.props.children;
  }
}
ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <RenderBoundary>
      <ToastProvider>
        <App />
        <TooltipLayer />
      </ToastProvider>
    </RenderBoundary>
  </React.StrictMode>,
);
