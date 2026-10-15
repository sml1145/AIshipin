'use strict';

/**
 * 密钥与配置的加密存储
 *
 * 安全要求（用户的密钥绝不能泄露）：
 *   - API Key 用 Electron safeStorage 加密后落盘，明文永不出现在磁盘上
 *   - safeStorage 在 Windows 上基于 DPAPI，绑定当前用户账户，换机/换用户无法解密
 *   - 配置文件与密钥文件分开：config.json 存非敏感设置（可诊断），secrets.bin 存加密密钥
 *   - 两个文件都在 userData 目录，且 .gitignore 已排除，绝不入仓、绝不随安装包分发
 *   - safeStorage 不可用时（极少数环境）明确报错并拒绝落盘，不降级成明文存储
 */

const fs = require('node:fs');
const path = require('node:path');

/** 非敏感配置的默认值 */
const DEFAULT_CONFIG = {
  workspaceId: '',           // 百炼地域端点的业务空间 ID，留空用通用端点
  extraMirrors: [],          // 用户自定义的更新加速镜像
  preferredTrack: 'auto',    // auto | cloud | local —— 用户可强制指定生成轨道
  autoCheckUpdate: true,     // 启动时自动检查更新
  localModelId: 'local-ltx-2b-fp8',
  outputPath: '',            // 留空则用默认的「视频/幻想时刻」目录
  maxConcurrentTasks: 2,
  ui: { theme: 'dark', fontSize: 14 }
};

/** 支持的密钥种类，与 models.json 的 provider 对应 */
const SECRET_KINDS = ['dashscope', 'siliconflow', 'modelscope', 'huggingface', 'replicate', 'fal'];

class SecretStore {
  /**
   * @param {object} opts
   * @param {object} opts.paths paths.js 的结果
   * @param {object} [opts.safeStorage] Electron 的 safeStorage；不传则尝试 require('electron')
   * @param {object} [opts.fsImpl] 注入以便测试
   */
  constructor(opts = {}) {
    this.paths = opts.paths;
    this.fs = opts.fsImpl || fs;
    this._safeStorage = opts.safeStorage !== undefined ? opts.safeStorage : null;
    this._configCache = null;
  }

  /** 取得 safeStorage（延迟解析，便于在非 Electron 环境下注入替身） */
  get safeStorage() {
    if (this._safeStorage !== null) return this._safeStorage;
    try {
      // eslint-disable-next-line global-require
      const { safeStorage } = require('electron');
      this._safeStorage = safeStorage || null;
    } catch {
      this._safeStorage = null;
    }
    return this._safeStorage;
  }

  /** 加密能力是否可用 */
  isEncryptionAvailable() {
    const ss = this.safeStorage;
    try {
      return Boolean(ss && typeof ss.isEncryptionAvailable === 'function' && ss.isEncryptionAvailable());
    } catch {
      return false;
    }
  }

  /* ============ 非敏感配置 ============ */

  loadConfig() {
    if (this._configCache) return { ...this._configCache };
    const file = this.paths.configFile;
    let stored = {};
    try {
      if (this.fs.existsSync(file)) {
        stored = JSON.parse(this.fs.readFileSync(file, 'utf8')) || {};
      }
    } catch (err) {
      // 配置损坏不应让软件起不来：保留备份后用默认值
      try {
        this.fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
      } catch { /* 忽略 */ }
      stored = {};
      stored._loadError = String(err.message || err);
    }
    this._configCache = { ...DEFAULT_CONFIG, ...stored };
    return { ...this._configCache };
  }

  saveConfig(patch) {
    const next = { ...this.loadConfig(), ...(patch || {}) };
    delete next._loadError;
    // 只允许已知字段落盘，防止把意外对象写进配置
    const clean = {};
    for (const k of Object.keys(DEFAULT_CONFIG)) {
      if (next[k] !== undefined) clean[k] = next[k];
    }
    this.fs.mkdirSync(path.dirname(this.paths.configFile), { recursive: true });
    this.fs.writeFileSync(this.paths.configFile, JSON.stringify(clean, null, 2), 'utf8');
    this._configCache = clean;
    return { ...clean };
  }

  /* ============ 加密密钥 ============ */

