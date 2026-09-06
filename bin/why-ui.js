#!/usr/bin/env node
import { runCli } from "../dist/daemon/cli.js";

runCli().catch((err) => {
  process.stderr.write(`[why-ui fatal error] ${err?.message || err}\n`);
  process.exit(1);
});