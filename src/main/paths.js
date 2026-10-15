'use strict';

/**
 * 路径解析（纯函数，不直接依赖 Electron，便于测试）
 *
 * 所有运行时数据都放在 Electron 的 userData 目录下，与安装目录分离：
 *   - 安装目录（%LOCALAPPDATA%\Programs\幻想时刻）：只读，升级时整体替换
 *   - userData（%APPDATA%\幻想时刻）：配置、密钥、下载的运行时与权重、生成结果
 * 这样升级安装包不会动到用户已下载的 9GB 模型包，也不会丢密钥。
 */

const path = require('node:path');

const APP_DIR_NAME = '幻想时刻';

/**
 * @param {object} env
 * @param {string} env.appPath      应用根目录（开发时=项目根，打包后=asar 路径）
 * @param {string} env.userDataPath Electron app.getPath('userData')
 * @param {string} env.resourcesPath process.resourcesPath
 * @param {boolean} env.isPackaged   app.isPackaged
 * @param {string} [env.homeDir]    用户主目录，默认 os.homedir()
 */
function resolvePaths(env) {
  const {
    appPath,
    userDataPath,
    resourcesPath,
    isPackaged,
    homeDir = require('node:os').homedir()
  } = env;

  const userData = userDataPath;

  // 模型能力库：打包后随 asar 分发只读副本，运行时热更新版本写到 userData
  const catalogBundled = isPackaged
    ? path.join(resourcesPath, 'app.asar', 'models.json')
    : path.join(appPath, 'models.json');

  // 本地推理的 Python 脚本：extraResources 解包到 resources/local
  const localScriptsDir = isPackaged
    ? path.join(resourcesPath, 'local')
    : path.join(appPath, 'src', 'local');

  // ffmpeg 二进制：打包后经 asarUnpack 位于 app.asar.unpacked
  let ffmpegPath = null;
  try {
    // eslint-disable-next-line global-require
    ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
  } catch {
    ffmpegPath = null;
  }

  return {
    appRoot: appPath,
    userData,
    isPackaged,
    appDirName: APP_DIR_NAME,

    // 配置与密钥
    configFile: path.join(userData, 'config.json'),
    secretsFile: path.join(userData, 'secrets.bin'),
    catalogBundled,
    catalogCached: path.join(userData, 'models-cached.json'),

    // B 轨运行时（按需下载，总计约 9GB）
    runtimeDir: path.join(userData, 'runtime'),
    pythonDir: path.join(userData, 'runtime', 'python'),
    modelsDir: path.join(userData, 'models-store'),
    downloadsDir: path.join(userData, 'downloads'),

    // 生成结果输出：放在用户的"视频"目录下，便于用户直接找到
    outputDir: path.join(homeDir, 'Videos', APP_DIR_NAME),

    // 任务与日志
    tasksDir: path.join(userData, 'tasks'),
    logsDir: path.join(userData, 'logs'),

    localScriptsDir,
    ffmpegPath,

    /** 需要确保存在的目录清单 */
    requiredDirs: [
      userData,
      path.join(userData, 'runtime'),
      path.join(userData, 'models-store'),
      path.join(userData, 'downloads'),
      path.join(userData, 'tasks'),
      path.join(userData, 'logs'),
      path.join(homeDir, 'Videos', APP_DIR_NAME)
    ]
  };
}

/** 创建所有必需目录（幂等） */
function ensureDirs(paths, fs = require('node:fs')) {
  for (const d of paths.requiredDirs) {
    fs.mkdirSync(d, { recursive: true });
  }
  return paths.requiredDirs;
}

module.exports = { resolvePaths, ensureDirs, APP_DIR_NAME };
