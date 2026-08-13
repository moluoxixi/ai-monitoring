#!/usr/bin/env node

import { Command } from "commander";

import { registerChannelCommand } from "./commands/channel/index.js";
import { runMem } from "./commands/mem.js";

const program = new Command();
program
  .name("moluoxixi-runtime")
  .description("AIRules-owned local runtime for bundled Moluoxixi capabilities")
  .version("0.1.0");

registerChannelCommand(program);

program
  .command("mem")
  .allowUnknownOption(true)
  .helpOption(false)
  .argument("[args...]")
  .action((args: string[] = []) => runMem(args));

await program.parseAsync(process.argv);
