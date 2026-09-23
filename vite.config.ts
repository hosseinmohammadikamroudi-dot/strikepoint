import { defineConfig } from "vite";

export default defineConfig({
  server: { port: 5173, strictPort: false },
  build: {
    target: "es2022",
    // Hidden sourcemaps in production: .map files are uploaded but the bundle
    // carries no sourceMappingURL comment — players can't casually read
    // source while CI can still symbolicate error reports. Local dev builds
    // keep full inline maps.
    sourcemap: process.env.NODE_ENV === "production" ? "hidden" : true,
    rollupOptions: {
      output: {
        // three.js (~600 kB min, ~150 kB gzip) is the bulk of the payload;
        // isolating it keeps game-code iterations off the engine cache.
        manualChunks: { three: ["three", "three/webgpu"] },
      },
    },
    // The isolated vendor chunk legitimately exceeds the default 500 kB
    // limit; game chunks stay tiny, which is what the warning is for.
    chunkSizeWarningLimit: 900,
  },
});
