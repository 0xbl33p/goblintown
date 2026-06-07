#!/usr/bin/env node
const packageSpec = process.argv[2] || "goblintown@latest";
process.stdout.write(
  JSON.stringify(
    {
      mcpServers: {
        goblintown: {
          command: "npx",
          args: ["-y", packageSpec, "mcp"],
        },
      },
    },
    null,
    2,
  ) + "\n",
);
