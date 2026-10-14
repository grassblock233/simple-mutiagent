import { test } from 'node:test';
import assert from 'node:assert/strict';
import { add } from './math.mjs';
test('add returns the sum', () => {
  assert.equal(add(2, 1), 3);
  assert.equal(add(-2, 1), -1);
  assert.equal(add(0, 0), 0);
});
