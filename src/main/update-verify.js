'use strict';

/**
 * 更新清单的 Ed25519 签名校验（自研，不依赖 electron-updater 版本）
 *
 * 为什么需要（真实威胁模型）：
 *   本软件的更新是"多通道并行竞速下载"，通道里包含用户可自定义的镜像。
 *   单靠 latest.yml 里的 SHA512 无法防住"恶意镜像同时提供被篡改的安装包 + 匹配的 SHA512"。
 *   Ed25519 用只有发布者持有的私钥对 manifest 签名，客户端用内置公钥验签，
 *   即使所有下载通道都被污染，只要私钥不泄露就无法伪造合法更新。
 *
 * 诚实说明：electron-updater 6.8.9 不含 Ed25519/manifest 签名能力（已 grep 核实），
 *   故本模块自行实现，供 UpdateManager 在信任 latest.yml 之前调用。
 *   验签失败一律拒绝更新，绝不降级为"仅 SHA512"而放行。
 */

const crypto = require('node:crypto');

/**
 * 生成 Ed25519 密钥对（发布方一次性使用；私钥绝不入仓）
 * @returns {{publicKeyPem:string, privateKeyPem:string, publicKeyBase64:string}}
 */
function generateKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicKeyBase64: publicKey.export({ type: 'spki', format: 'der' }).toString('base64')
  };
}

/**
 * 用私钥对清单内容签名
 * @param {string|Buffer} manifestText latest.yml 原文
 * @param {string} privateKeyPem
 * @returns {string} base64 签名
 */
function signManifest(manifestText, privateKeyPem) {
  const key = crypto.createPrivateKey(privateKeyPem);
  const sig = crypto.sign(null, Buffer.from(manifestText, 'utf8'), key);
  return sig.toString('base64');
}

/**
 * 用公钥验签
 * @param {string|Buffer} manifestText latest.yml 原文
 * @param {string} signatureBase64
 * @param {string} publicKeyPem 或 base64 DER（两种都接受）
 * @returns {boolean} 验签是否通过；任何异常都返回 false（不抛，交由调用方拒绝更新）
 */
function verifyManifest(manifestText, signatureBase64, publicKey) {
  if (!manifestText || !signatureBase64 || !publicKey) return false;
  try {
    // 接受 PEM 或 base64 DER 两种公钥形式
    let keyObj;
    if (typeof publicKey === 'string' && publicKey.trim().startsWith('-----BEGIN')) {
      keyObj = crypto.createPublicKey(publicKey);
    } else {
      const der = Buffer.from(String(publicKey).trim(), 'base64');
      keyObj = crypto.createPublicKey({ key: der, format: 'der', type: 'spki' });
    }
    const sig = Buffer.from(signatureBase64, 'base64');
    if (sig.length === 0) return false;
    return crypto.verify(null, Buffer.from(manifestText, 'utf8'), keyObj, sig);
  } catch {
    return false;
  }
}

/**
 * 规范化清单文本，消除换行符差异导致的验签失败
 * （Windows CRLF / Unix LF 混用时，签名与验签必须基于同一字节序列）
 * @param {string} text
 * @returns {string}
 */
function normalizeManifest(text) {
  return String(text == null ? '' : text).replace(/\r\n/g, '\n');
}

module.exports = {
  generateKeyPair,
  signManifest,
  verifyManifest,
  normalizeManifest
};
