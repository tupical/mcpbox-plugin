#!/usr/bin/env node
// git prepare-commit-msg: add "Daruma-Task: <id>" for the work/<id> branch or
// the tasks this agent session claimed. Installed by `mcpbox-claude git-hook
// install`; any failure leaves the message untouched and the commit proceeds.
import { pathToFileURL } from "node:url";

import { prepareCommitMsg } from "../lib/git-trailer.mjs";

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  prepareCommitMsg({ messageFile: process.argv[2] }).catch(() => {}).finally(() => process.exit(0));
}
