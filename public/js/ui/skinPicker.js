// 皮肤选择器 —— 干员调配详情页的「换装」区块（ui/skins.js 的目录与状态）。
//
// 目录来自 data/skins.json（172 名干员 / 271 套），服务端有没有下载某套的模型由 data/assets.json 决定：
// 没有模型的条目仍然列出来（这样玩家知道自己能换什么），只是标记「未安装」并给出安装脚本的提示，选中它也只是回退到
// 干员自己的模型。没有皮肤的干员整块不显示。

import { useEffect, useState } from '../../vendor/hooks.module.js';
import { html, MicroLabel, Icon } from './components.js';
import { Img } from './gameComponents.js';
import { useStore } from '../store.js';
import { data } from '../data.js';
import { t } from '../../../shared/i18n.js';
import { skinsStore, availableSkins, loadSkinData, setSkin, clearSkin } from './skins.js';

const cx = (...p) => p.flat().filter(Boolean).join(' ');

/**
 * The installed skin's 180×180 avatar URL, or null.
 *
 * Keyed by OPERATOR id, not by chess id: data/assets.json groups everything under `chars[charId]`.
 */
function skinAvatar(charId, skinId) {
  return data.get('assets')?.chars?.[charId]?.skins?.[skinId]?.avatar || null;
}

/** 换装 section of the 干员调配 detail panel; renders nothing for an operator without skins. */
export function SkinSection({ chess }) {
  const s = useStore((v) => v, Object.is, skinsStore);
  const [, bump] = useState(0);

  const chessId = chess && chess.chessId;
  const charId = chess && chess.charId;

  useEffect(() => {
    let dead = false;
    loadSkinData();
    // the catalogue and the manifest arrive asynchronously: re-render when either settles, and poll as a cheap net for
    // a store that notifies without a name (data.load of a file already loading)
    const off = data.subscribe?.(() => { if (!dead) bump((n) => n + 1); });
    const timer = setInterval(() => { if (!dead) bump((n) => n + 1); }, 1000);
    return () => { dead = true; clearInterval(timer); off?.(); };
  }, [chessId]);

  if (!chessId || !charId) return null;
  const ready = data.status('skins') === 'ready';
  if (!ready) {
    return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
      <header class="lo-sec__head">
        <h3>${t('换装')}<${MicroLabel}>SKIN<//></h3>
        <span class="lo-sec__note">${t('正在载入皮肤目录…')}</span>
      </header>
    </section>`;
  }

  const list = availableSkins(charId);
  if (!list.length) return null;

  const chosen = s.entries[chessId] || null;
  const defaultArt = data.get('assets')?.chars?.[charId]?.avatar || null;
  const installed = list.filter((x) => x.installed).length;

  return html`<section class="lo-sec lo-sec--skin" data-testid="skin-section">
    <header class="lo-sec__head">
      <h3>${t('换装')}<${MicroLabel}>SKIN<//></h3>
      <span class="lo-sec__note">${installed === list.length ? t('{n} 套可选', { n: list.length }) : t('{n} 套可选 · 已安装 {k}', { n: list.length, k: installed })}</span>
    </header>
    <div class="lo-skins" role="radiogroup" aria-label=${t('选择皮肤')}>
      <button type="button" role="radio" aria-checked=${chosen ? 'false' : 'true'} data-skin=""
        class=${cx('lo-skin', 'lo-skin--default', !chosen && 'is-on')} onClick=${() => clearSkin(chessId)}>
        <span class="lo-skin__art">
          ${defaultArt
            ? html`<${Img} src=${defaultArt} alt="" />`
            : html`<span class="lo-skin__art--none"></span>`}
        </span>
        <span class="lo-skin__text">
          <b class="lo-skin__name">${t('默认')}</b>
          <span class="lo-skin__group">DEFAULT</span>
        </span>
        ${!chosen ? html`<span class="lo-skin__badge">${t('已装配')}</span>` : null}
      </button>
      ${list.map((x) => {
        // 素材没导入时用干员默认头像打底（原来的空占位让「未安装」的条目看不出是谁）
        const art = skinAvatar(charId, x.id) || defaultArt;
        const isOn = chosen === x.id;
        return html`<button key=${x.id} type="button" role="radio" aria-checked=${isOn ? 'true' : 'false'}
            data-skin=${x.id} title=${x.group ? `${x.name} · ${x.group}` : x.name}
            class=${cx('lo-skin', isOn && 'is-on', !x.installed && 'is-absent')}
            onClick=${() => setSkin(chessId, x.id)}>
          <span class="lo-skin__art">
            ${art
              ? html`<${Img} src=${art} alt="" class=${x.installed ? null : 'is-dim'} fallback=${html`<span class="lo-skin__art--none"></span>`} />`
              : html`<span class="lo-skin__art--none"></span>`}
          </span>
          <span class="lo-skin__text">
            <b class="lo-skin__name">${x.name}</b>
            <span class="lo-skin__group">${x.group || 'SPECIAL'}</span>
          </span>
          ${isOn ? html`<span class="lo-skin__badge">${t('已装配')}</span>`
            : !x.installed ? html`<span class="lo-skin__badge lo-skin__badge--absent">${t('未安装')}</span>` : null}
        </button>`;
      })}
    </div>
    ${installed < list.length ? html`<p class="lo-skin__hint"><${Icon} name="info" />${t('模型未下载的皮肤选中后仍显示干员默认模型；补齐素材需要运行 node tools/fetch-assets.mjs（或从完整包复制 public/assets）')}</p>` : null}
    <p class="lo-skin__hint"><${Icon} name="info" />${t('换装是局外设置，对队友可见；修改在下一次战斗生效')}</p>
  </section>`;
}
