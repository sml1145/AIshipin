'use strict';

/**
 * 更新清单验签公钥（Ed25519）
 *
 * 公钥可公开，随安装包分发；私钥由发布者在仓库外保管（HuanXiangShiKe-signing/update-private.pem），
 * 绝不入仓、绝不随包。验签保证：即使所有下载通道（含用户自定义镜像）被污染，
 * 攻击者没有私钥也无法伪造出能通过校验的 latest.yml。
 *
 * 注意：这是 base64 DER（SPKI）格式，update-verify.verifyManifest 两种格式都接受。
 */
const UPDATE_MANIFEST_PUBLIC_KEY = 'MCowBQYDK2VwAyEADPLwrUtj2ZCUpeMmlkKT00atzPUabU1NCWG2zzmWiJg=';

/** 签名文件名（与 latest.yml 并列上传到同一 Release） */
const MANIFEST_SIGNATURE_FILENAME = 'latest.yml.sig';

module.exports = { UPDATE_MANIFEST_PUBLIC_KEY, MANIFEST_SIGNATURE_FILENAME };
