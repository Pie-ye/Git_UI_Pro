import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { GitKrakenContextActions } from "./components/GitKrakenContextActions";
import { GitKrakenGraphInteractions } from "./components/GitKrakenGraphInteractions";
import { TrellisCanvasPortal } from "./components/trellis/TrellisCanvasPortal";
import "./styles/app.css";
import "./styles/liquid-glass.css";
import "./styles/gitkraken.css";
import "./styles/gitkraken-context.css";
import "./styles/trellis.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <GitKrakenContextActions />
    <GitKrakenGraphInteractions />
    <TrellisCanvasPortal />
  </React.StrictMode>
);
