/**
 * Canonical Garden client lives in `src/api/garden.js`.
 * This file re-exports it so any `require` from the repo root stays in sync.
 */
module.exports = require("./src/api/garden");
