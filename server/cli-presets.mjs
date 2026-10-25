// Locked-down invocations for subscription CLIs.
//
// Claude Code runs genuinely text-only: --safe-mode and --strict-mcp-config skip CLAUDE.md, skills,
// plugins, hooks, MCP servers and settings files; no tools are offered and every tool is denied.
// (Not --bare: it also skips the subscription login, and the CLI answers "Not logged in".)
//
// Codex CLI cannot switch its shell tool off. With JARVIS_ALLOW_TOOL_CLIS=1 it runs as tightly as
// it allows: read-only sandbox (no writes, no network for commands), web search, browser,
// computer use and apps disabled, no approvals, no rules or saved session, in an empty directory.
// It can still read files the server user can read, which is why it is opt-in.
export const CLI_PRESETS = {
  claude: (model) => [
    "--safe-mode", "--strict-mcp-config", "--disable-slash-commands",
    "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "", "--disallowedTools", "*", "--permission-prompts", "none",
    ...(model ? ["--model", model] : []),
  ],
  codex: (model) => [
    "exec", "--skip-git-repo-check", "--sandbox", "read-only", "--ephemeral", "--ignore-rules", "--color", "never",
    "-c", 'web_search="disabled"', "-c", 'approval_policy="never"',
    "--disable", "browser_use", "--disable", "computer_use", "--disable", "apps",
    ...(model ? ["-m", model] : []), "-",
  ],
};
export const TOOL_CLIS_ALLOWED = /^(1|true|yes)$/i.test(process.env.JARVIS_ALLOW_TOOL_CLIS || "");
