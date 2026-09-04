const test = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
require('./setup.cjs');
const { startServer } = require('../server');

async function withServer(t, run) {
  const listener = startServer();
  await once(listener, 'listening');
  t.after(async () => {
    listener.closeAllConnections();
    await new Promise(resolve => listener.close(resolve));
  });
  await run('http://127.0.0.1:' + listener.address().port);
}

test('public assets load while credentials, database and repository files are denied', async t => {
  await withServer(t, async base => {
    for (const asset of ['/', '/styles.css', '/app.js', '/confirm-logic.js', '/decision-logic.js', '/ruling-view.js']) {
      const response = await fetch(base + asset);
      assert.equal(response.status, 200, asset);
      await response.arrayBuffer();
    }
    for (const privatePath of ['/llm.config.json', '/llm.config.example.json', '/server.js', '/hs_copilot.db', '/.git/config', '/deploy/ecosystem.config.cjs']) {
      const response = await fetch(base + privatePath);
      assert.equal(response.status, 403, privatePath);
      await response.arrayBuffer();
    }
  });
});

test('malformed encoded paths return 400 and keep the server available', { timeout: 3000 }, async t => {
  await withServer(t, async base => {
    const malformed = await fetch(base + '/%E0%A4%A', { signal: AbortSignal.timeout(1000) });
    assert.equal(malformed.status, 400);
    await malformed.arrayBuffer();
    const health = await fetch(base + '/api/health');
    assert.equal(health.status, 200);
    assert.equal((await health.json()).db, true);
  });
});
