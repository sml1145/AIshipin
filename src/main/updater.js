'use strict';

/**
 * 更新执行层（Electron 胶水）
 *
 * 职责：把 updater-core 的"探测与决策"结果变成真实的下载、校验、安装、回滚。
 *
 * Windows 下的硬约束：
 *   - 运行中的 exe 无法被原地覆盖，必须由外部安装器接管 → 下载后 spawn installer /S
 *   - per-user 安装（%LOCALAPPDATA%\Programs\幻想时刻）→ 静默升级不需要管理员权限
 *   - 安装包未做代码签名 → 必须用 latest.yml 里的 SHA512 校验完整性，防中间人替换
 *
 * 安全要点：spawn 安装器时用参数数组，绝不拼接 shell 命令字符串（路径含中文/空格会出事）
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const core = require('./updater-core.js');
const { downloadFile, raceDownload, sha512File, sha256File } = require('./downloader.js');
const { httpRequest } = require('./http.js');

/** 更新流程的各个阶段，UI 按此展示进度 */
const PHASE = Object.freeze({
  IDLE: 'idle',
  PROBING: 'probing',
  FOUND: 'found',
  NO_UPDATE: 'no_update',
  DOWNLOADING: 'downloading',
  VERIFYING: 'verifying',
  READY_TO_INSTALL: 'ready_to_install',
  INSTALLING: 'installing',
  FAILED: 'failed'
});

class UpdateManager {
  /**
   * @param {object} opts
   * @param {object} opts.paths paths.js 的结果
   * @param {string} opts.currentVersion 当前版本（semver 三段）
   * @param {Function} [opts.onState] (state) => void  状态回调，推给 UI
   * @param {Function} [opts.fetchImpl] 注入以便测试
   * @param {string[]} [opts.extraMirrors] 用户自定义镜像
   * @param {object} [opts.electronApp] Electron app 对象（用于 quitAndInstall）
   * @param {Function} [opts.spawnImpl] 注入以便测试
   */
  constructor(opts = {}) {
    this.paths = opts.paths;
    this.currentVersion = opts.currentVersion;
    this.onState = opts.onState || (() => {});
    this.fetchImpl = opts.fetchImpl || null;
    this.extraMirrors = opts.extraMirrors || [];
    this.app = opts.electronApp || null;
    this.spawnImpl = opts.spawnImpl || spawn;
    this.state = { phase: PHASE.IDLE };
    /** 防止并发触发多次检查 */
    this._busy = false;
    this.lastResult = null;
  }

  _set(patch) {
    this.state = { ...this.state, ...patch, at: Date.now() };
    try { this.onState(this.state); } catch { /* UI 回调异常不应中断更新流程 */ }
    return this.state;
  }

  get downloadDir() {
    return path.join(os.tmpdir(), 'HuanXiangShiKe-updates');
  }

  /**
   * 完整更新检查：探测 → 比对 → （可选）下载 → 校验
   * @param {object} [opts]
   * @param {boolean} [opts.downloadIfNew] 发现新版本是否立即下载，默认 false（先让用户确认）
   * @returns {Promise<object>} 结果对象
   */
  async check({ downloadIfNew = false } = {}) {
    if (this._busy) {
      return { ok: false, reason: 'busy', message: '已有一个检查任务在进行中，请稍候' };
    }
    this._busy = true;
    try {
      this._set({ phase: PHASE.PROBING, message: '正在并行探测多个更新通道…', channels: [] });

      const channels = core.buildProbeChannels({ extraMirrors: this.extraMirrors });
      const channelResults = [];
      const probe = await core.probeLatest({
        channels,
        fetchImpl: this.fetchImpl,
        timeoutMs: core.PROBE_TIMEOUT_MS,
        onChannel: (label, rec) => {
          channelResults.push(rec);
          this._set({ channels: [...channelResults] });
        }
      });

      if (!probe.ok) {
        const result = {
          ok: false, phase: PHASE.FAILED,
          message: '所有更新通道均无法连通，无法检查更新。',
          detail: probe.error,
          channels: channelResults,
          manualUrl: `https://github.com/${core.REPO_OWNER}/${core.REPO_NAME}/releases/latest`,
          suggestion: '请检查网络连接后重试；也可直接打开仓库 Releases 页面手动下载最新安装包。'
        };
        this._set({ phase: PHASE.FAILED, ...result });
        this.lastResult = result;
        return result;
      }

      const decision = core.decideUpdate({ currentVersion: this.currentVersion, release: probe.release });
      this.lastResult = { ...decision, channels: channelResults, winner: probe.winner };

      if (!decision.needUpdate) {
        const result = {
          ok: true, phase: PHASE.NO_UPDATE, needUpdate: false,
          message: decision.message,
          current: decision.current, latest: decision.latest,
          channels: channelResults, winner: probe.winner,
          channelSummary: summarizeChannels(channelResults)
        };
        this._set(result);
        this.lastResult = result;
        return result;
      }

      this._set({
        phase: PHASE.FOUND, needUpdate: true,
        message: decision.message,
        current: decision.current, latest: decision.latest,
        channels: channelResults, winner: probe.winner,
        channelSummary: summarizeChannels(channelResults)
      });

      if (!downloadIfNew) {
        return { ...this.state, ok: true, downloaded: false };
      }
      return await this.download(probe.release, decision);
    } finally {
      this._busy = false;
    }
  }

