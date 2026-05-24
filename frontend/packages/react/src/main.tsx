import React from "react";
import ReactDOM from "react-dom/client";
import { RuntimeProvider } from "./runtime";
import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <RuntimeProvider>
      <App />
    </RuntimeProvider>
  </React.StrictMode>
);
