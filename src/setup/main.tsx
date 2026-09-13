import React from "react";
import ReactDOM from "react-dom/client";

import { SetupWizard } from "./SetupWizard";
// The settings stylesheet first: it carries the tokens, rows and buttons this
// window reuses, and setup.css only adjusts what a checklist needs on top.
import "../settings/settings.css";
import "./setup.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <SetupWizard />
  </React.StrictMode>,
);
