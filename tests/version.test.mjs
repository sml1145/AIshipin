import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../src/main/version-core.js');

test('解析版本号：兼容两段/三段/v前缀/空格', () => {
  assert.deepEqual(core.parseVersion('1.0'), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(core.parseVersion('1.0.0'), { major: 1, minor: 0, patch: 0 });
  assert.deepEqual(core.parseVersion('v2.3'), { major: 2, minor: 3, patch: 0 });
  assert.deepEqual(core.parseVersion('  1.9.0  '), { major: 1, minor: 9, patch: 0 });
});

test('解析非法版本号必须抛错，不得静默容错', () => {
  for (const bad of ['', null, undefined, 'abc', '1', '1.x', 'v', '1.2.3.4']) {
    assert.throws(() => core.parseVersion(bad), /版本号格式非法/);
  }
});

test('十进制进位：1.0→1.1，1.8→1.9', () => {
  assert.equal(core.formatDisplay(core.bumpDecimal('1.0')), '1.1');
  assert.equal(core.formatDisplay(core.bumpDecimal('1.1')), '1.2');
  assert.equal(core.formatDisplay(core.bumpDecimal('1.8')), '1.9');
});

test('十进制进位关键：1.9→2.0，且永不产生 1.10', () => {
  const next = core.bumpDecimal('1.9');
  assert.equal(core.formatDisplay(next), '2.0');
  assert.equal(core.formatSemver(next), '2.0.0');
  assert.notEqual(core.formatDisplay(next), '1.10');

  // 连续递进 12 次，验证进位链且任何一步都不出现两位 minor
  let v = '1.0';
  const seen = [v];
  for (let i = 0; i < 12; i++) {
    v = core.formatDisplay(core.bumpDecimal(v));
    seen.push(v);
  }
  assert.deepEqual(seen, [
    '1.0', '1.1', '1.2', '1.3', '1.4', '1.5', '1.6', '1.7', '1.8', '1.9',
    '2.0', '2.1', '2.2'
  ]);
  for (const s of seen) {
    const minor = Number(s.split('.')[1]);
    assert.ok(minor <= 9, `minor 超过 9: ${s}`);
  }
});

test('跨大版本进位：2.9→3.0', () => {
  assert.equal(core.formatDisplay(core.bumpDecimal('2.9')), '3.0');
  assert.equal(core.formatSemver(core.bumpDecimal('9.9')), '10.0.0');
});

test('版本比较：2.0 必须大于 1.9（十进制语义，非 semver）', () => {
  assert.ok(core.isNewer('2.0', '1.9'));
  assert.ok(core.isNewer('1.1', '1.0'));
  assert.ok(core.isNewer('10.0', '9.9'));
  assert.ok(!core.isNewer('1.9', '2.0'));
  assert.ok(!core.isNewer('1.0', '1.0'));
  assert.equal(core.compareVersions('1.9', '2.0') < 0, true);
  assert.equal(core.compareVersions('2.0', '2.0'), 0);
});

test('从 Release tag 提取版本号', () => {
  assert.equal(core.extractVersionFromTag('v1.0'), '1.0');
  assert.equal(core.extractVersionFromTag('1.0'), '1.0');
  assert.equal(core.extractVersionFromTag('幻想时刻-2.0-win'), '2.0');
  assert.equal(core.extractVersionFromTag('v1.0.0'), '1.0.0');
  assert.equal(core.extractVersionFromTag('no-version-here'), null);
  assert.equal(core.extractVersionFromTag(null), null);
});

test('semver 与显示名互转一致', () => {
  const p = core.parseVersion('1.9');
  assert.equal(core.formatSemver(p), '1.9.0');
  assert.equal(core.formatDisplay(core.parseVersion('1.9.0')), '1.9');
});
