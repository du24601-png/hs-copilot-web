#!/usr/bin/env node
// Difficult set: preserve empty-answer protocol.
require('./classification-benchmark.cjs').cli('difficult').catch(error=>{console.error(error.message);process.exitCode=2;});