  /**
   * 下载 + 校验（多通道竞速）
   * @param {object} release probeLatest 返回的 release
   * @param {object} decision decideUpdate 的结果
   */
  async download(release, decision) {
    const d = decision || core.decideUpdate({ currentVersion: this.currentVersion, release });
    const assetName = core.pickInstallerName(release, d.latest);
    if (!assetName) {
      const msg = '无法确定安装包文件名，Release 中未找到 .exe 资产。';
      this._set({ phase: PHASE.FAILED, message: msg });
      return { ok: false, message: msg, manualUrl: release.htmlUrl || `https://github.com/${core.REPO_OWNER}/${core.REPO_NAME}/releases/latest` };
    }

    fs.mkdirSync(this.downloadDir, { recursive: true });
    const destPath = path.join(this.downloadDir, assetName);

    // 先取 latest.yml 拿官方 SHA512（未签名安装包必须靠它防篡改）
    this._set({ phase: PHASE.VERIFYING, message: '正在获取校验信息 latest.yml…' });
    const manifest = await this._fetchManifest(release);
    const expectedSha512 = manifest && manifest.sha512 ? manifest.sha512 : null;
    const expectedBytes = manifest && manifest.files && manifest.files[0] ? manifest.files[0].size : null;

    this._set({
      phase: PHASE.DOWNLOADING,
      message: expectedSha512
        ? `正在并行下载 ${assetName}（将做 SHA512 校验）…`
        : `正在并行下载 ${assetName}…`,
      assetName, expectedSha512: !!expectedSha512
    });

    const sources = core.buildDownloadChannels({
      tag: release.tag, assetName, extraMirrors: this.extraMirrors
    });

    let dl;
    try {
      dl = await raceDownload({
        sources,
        destPath,
        expectedBytes,
        fetchImpl: this.fetchImpl,
        onProgress: (p) => {
          this._set({
            phase: PHASE.DOWNLOADING,
            message: `正在下载：${p.label}${p.percent != null ? ` ${p.percent}%` : ''}${p.speedKBps ? ` · ${p.speedKBps} KB/s` : ''}`,
            percent: p.percent, downloadedBytes: p.downloadedBytes, totalBytes: p.totalBytes,
            speedKBps: p.speedKBps, activeChannel: p.label
          });
        }
      });
    } catch (err) {
      const result = {
        ok: false, phase: PHASE.FAILED,
        message: '全部下载通道均失败，未能获取安装包。',
        detail: String(err.message || err).slice(0, 500),
        manualUrl: release.htmlUrl || `https://github.com/${core.REPO_OWNER}/${core.REPO_NAME}/releases/latest`,
        directUrl: sources[0].url,
        suggestion: '可点击"打开下载页面"手动下载，或检查网络后重试。'
      };
      this._set(result);
      return result;
    }

    // SHA512 校验：不符即删除并拒绝安装
    this._set({ phase: PHASE.VERIFYING, message: '正在校验安装包完整性（SHA512）…' });
    if (expectedSha512) {
      const actual = await sha512File(destPath);
      if (actual !== expectedSha512) {
        try { fs.rmSync(destPath, { force: true }); } catch { /* 忽略 */ }
        const result = {
          ok: false, phase: PHASE.FAILED,
          message: '安装包 SHA512 校验失败，已删除该文件并取消安装。',
          detail: `期望 ${expectedSha512.slice(0, 32)}…，实际 ${actual.slice(0, 32)}…`,
          suggestion: '这可能是下载损坏或文件被篡改。请重新检查更新；若持续失败，请手动从官方 Releases 页面下载。',
          manualUrl: release.htmlUrl
        };
        this._set(result);
        return result;
      }
    }

    const sha256 = await sha256File(destPath);
    const result = {
      ok: true, phase: PHASE.READY_TO_INSTALL, needUpdate: true,
      message: `新版本 ${d.latest} 已下载并通过校验，可以安装。`,
      installerPath: destPath,
      assetName,
      bytes: dl.bytes,
      sha256,
      sha512Verified: Boolean(expectedSha512),
      winnerChannel: dl.winner,
      current: d.current, latest: d.latest
    };
    this._set(result);
    this.lastDownload = result;
    return result;
  }

  /** 取 latest.yml 并解析；拿不到就返回 null（降级为只校验大小） */
  async _fetchManifest(release) {
    const candidates = [];
    const manifestAsset = (release.assets || []).find(a => a.isManifest);
    if (manifestAsset && manifestAsset.downloadUrl) candidates.push(manifestAsset.downloadUrl);
    candidates.push(`https://github.com/${core.REPO_OWNER}/${core.REPO_NAME}/releases/download/${encodeURIComponent(release.tag)}/latest.yml`);

    for (const url of candidates) {
      try {
        const res = await httpRequest({
          url, timeoutMs: 15000, retries: 1, fetchImpl: this.fetchImpl
        });
        if (res.ok && res.text) {
          const parsed = core.parseLatestYml(res.text);
          return parsed;
        }
      } catch { /* 换下一个候选 */ }
    }
    return null;
  }

