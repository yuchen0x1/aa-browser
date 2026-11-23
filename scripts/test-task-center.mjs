import assert from 'node:assert/strict'
const { TaskCenter, TaskStateError } = await import('../src/main/task-center.ts')

const center = new TaskCenter()
const normal = center.create({ id: 'normal', maxRetries: 1 })
assert.equal(normal.state, 'pending')
center.transition('normal', 'running')
center.transition('normal', 'completed')
assert.equal(center.get('normal').state, 'completed')
assert.throws(() => center.transition('normal', 'running'), TaskStateError)

const risky = center.create({ id: 'risky', highRisk: true, maxRetries: 1 })
center.transition(risky.id, 'running')
const waiting = center.requestRecovery(risky.id, 'renderer crash')
assert.equal(waiting.state, 'waiting')
assert.equal(waiting.history.at(-1).details.requiresConfirmation, true)
const recovering = center.requestRecovery(risky.id, 'user confirmed', true)
assert.equal(recovering.state, 'recovering')
assert.equal(recovering.retryCount, 1)

console.log('PASS: task lifecycle transitions, bounded retries, and high-risk confirmation gate')

