import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AuthGate } from "./auth/AuthGate";
import { ErrorBoundary } from "./components/ErrorBoundary";
import { ConfirmHost } from "./ui/confirm";
import { Toasts } from "./ui/toasts";
import { registerOffline } from "./offline/register";
import "./styles.css";

registerOffline();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ErrorBoundary>
      <AuthGate>{(auth) => <App auth={auth} />}</AuthGate>
      <Toasts />
      <ConfirmHost />
    </ErrorBoundary>
  </StrictMode>,
);
