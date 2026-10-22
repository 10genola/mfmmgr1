// Run every offline check from any working directory. No external packages needed.
const {spawnSync} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const commands = [
  ...fs.readdirSync(__dirname).filter(name => /\.(?:js|cjs)$/.test(name)).map(name => ['--check', name]),
  ['payment-tests.cjs'],
  ['failure-tests.cjs']
];
if (process.argv.includes('--browser')) commands.push(['browser-tests.cjs']);
for (const args of commands) {
  const resolved = args.map(arg => arg.endsWith('.js') || arg.endsWith('.cjs') ? path.join(__dirname, arg) : arg);
  const result = spawnSync(process.execPath, resolved, {stdio:'inherit'});
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log('\nAll offline checks passed. Google deployment and PayPal sandbox acceptance remain separate.');
