#!/usr/bin/env bash
# Idempotent repository bootstrap for alphavector-core.
# Runs after the repository is checked out. Must terminate (no long-running processes).
set -euo pipefail

# Resolve the repository root (this script lives in <repo>/.cursor).
cd "$(dirname "$0")/.."

# Node dependencies from the committed lockfile.
npm ci

# Fetch the Alpine minirootfs the tenant computer boots (cached after first run).
npm run prepare:image

# Compile TypeScript to dist/ (also serves as the type-check gate: npm run lint).
npm run build