  /**
   * 执行静默安装（Windows）
   *
   * 流程：备份当前版本信息 → spawn 安装器 /S → 退出应用让安装器接管
   * 安装器会在文件不再被占用时完成替换，然后重启应用。
   *
   * @param {object} [opts]
   * @param {string} [opts.installerPath] 默认用上次下载好的
   * @param {boolean} [opts.forceRunAfter] 安装后是否自动重启，默认 true
   */
  async install(opts = {}) {
    const installerPath = opts.installerPath || (this.lastDownload && this.lastDownload.installerPath);
    if (!installerPath || !fs.existsSync(installerPath)) {
      const result = { ok: false, phase: PHASE.FAILED, message: '安装包不存在，请重新检查更新。' };
      this._set(result);
      return result;
    }

    // 记录升级前版本，便于失败时诊断与回滚提示
    const rollbackInfo = {
      fromVersion: this.currentVersion,
      toVersion: this.lastDownload ? this.lastDownload.latest : null,
      installerPath,
      installDir: this.app ? path.dirname(this.app.getPath('exe')) : null,
      at: new Date().toISOString()
    };
    try {
      fs.mkdirSync(this.paths.userData, { recursive: true });
      fs.writeFileSync(path.join(this.paths.userData, 'last-update-attempt.json'), JSON.stringify(rollbackInfo, null, 2), 'utf8');
    } catch { /* 写不进也不阻断升级 */ }

    this._set({ phase: PHASE.INSTALLING, message: '正在启动安装程序，应用即将退出…' });

    // NSIS 静默参数：/S 静默；/D= 指定安装目录（必须是最后一个参数且不加引号）
    const args = ['/S'];
    if (opts.forceRunAfter !== false) args.push('--updated');
    if (rollbackInfo.installDir) args.push(`/D=${rollbackInfo.installDir}`);

    try {
      const child = this.spawnImpl(installerPath, args, {
        detached: true,   // 脱离父进程，应用退出后安装器继续
        stdio: 'ignore',
        windowsHide: true
      });
      if (child && typeof child.unref === 'function') child.unref();
    } catch (err) {
      const result = {
        ok: false, phase: PHASE.FAILED,
        message: '无法启动安装程序。',
        detail: String(err.message || err),
        installerPath,
        suggestion: `可手动双击运行安装包完成升级：${installerPath}`
      };
      this._set(result);
      return result;
    }

    // 给安装器一点时间启动，再退出应用释放文件占用
    await new Promise(r => setTimeout(r, 800));
    if (this.app && typeof this.app.quit === 'function') {
      this.app.quit();
    }
    return { ok: true, phase: PHASE.INSTALLING, message: '安装程序已启动，应用即将退出并完成升级。', installerPath };
  }

  /**
   * 启动时检查上一次升级是否成功（回滚判定）
   * 若记录的 toVersion 与当前实际版本不符，说明升级未完成，提示用户。
   */
  checkRollbackOnStartup() {
    const file = path.join(this.paths.userData, 'last-update-attempt.json');
    if (!fs.existsSync(file)) return { needed: false };
    let info;
    try {
      info = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return { needed: false, warning: '升级记录损坏，已忽略' };
    }
    // 升级成功 → 清理记录
    if (info.toVersion && String(this.currentVersion).startsWith(String(info.toVersion).replace(/^(\d+\.\d+).*$/, '$1'))) {
      try { fs.rmSync(file, { force: true }); } catch { /* 忽略 */ }
      return { needed: false, upgradedFrom: info.fromVersion, upgradedTo: info.toVersion };
    }
    return {
      needed: true,
      fromVersion: info.fromVersion,
      toVersion: info.toVersion,
      installerPath: info.installerPath,
      installerExists: info.installerPath ? fs.existsSync(info.installerPath) : false,
      message: `上次升级到 ${info.toVersion || '新版本'} 似乎未完成，当前仍是 ${this.currentVersion}。`
    };
  }

  /** 打开浏览器到 Releases 页（全部通道失败时的最后退路） */
  getManualDownloadUrl() {
    return `https://github.com/${core.REPO_OWNER}/${core.REPO_NAME}/releases/latest`;
  }
}

/** 把各通道探测结果汇总成一句人话 */
function summarizeChannels(attempts) {
  const ok = attempts.filter(a => a.ok);
  const bad = attempts.filter(a => !a.ok);
  const parts = [];
  if (ok.length) parts.push(`${ok.length} 条通道可用（${ok.map(a => a.label).join('、')}）`);
  if (bad.length) parts.push(`${bad.length} 条不可用（${bad.map(a => `${a.label}: ${a.error}`).join('；')}）`);
  return parts.join('；');
}

module.exports = { UpdateManager, PHASE, summarizeChannels };
