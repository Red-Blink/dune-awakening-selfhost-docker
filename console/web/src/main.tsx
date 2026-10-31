import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

async function boot() {
  if (import.meta.env.VITE_CONSOLE_PREVIEW === "true") {
    const { installPreview } = await import("../preview/installPreview");
    await import("../preview/preview.css");
    installPreview();
  }
  createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
}
void boot();
