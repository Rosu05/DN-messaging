const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.join(__dirname, '..');

test('application JavaScript files have valid syntax', () => {
  for (const file of ['server.js', 'db.js', 'public/client.js']) {
    execFileSync(process.execPath, ['--check', path.join(root, file)]);
  }
});

test('deployment files and required frontend assets exist', () => {
  for (const file of ['Dockerfile', 'docker-compose.yml', 'public/index.html', 'public/style.css']) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `${file} is missing`);
  }
});

test('package exposes a test command', () => {
  const packageJson = require(path.join(root, 'package.json'));
  assert.equal(packageJson.scripts.test, 'node --test test/*.test.js');
});
