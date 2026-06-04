import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import App from "./App";
import NodeLab from "./components/NodeLab";
import "./styles.css";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      retry: 1,
      staleTime: 2000,
    },
  },
});

// Temporary design-lab route: open the dashboard with `#/nodelab` to preview
// experimental power-flow node + link layouts. Remove once a variant is chosen.
const isNodeLab = window.location.hash.replace(/^#/, "").startsWith("/nodelab");

// Re-render the right tree when the hash route toggles.
window.addEventListener("hashchange", () => window.location.reload());

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      {isNodeLab ? <NodeLab /> : <App />}
    </QueryClientProvider>
  </React.StrictMode>
);
