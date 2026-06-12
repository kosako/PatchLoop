"use strict";

const commonGlobals = {
  AbortController: "readonly",
  Blob: "readonly",
  Buffer: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  CustomEvent: "readonly",
  fetch: "readonly",
  File: "readonly",
  FormData: "readonly",
  Headers: "readonly",
  Promise: "readonly",
  Request: "readonly",
  Response: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  URLSearchParams: "readonly"
};

const browserGlobals = {
  ...commonGlobals,
  alert: "readonly",
  btoa: "readonly",
  CSS: "readonly",
  globalThis: "readonly",
  document: "readonly",
  FileReader: "readonly",
  getComputedStyle: "readonly",
  localStorage: "readonly",
  navigator: "readonly",
  Node: "readonly",
  requestAnimationFrame: "readonly",
  window: "readonly",
  XMLSerializer: "readonly"
};

const nodeGlobals = {
  ...commonGlobals,
  __dirname: "readonly",
  module: "readonly",
  process: "readonly",
  require: "readonly"
};

const sharedRules = {
  "no-constant-condition": "error",
  "no-dupe-args": "error",
  "no-dupe-keys": "error",
  "no-duplicate-case": "error",
  "no-empty": ["error", { allowEmptyCatch: true }],
  "no-fallthrough": "error",
  "no-irregular-whitespace": "error",
  "no-redeclare": "error",
  "no-self-assign": "error",
  "no-undef": "error",
  "no-unreachable": "error",
  "no-unused-vars": ["error", {
    argsIgnorePattern: "^_",
    caughtErrorsIgnorePattern: "^_",
    varsIgnorePattern: "^_"
  }],
  "use-isnan": "error",
  "valid-typeof": "error"
};

module.exports = [
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "dist/**",
      "server/feedback.json",
      "server/screenshots/**",
      "server/receiver.config.json"
    ]
  },
  {
    files: ["server/**/*.js", "scripts/**/*.js", "test/**/*.js", "eslint.config.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "commonjs",
      globals: nodeGlobals
    },
    rules: sharedRules
  },
  {
    // Shared by widget (browser) and receiver (Node): environment-free code
    // only, so no host globals are provided on purpose.
    files: ["shared/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: {}
    },
    rules: sharedRules
  },
  {
    files: ["widget/**/*.js"],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: "module",
      globals: browserGlobals
    },
    rules: sharedRules
  }
];
