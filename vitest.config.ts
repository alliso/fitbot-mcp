import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Cada fichero toca process.env / mocks de módulos globales: mejor aislado.
    isolate: true,
    restoreMocks: true,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      reporter: ["text", "html", "lcov"],
      // Un poco por debajo de lo que hay hoy (~99% líneas / 97% ramas): margen
      // para no romper por un `if` nuevo, pero suficiente para cazar regresiones.
      thresholds: {
        lines: 95,
        functions: 95,
        branches: 92,
        statements: 95,
      },
    },
  },
});
