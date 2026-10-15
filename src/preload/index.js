'use strict';

/**
 * Preload —— 渲染进程与主进程之间唯一的桥
 *
 * 安全原则：
 *   - 只通过 contextBridge 暴露一组固定方法，渲染层拿不到 ipcRenderer 本体，
 *     更拿不到 require / process / fs / child_process
 *   - 每个暴露的方法都对应主进程一个 ipcMain.handle，不接受任意 channel 名
 *   - 事件订阅也限定在固定几个 channel，防止渲染层监听敏感事件
 */

const { contextBridge, ipcRenderer } = require('electron');

/** 允许渲染层订阅的事件通道（白名单） */
const ALLOWED_EVENTS = ['task:progress', 'update:state', 'update:rollback', 'hardware:ready'];

const api = {
  // 应用信息
  getAppInfo: () => ipcRenderer.invoke('app:info'),

  // 硬件
  detectHardware: (force) => ipcRenderer.invoke('hardware:detect', force === true),

  // 模型能力库
  getCatalog: () => ipcRenderer.invoke('catalog:get'),
  refreshCatalog: () => ipcRenderer.invoke('catalog:refresh'),

  // 路由预演
  previewRoute: (req) => ipcRenderer.invoke('route:preview', req),

  // 生成
  submitGenerate: (req) => ipcRenderer.invoke('generate:submit', req),
  cancelGenerate: (taskId) => ipcRenderer.invoke('generate:cancel', taskId),
  getTask: (taskId) => ipcRenderer.invoke('generate:task', taskId),

  // 图片选择（只回传路径，不回传文件内容）
  pickImage: () => ipcRenderer.invoke('dialog:pickImage'),

  // 密钥（渲染层永远拿不到明文）
  listSecrets: () => ipcRenderer.invoke('secret:list'),
  setSecret: (kind, value) => ipcRenderer.invoke('secret:set', kind, value),
  clearSecret: (kind) => ipcRenderer.invoke('secret:clear', kind),

  // 配置
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (patch) => ipcRenderer.invoke('config:set', patch),

  // 更新
  checkUpdate: (opts) => ipcRenderer.invoke('update:check', opts),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  installUpdate: () => ipcRenderer.invoke('update:install'),
  openManualUpdate: () => ipcRenderer.invoke('update:openManual'),
  getRollbackStatus: () => ipcRenderer.invoke('update:rollbackStatus'),

  // 文件管理器
  showOutputDir: () => ipcRenderer.invoke('shell:showOutputDir'),
  showItemInFolder: (p) => ipcRenderer.invoke('shell:showItem', p),

  /**
   * 订阅主进程事件
   * @param {string} channel 必须是白名单内的通道
   * @param {Function} listener
   * @returns {Function} 取消订阅的函数
   */
  on: (channel, listener) => {
    if (!ALLOWED_EVENTS.includes(channel)) {
      throw new Error(`不允许订阅的事件通道: ${channel}`);
    }
    const wrapped = (_event, payload) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  }
};

contextBridge.exposeInMainWorld('hxsk', api);
