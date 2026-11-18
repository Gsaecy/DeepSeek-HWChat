import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentSteering } from '../agent/steering';

test('a new message aborts the current generation and is consumed exactly once', () => {
  const steering = new AgentSteering();
  assert.equal(steering.signal.aborted, false);
  assert.equal(steering.hasPending(), false);

  steering.request();
  assert.equal(steering.signal.aborted, true, '正在生成的回答要立刻被叫停');
  assert.equal(steering.hasPending(), true);

  assert.equal(steering.consume(), true);
  assert.equal(steering.hasPending(), false);
  assert.equal(steering.signal.aborted, false, '消费后必须换一把新锁，否则第二次暂停不了');
  assert.equal(steering.consume(), false, '同一次暂停只消费一次');
});

test('messages sent in the same window collapse into one pause', () => {
  const steering = new AgentSteering();
  steering.request();
  steering.request();
  steering.request();
  assert.equal(steering.consume(), true);
  assert.equal(steering.hasPending(), false);
  assert.equal(steering.signal.aborted, false);
});

test('pausing again after a resume works (the lock is replaced, not reused)', () => {
  const steering = new AgentSteering();
  steering.request();
  steering.consume();
  steering.request();
  assert.equal(steering.signal.aborted, true);
  assert.equal(steering.hasPending(), true);
  assert.equal(steering.consume(), true);
});
