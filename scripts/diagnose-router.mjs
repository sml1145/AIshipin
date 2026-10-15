// 路由诊断脚本：打印每条测试提示词的实际选型与前三名，供人工判断合理性
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const router = require('../src/main/router-core.js');
const here = dirname(fileURLToPath(import.meta.url));
const catalog = JSON.parse(readFileSync(join(here, '..', 'models.json'), 'utf8'));

// 与测试保持一致：国内通道有 Key，海外通道实测不可达
function cloudReady(extra = {}) {
  return {
    ...extra,
    providers: {
      dashscope: { reachable: true, hasKey: true },
      siliconflow: { reachable: true, hasKey: true },
      modelscope: { reachable: true, hasKey: false },
      huggingface: { reachable: false, hasKey: false },
      replicate: { reachable: false, hasKey: false },
      fal: { reachable: false, hasKey: false },
      local: { reachable: true, hasKey: false },
      mock: { reachable: true, hasKey: false }
    }
  };
}

// 海外通道也可达
function allChannelsReady(extra = {}) {
  return {
    ...extra,
    providers: {
      dashscope: { reachable: true, hasKey: true },
      siliconflow: { reachable: true, hasKey: true },
      modelscope: { reachable: true, hasKey: true },
      huggingface: { reachable: true, hasKey: true },
      replicate: { reachable: true, hasKey: true },
      fal: { reachable: true, hasKey: true },
      local: { reachable: true, hasKey: false },
      mock: { reachable: true, hasKey: false }
    }
  };
}

const cases = [
  ['有图+人像', '让这张照片里的人物动起来，自然地微笑', cloudReady({ hasImage: true })],
  ['纯文生+写实', '电影感的写实画面，超清质感，一个人在雨中行走', cloudReady()],
  ['动漫二次元', '动漫二次元风格的少女在樱花树下跳舞，卡通动画', cloudReady()],
  ['风景空镜', '航拍雪山与森林的空镜，镜头稳定，延时摄影', cloudReady()],
  ['风景空镜(海外可达)', '航拍雪山与森林的空镜，镜头稳定，延时摄影', allChannelsReady()],
  ['产品广告(有图)', '电商产品广告，瓶身缓慢旋转展示，商业宣传片质感', cloudReady({ hasImage: true })],
  ['微动效循环(有图)', '做一个无缝循环的微动效，静物轻微摆动，当动态壁纸用，gif 风格', cloudReady({ hasImage: true })],
  ['微动效循环(海外可达)', '做一个无缝循环的微动效，静物轻微摆动，当动态壁纸用，gif 风格', allChannelsReady({ hasImage: true })],
  ['音频驱动(图+音频)', '用这段音频让人物对口型说话，做成数字人视频', cloudReady({ hasImage: true, hasAudio: true })],
  ['要有声(无音频)', '有声视频，需要音乐和音效，音画同步', cloudReady({ hasAudio: false })],
  ['极速竖版', '赶时间，要极速秒出的竖版短视频，发抖音用', cloudReady()],
  ['极速竖版(海外可达)', '赶时间，要极速秒出的竖版短视频，发抖音用', allChannelsReady()],
  ['首尾帧', '用这两张图做首尾帧，中间加自然转场过渡', cloudReady({ hasImage: true, wantFirstLastFrame: true })],
  ['长时长叙事', '要一个30秒的多镜头叙事长视频，一镜到底', cloudReady()],
  ['动作迁移', '把参考视频里的跳舞动作迁移到这张图片的人物上', cloudReady({ hasImage: true })],
  ['视频编辑', '编辑视频，将整个画面转换为黏土风格', cloudReady()],
  ['文档生视频', '根据这个PPT文档生成一段产品介绍视频', cloudReady()],
  ['离线本地', '我要离线本地生成，不联网，注意隐私，画面是一个人在跑步', {
    offlineOnly: true,
    localModelsInstalled: ['local-ltx-2b-fp8', 'local-wan2.1-1.3b-fp8'],
    hardware: { vramGB: 8, ramGB: 15.2, diskFreeGB: 100 }
  }]
];

for (const [label, prompt, ctx] of cases) {
  const r = router.route({ prompt, catalog, context: ctx });
  const top = r.chain.slice(0, 3).map(m => `${m.id}(${m.finalScore})`).join(' > ');
  console.log(`\n【${label}】${prompt}`);
  console.log(`  选中: ${r.selected ? r.selected.id : '(无)'}   前三: ${top || '(空)'}`);
  console.log(`  意图: ${r.intents.map(i => `${i.key}×${i.score}`).join(', ') || '(无)'}`);
  if (r.rejected.length) {
    console.log(`  被拒(${r.rejected.length}): ${r.rejected.slice(0, 6).map(x => `${x.id}[${x.reasons[0]}]`).join(' | ')}`);
  }
}
