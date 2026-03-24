"use strict";

const fs = require("fs");
const path = require("path");

const LOG_DIR = path.join(__dirname, "../../logs");
const LOG_FILE = path.join(LOG_DIR, "runtime-events.log");

function toSafeJson(value) {
  try {
    return JSON.stringify(value);
  } catch (_) {
    return JSON.stringify({ error: "serialization_failed" });
  }
}

function appendRuntimeLog(event = {}) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `${new Date().toISOString()} ${toSafeJson(event)}\n`;
    fs.appendFileSync(LOG_FILE, line, "utf8");
    return LOG_FILE;
  } catch (_) {
    return null;
  }
}

module.exports = {
  appendRuntimeLog,
  LOG_FILE,
};