  _readSecretsRaw() {
    const file = this.paths.secretsFile;
    try {
      if (!this.fs.existsSync(file)) return {};
      const buf = this.fs.readFileSync(file);
      if (!buf || buf.length === 0) return {};
      const ss = this.safeStorage;
      if (!ss || typeof ss.decryptString !== 'function') {
        throw new Error('当前环境不支持 safeStorage 解密，无法读取已保存的密钥');
      }
      const json = ss.decryptString(buf);
      return JSON.parse(json) || {};
    } catch (err) {
      // 解密失败（换机器/换用户）不抛给上层崩溃，返回空并标注原因
      return { _decryptError: String(err.message || err) };
    }
  }

  _writeSecretsRaw(obj) {
    const ss = this.safeStorage;
    if (!ss || typeof ss.encryptString !== 'function' || !this.isEncryptionAvailable()) {
      // 绝不降级为明文存储：宁可拒绝保存，也不能把密钥明文写盘
      const err = new Error('系统加密能力（safeStorage）不可用，为安全起见拒绝以明文保存 API Key。请改用其他 Windows 账户或检查系统密钥服务。');
      err.code = 'ENCRYPTION_UNAVAILABLE';
      throw err;
    }
    const clean = { ...obj };
    delete clean._decryptError;
    const buf = ss.encryptString(JSON.stringify(clean));
    this.fs.mkdirSync(path.dirname(this.paths.secretsFile), { recursive: true });
    this.fs.writeFileSync(this.paths.secretsFile, buf);
  }

  /** 列出已配置密钥的通道（只返回是否已配置，绝不返回密钥内容） */
  listConfiguredKinds() {
    const raw = this._readSecretsRaw();
    const out = {};
    for (const k of SECRET_KINDS) {
      out[k] = Boolean(raw[k] && String(raw[k]).length > 0);
    }
    return { configured: out, decryptError: raw._decryptError || null };
  }

  /** 取某个通道的密钥；未配置返回 null */
  getKey(kind) {
    if (!SECRET_KINDS.includes(kind)) {
      throw new Error(`未知的密钥类型: ${kind}（支持 ${SECRET_KINDS.join(', ')}）`);
    }
    const raw = this._readSecretsRaw();
    const v = raw[kind];
    return v && String(v).length > 0 ? String(v) : null;
  }

  /** 保存密钥（加密落盘） */
  setKey(kind, value) {
    if (!SECRET_KINDS.includes(kind)) {
      throw new Error(`未知的密钥类型: ${kind}（支持 ${SECRET_KINDS.join(', ')}）`);
    }
    const trimmed = String(value == null ? '' : value).trim();
    if (!trimmed) {
      throw new Error('API Key 不能为空，若要清除请使用 clearKey');
    }
    const raw = this._readSecretsRaw();
    raw[kind] = trimmed;
    this._writeSecretsRaw(raw);
    return { saved: true, kind, masked: maskSecret(trimmed) };
  }

  /** 清除密钥 */
  clearKey(kind) {
    if (!SECRET_KINDS.includes(kind)) {
      throw new Error(`未知的密钥类型: ${kind}`);
    }
    const raw = this._readSecretsRaw();
    delete raw[kind];
    delete raw._decryptError;
    // 全部清空后删除文件，避免留下空壳
    if (Object.keys(raw).length === 0) {
      try { this.fs.rmSync(this.paths.secretsFile, { force: true }); } catch { /* 忽略 */ }
      return { cleared: true, kind };
    }
    this._writeSecretsRaw(raw);
    return { cleared: true, kind };
  }

  /**
   * 生成用于界面展示的掩码，绝不展示完整密钥
   * sk-1234567890abcdef → sk-12…cdef
   */
  static mask(kind) {
    return null;
  }
}

/** 掩码工具：只露前 4 后 4 位 */
function maskSecret(secret) {
  const s = String(secret || '');
  if (s.length <= 10) return `${s.slice(0, 2)}…${'*'.repeat(Math.max(2, s.length - 4))}`;
  return `${s.slice(0, 4)}…${s.slice(-4)}`;
}

module.exports = { SecretStore, DEFAULT_CONFIG, SECRET_KINDS, maskSecret };
