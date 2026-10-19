// HACK (DX-REPORT F-DX1): the same aliases as tsconfig.base.json, because an
// app outside the pnpm workspace cannot resolve @scalius/plugin-sdk.
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const at = (path: string) => fileURLToPath(new URL(path, import.meta.url));
const sdk = at("../packages/plugin-sdk/src/");

export default defineConfig({
  resolve: {
    alias: [
      { find: /^@scalius\/plugin-sdk\/storefront\/testing$/, replacement: `${sdk}storefront/testing.ts` },
      { find: /^@scalius\/plugin-sdk\/storefront\/jsx-dev-runtime$/, replacement: `${sdk}storefront/jsx-dev-runtime.ts` },
      { find: /^@scalius\/plugin-sdk\/storefront\/jsx-runtime$/, replacement: `${sdk}storefront/jsx-runtime.ts` },
      { find: /^@scalius\/plugin-sdk\/storefront$/, replacement: `${sdk}storefront/index.ts` },
      { find: /^@scalius\/plugin-sdk\/island$/, replacement: `${sdk}storefront/island.ts` },
      { find: /^@scalius\/plugin-sdk\/(testing|fixtures|manifest|runtime)$/, replacement: `${sdk}$1.ts` },
      { find: /^@scalius\/plugin-sdk$/, replacement: `${sdk}index.ts` },
      { find: /^@scalius\/shared\/(.*)$/, replacement: `${at("../packages/shared/src/")}$1` },
    ],
  },
  oxc: { jsx: { runtime: "automatic", importSource: "@scalius/plugin-sdk/storefront" } },
  test: { root: at("."), include: ["*/src/**/*.test.ts", "*/src/**/*.test.tsx"] },
});
