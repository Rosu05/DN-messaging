const assert = require('node:assert/strict');
const test = require('node:test');
const { app } = require('../server');

let server;
let baseUrl;

test.before(async () => {
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

test.after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('health endpoint reports service status', async () => {
  const response = await fetch(`${baseUrl}/health`);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).status, 'ok');
});

test('protected endpoints reject unauthenticated requests', async () => {
  const meResponse = await fetch(`${baseUrl}/api/auth/me`);
  assert.deepEqual(await meResponse.json(), { authenticated: false, user: null });

  const contactsResponse = await fetch(`${baseUrl}/api/contacts`);
  assert.equal(contactsResponse.status, 401);

  const uploadResponse = await fetch(`${baseUrl}/uploads/example.txt`);
  assert.equal(uploadResponse.status, 401);

  const searchResponse = await fetch(`${baseUrl}/api/messages/search?q=hello`);
  assert.equal(searchResponse.status, 401);

  const historyResponse = await fetch(`${baseUrl}/api/conversations/friend/messages`);
  assert.equal(historyResponse.status, 401);
});
