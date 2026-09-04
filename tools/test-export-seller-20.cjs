#!/usr/bin/env node
// Fact-only answers: no expectedCode/option-code lookup.
require('./classification-benchmark.cjs').cli('export').catch(error=>{console.error(error.message);process.exitCode=2;});
