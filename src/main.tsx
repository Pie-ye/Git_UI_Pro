import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import { TrellisCanvasPortal } from "./components/trellis/TrellisCanvasPortal";
import "./styles/app.css";
import "./styles/liquid-glass.css";
import "./styles/trellis.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <TrellisCanvasPortal />
  </React.StrictMode>
);
