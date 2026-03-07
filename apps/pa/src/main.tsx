import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./ui/App";
import "./styles.css";

window.addEventListener("pageshow", (e) => {
  const pe = e as PageTransitionEvent;
  if (pe.persisted) window.location.reload();
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
