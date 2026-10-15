'use strict';

/**
 * 版本号核心逻辑（纯函数，可被 CLI 与测试同时复用）
 *
 * 用户指定的十进制进位规则：
 *   1.0 → 1.1 → ... → 1.9 → 2.0 → 2.1 ...
 * 永不出现 1.10。
 *
 * 存储策略：
 *   - package.json 的 version 字段必须是合法 semver，故存三段：1.0.0 / 1.1.0 / 2.0.0
 *   - displayVersion 与 GitHub Release tag 存两段：1.0 / 1.1 / 2.0
 */

const DECIMAL_MAX_MINOR = 9;

/**
 * 解析版本号，兼容 "1.0" / "1.0.0" / "v1.0" / " v2.0.0 "
 * @param {string} v
 * @returns {{major:number, minor:number, patch:number}}
 */
function parseVersion(v) {
  const s = String(v == null ? '' : v).trim().replace(/^v/i, '');
  const m = s.match(/^(\d+)\.(\d+)(?:\.(\d+))?$/);
  if (!m) {
    throw new Error(`版本号格式非法（期望 x.y 或 x.y.z）: ${JSON.stringify(v)}`);
  }
  return {
    major: Number(m[1]),
    minor: Number(m[2]),
    patch: m[3] !== undefined ? Number(m[3]) : 0
  };
}

/** 两段显示名：2.0 */
function formatDisplay(p) {
  return `${p.major}.${p.minor}`;
}

/** 三段 semver：2.0.0 */
function formatSemver(p) {
  return `${p.major}.${p.minor}.${p.patch}`;
}

/**
 * 十进制进位：minor 到 9 就进 major，minor 归 0
 * @param {string} displayVersion 当前版本，如 "1.9"
 * @returns {{major:number, minor:number, patch:number}} 进位后的版本对象
 */
function bumpDecimal(displayVersion) {
  const p = parseVersion(displayVersion);
  let { major, minor } = p;
  if (minor >= DECIMAL_MAX_MINOR) {
    major += 1;
    minor = 0;
  } else {
    minor += 1;
  }
  return { major, minor, patch: 0 };
}

/**
 * 按十进制语义比较版本号（不是 semver 语义！）
 * 关键：2.0 > 1.9（semver 里 1.9 < 1.10，但我们永不产生 1.10）
 * @returns {number} a>b 返回正数，a<b 返回负数，相等返回 0
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa.major !== pb.major) return pa.major - pb.major;
  return pa.minor - pb.minor;
}

/** 远端是否比本地新 */
function isNewer(remoteVersion, localVersion) {
  return compareVersions(remoteVersion, localVersion) > 0;
}

/** 从 GitHub Release tag 中提取版本号，兼容 "v1.0" / "1.0" / "幻想时刻-1.0" */
function extractVersionFromTag(tag) {
  if (tag == null) return null;
  const m = String(tag).match(/(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : null;
}

module.exports = {
  DECIMAL_MAX_MINOR,
  parseVersion,
  formatDisplay,
  formatSemver,
  bumpDecimal,
  compareVersions,
  isNewer,
  extractVersionFromTag
};
