const { test } = require('node:test')
const assert = require('node:assert/strict')
const { eventTimeDecay } = require('../event_time_decay')

test('automatic recall always protects 30 days regardless of query wording or dates', () => {
  for (const query of ['今天有什么需要处理的事情', '我最近在做哪些项目', '如何部署新版本', '明年去旅行有什么计划', '2027年5月3日安排会议', 'Configure port 1933 and Python 3.12']) {
    assert.equal(eventTimeDecay({ query }, { automatic: true }), '30d', query)
  }
  for (const query of ['去年旅行住哪家酒店', '之前那次会议说了什么', '还记得海拉尔那次旅行吗', '上个月我买了什么', '三年前在哪工作', '2025年旅游住哪家酒店', '2026-05-03 的项目结论', '5月3日那天的安排', 'Where did I stay last year?', 'What happened two months ago?', 'Trip in 2024', 'Remember when we visited Paris?']) {
    assert.equal(eventTimeDecay({ query }, { automatic: true }), '30d', query)
    assert.equal(eventTimeDecay({ query }), undefined, query)
  }
})

test('explicit settings win; ordinary searches remain neutral', () => {
  assert.equal(eventTimeDecay({ query: '今天的项目' }), undefined)
  assert.equal(eventTimeDecay({ query: '今天的项目', eventsTimeDecayProtection: null }, { automatic: true }), null)
  assert.equal(eventTimeDecay({ query: '去年旅行', eventsTimeDecayProtection: '14d' }, { automatic: true }), '14d')
  assert.equal(eventTimeDecay({ query: '去年旅行', events_time_decay_protection: '0' }), '0')
  assert.equal(eventTimeDecay({ query: '项目', until: '2025-01-01', eventsTimeDecayProtection: 'auto' }), '30d')
  assert.equal(eventTimeDecay({ query: '项目', since: '2025-01-01' }, { automatic: true }), '30d')
  assert.equal(eventTimeDecay({ text: '去年旅行', query: '旅行', eventsTimeDecayProtection: 'auto' }), '30d')
  for (const value of [false, 30, '', '-1d', '1.5d', '30D', 'all', '1095001d']) {
    assert.throws(() => eventTimeDecay({ eventsTimeDecayProtection: value }), { status: 400 })
  }
  assert.throws(() => eventTimeDecay({ eventsTimeDecayProtection: null, events_time_decay_protection: '30d' }), /Conflicting/)
})
