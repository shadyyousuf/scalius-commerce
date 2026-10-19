#!/usr/bin/env bash
# Typecheck, test and pack every scratch app with the repo's own tooling.
# Run from the repository root: bash scratch-apps/check.sh
set -euo pipefail
apps=(b2b-wholesale subscriptions marketplace engraving loyalty-referrals skin-pack erp-sync)
for app in "${apps[@]}" headless-next; do
  echo "== typecheck $app"
  node_modules/typescript7/bin/tsc -p "scratch-apps/$app/tsconfig.json"
done
echo "== tests"
node_modules/.bin/vitest run --config scratch-apps/vitest.config.ts
for app in "${apps[@]}"; do
  echo "== validate + pack $app"
  node scripts/plugins.mjs validate "scratch-apps/$app" | tail -1
  node scripts/plugins.mjs pack "scratch-apps/$app" | head -1
done
