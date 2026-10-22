// Locked-down, text-only invocations for subscription CLIs.
export const CLI_PRESETS = {
  claude: (model) => [
    "--bare", "-p", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
    "--tools", "", "--disallowedTools", "*", "--permission-prompts", "none",
    ...(model ? ["--model", model] : []),
  ],
};
