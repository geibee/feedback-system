import { defineConfig } from "vite";

export default defineConfig({
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: "dist",
    emptyOutDir: false,
    sourcemap: false,
    lib: {
      entry: "src/index.ts",
      formats: ["es"],
      fileName: () => "feedback-redmine-plugin-with-react.es.js"
    }
  }
});
