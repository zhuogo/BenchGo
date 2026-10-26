#!/usr/bin/env node
import { main } from '../packages/benchgo-cli/src/cli.mjs';

await main(process.argv.slice(2));
