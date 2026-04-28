/**
 * @unionstreet/us-auth
 *
 * Per-profile credential management. Forked OAuth flows for ChatGPT/Codex,
 * Anthropic Claude Pro/Max, GitHub Copilot, Google Gemini CLI, Antigravity.
 *
 * The OAuth functions return credentials; persistence is the caller's job
 * (typically writing to <profile>/auth-profiles.json under file lock).
 */

export * from "./oauth/index.js";
