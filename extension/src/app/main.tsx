import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "@/styles/globals.css";
import { App } from "./App";

// Ask Chrome not to evict StreamHunter's clips when the disk runs low (granted or not, shown in System Health).
void navigator.storage?.persist?.().catch(() => undefined);

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
