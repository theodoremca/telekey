import React from "react";
import ReactDOM from "react-dom/client";

import { App } from "./settings/App";
import "./settings/settings.css";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
