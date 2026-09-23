const assert = require('node:assert/strict');
const test = require('node:test');

function current(snapshot, identity) {
  return snapshot.epoch === identity.epoch && snapshot.token === identity.token && snapshot.userId === identity.userId;
}

test('late history result is rejected after switching accounts', async () => {
  const a = { epoch: 1, token: 'token-a', userId: 'A' };
  const b = { epoch: 2, token: 'token-b', userId: 'B' };
  assert.equal(current(a, b), false);
});

test('A to B to A does not revive the old request', async () => {
  const firstA = { epoch: 1, token: 'token-a-1', userId: 'A' };
  const secondA = { epoch: 3, token: 'token-a-2', userId: 'A' };
  assert.equal(current(firstA, secondA), false);
  assert.equal(current(secondA, secondA), true);
});

test('captured user id selects the original store even after account switch', async () => {
  const stores = new Map([['A', new Map()], ['B', new Map()]]);
  const capturedUserId = 'A';
  const activeUserId = 'B';
  stores.get(capturedUserId).set('late-log', { owner: capturedUserId });
  assert.equal(stores.get(activeUserId).has('late-log'), false);
  assert.equal(stores.get(capturedUserId).get('late-log').owner, 'A');
});
