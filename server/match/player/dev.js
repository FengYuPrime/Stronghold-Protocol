// server/match/player/dev.js — PlayerState methods: the dev-only gain of g.devGive (SP_DEV=1) — hand this player any
// chess, any item, or any 自选 / 替补 operator (fielded through a 自选编队 slot), so a debugger can put any operator or
// equipment on a board without playing the economy.
// Reaches here only through MatchIntents, which refuses the intent unless the match runs with devGold
// (server/match/match/intents.js), and only from the player's own seat.
//
// The gain goes through the ordinary acquisition path — acquireChess / acquireItem (player/acquire.js) — never a direct
// push into hand / board: copy counts, the immediate merge, the hand / overflow temp queue, ItemPool stock, the
// onGain / onMerge dispatches and recompute (bonds, 特质, deploy cap, summon stacks) all behave like any other gain.
// A `diy` gain is the 自选编队 path of player/diy.js: the operator is slotted like `setDiy` would (a legal slot, the
// client's default pick — shared/diy.js checkDiyPick — the composed records of shared/diy.js diyRecord / the same
// composer, the player's own DIY stock) and only then acquired as the slot's chess, so bonds / summons / the pick in
// battleInput are the slot's. Once the official four slots are taken, a dev match keeps going with NEW dev slots
// (`chess_char_<tier>_diy<N>_a/_b`, N ≥ 3): this debugger is not bound by the official four, and a dev slot is marked in
// the player's stock so the formal shop / promotion / random-grant draws never list it.
// Two debug-only doors are added on that path and nowhere else:
//   * acquireItem { bypassStock: true } — an item whose shared stock is used up can still be handed out;
//   * `piece.meta.dev = { skillIndex, moduleId }` — an explicit skill / module a plain chess fights with (battleInput,
//     player/round.js), checked against the game data here (shared/protocol.js loadoutOptions).
// Installed on PlayerState.prototype by server/match/PlayerState.js (a method container: never instantiated; `this` is
// the player state).

import { ERR } from '../../../shared/constants.js';
import { msg } from '../../../shared/i18n.js';
import { loadoutOptions } from '../../../shared/protocol.js';
import { diyRecord, diySlot, diySlotIds, checkDiyPick, isDiyModule, isPrototypePick } from '../../../shared/diy.js';
import { composeUnitRecord, unitForm } from '../../../shared/standIn.js';
import { atPotential } from '../../../shared/potential.js';
import { KITTED_CHARS } from '../../sim/content/kits/index.js';
import { diyGameData } from './diy.js';
import { OK, fail } from './common.js';

const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
/** The operators with a kit — the same list setDiy checks (server/sim/content/kits/index.js KITTED_CHARS). */
const KITTED = new Set(KITTED_CHARS);
/**
 * A DEFENSIVE bound of the dev 自选 slots, not a rule and never shown as a limit in the panel: it only keeps a runaway
 * client / script from growing this seat's slots without end. A dev match has no user-visible cap — the official four
 * are not a limit (dev slots are created as needed). Tests may inject a smaller value through `match.devDiyMaxSlots`.
 */
export const DEV_DIY_MAX_SLOTS = 64;

export class PlayerDev {
  /**
   * `g.devGive { kind, id, tier?, skillIndex?, moduleId? }` (dev mode only): give the caller one chess, one item or one
   * 自选 / 替补 operator.
   * @param {{ kind?: string, id?: string, tier?: number, skillIndex?: number, moduleId?: string }} msg
   * @returns {{ ok: true, kind: string, id: string, uid: number, name: string } | { error: string, detail?: string }}
   */
  devGive(msg) {
    if (!msg || typeof msg !== 'object') return fail(ERR.BAD_MSG, 'bad devGive');
    if (msg.kind === 'chess') return this.devGiveChess(msg);
    if (msg.kind === 'item') return this.devGiveItem(msg);
    if (msg.kind === 'diy') return this.devGiveDiy(msg);
    return fail(ERR.BAD_MSG, `bad kind ${String(msg.kind).slice(0, 16)}`);
  }

  /**
   * Give this player any chess. `tier` / `skillIndex` / `moduleId` are optional and must agree with the game data
   * (tier = the record's own 星级, skillIndex / moduleId = one of the chess's loadoutOptions); absent = the chess's
   * defaults, exactly like a bought / granted copy. A copy that completes a merge merges as usual (the elite is the
   * returned piece).
   * @param {{ id?: string, tier?: number, skillIndex?: number, moduleId?: string }} [msg]
   */
  devGiveChess({ id, tier = undefined, skillIndex = undefined, moduleId = undefined } = {}) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    const rec = typeof id === 'string' ? this.gd.chess(id) : null;
    if (!rec || rec.chessId !== id) return fail(ERR.BAD_TARGET, `unknown chess ${String(id).slice(0, 32)}`);
    if (tier !== undefined && rec.tier !== tier) return fail(ERR.BAD_TARGET, `chess ${id} is tier ${rec.tier}`);
    let dev = null;
    if (skillIndex !== undefined || moduleId !== undefined) {
      const base = rec.isGolden ? this.gd.chess(rec.baseId) || rec : rec;
      const golden = rec.isGolden ? rec : (base.goldenId ? this.gd.chess(base.goldenId) || null : null);
      const opt = loadoutOptions(base, golden);
      if (skillIndex !== undefined && !opt.skills.includes(skillIndex)) {
        return fail(ERR.BAD_TARGET, `skill ${skillIndex} not available for ${id}`);
      }
      if (moduleId !== undefined && !(golden && opt.modules.includes(moduleId))) {
        return fail(ERR.BAD_TARGET, `module ${moduleId} not available for ${id}`);
      }
      dev = {};
      if (skillIndex !== undefined) dev.skillIndex = skillIndex;
      if (moduleId !== undefined) dev.moduleId = moduleId;
    }
    // the ordinary acquisition path: pool copies, immediate merge, hand / overflow temp, recompute + onGain
    const piece = this.acquireChess(id, { source: 'dev' });
    if (!piece) return fail(ERR.BAD_TARGET, `cannot acquire ${id}`);
    if (dev) piece.meta = { ...(piece.meta || {}), dev };
    this.dirty();
    return { ...OK, kind: 'chess', id: piece.id, uid: piece.uid, name: rec.name };
  }

  /**
   * Give this player any item (装备 / 法术). The item goes to the hand, overflowing into the temp queue, and an
   * identical pair merges like any other gain — the stock gate of acquireItem is bypassed for this debug path only.
   * @param {{ id?: string }} [msg]
   */
  devGiveItem({ id } = {}) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    const rec = typeof id === 'string' ? this.gd.item(id) : null;
    if (!rec || rec.id !== id) return fail(ERR.BAD_TARGET, `unknown item ${String(id).slice(0, 32)}`);
    const piece = this.acquireItem(id, { source: 'dev', bypassStock: true });
    if (!piece) return fail(ERR.BAD_TARGET, `cannot acquire ${id}`);
    this.dirty();
    return { ...OK, kind: 'item', id: piece.id, uid: piece.uid, name: rec.name };
  }

  /**
   * Give this player a 自选 / 替补 operator (data/backups.json `diy.operators`: the owned 6★ pool and the 原型 / 替补
   * picks). There is no chess id for such an operator — the formal path is a 自选编队 slot (player/diy.js):
   *   1. a slot is chosen: the one already holding the operator (another copy of that piece — the same slot, so the
   *      ordinary merge applies); else a FREE official slot (tier 6 before tier 5, so the default pick is the stronger
   *      E2 Lv60 form; `tier` narrows it); else a NEW dev slot, because this debugger is not bound by the official four —
   *      `<tier>/diy<N>_a` / `_b` beside them (`tier` = the argument, else 6; N is the lowest free number ≥ 3), and a
   *      prototype that only a tier-5 slot takes falls back to tier 5. Nothing is ever replaced or overwritten;
   *   2. the pick is completed like the 自选 picker's default (public/js/ui/diyModel.js defaultPick): a prototype's
   *      locked skill / module (shared/diy.js lockedSelection), an owned operator's last skill and first module it may
   *      carry; `skillIndex` / `moduleId` override it. checkDiyPick decides — an illegal pick is never forced, the next
   *      slot is tried instead;
   *   3. an official slot is registered exactly as setDiy does (shared/diy.js diyRecord); a dev slot composes its records
   *      with the same composer (shared/standIn.js composeUnitRecord) on a copy of the tier's official identity record.
   *      Either way: the pick in `this.diy`, both composed records in `_diyRecords`, the player's own DIY stock (marked
   *      `dev` so the shop / promotion / random-grant draws of player/diy.js never list it), the player's data view
   *      rebuilt (diyGameData) so every rule — bonds, summons, placement, battleInput's `diy` pick — reads the operator;
   *   4. the slot's chess is acquired through acquireChess like any other gain.
   * Refusals are specific, so the panel can say why: DEV_NO_KIT (the operator has no kit — the same KITTED_CHARS list
   * setDiy checks; the sim cannot field it) and DEV_NO_SLOT (the data cannot field the operator at all, or the defensive
   * DEV_DIY_MAX_SLOTS bound of a runaway debug client is reached).
   * @param {{ id?: string, tier?: number, skillIndex?: number, moduleId?: string }} [msg] id = charId
   */
  devGiveDiy({ id, tier = undefined, skillIndex = undefined, moduleId = undefined } = {}) {
    if (!this.alive) return fail(ERR.ELIMINATED);
    const gd = this.m.gd;
    const data = gd.raw;
    const diy = isObj(data?.backups?.diy) ? data.backups.diy : null;
    if (!diy || !isObj(diy.operators)) return fail(ERR.DEV_NO_SLOT, 'no 自选 data'); // i18n-ignore: developer detail
    if (typeof id !== 'string' || !Object.hasOwn(diy.operators, id)) {
      return fail(ERR.DEV_NO_SLOT, `not a 自选 operator ${String(id).slice(0, 32)}`); // i18n-ignore: developer detail
    }
    if (!KITTED.has(id)) return fail(ERR.DEV_NO_KIT, `${id} has no kit yet`); // i18n-ignore: developer detail
    // 1. the same operator again: another copy of its slot's piece (an official or a dev slot alike). A different
    //    skill / module than the slot's pick is refused — the pick is fixed once the slot exists, never silently ignored.
    const heldSlot = Object.keys(this.diy).find((slotId) => this.diy[slotId]?.charId === id);
    if (heldSlot) {
      const held = this.diy[heldSlot];
      const module = moduleId === 'none' ? null : moduleId;
      if (skillIndex !== undefined && skillIndex !== held.skillIndex) {
        return fail(ERR.BAD_TARGET, `${heldSlot} already holds ${id} with skill ${held.skillIndex}`); // i18n-ignore: developer detail
      }
      if (moduleId !== undefined && module !== (held.uniEquipId ?? null)) {
        return fail(ERR.BAD_TARGET, `${heldSlot} already holds ${id} with module ${held.uniEquipId ?? 'none'}`); // i18n-ignore: developer detail
      }
      return this._devDiyGain(heldSlot, id);
    }
    // 2. a free official slot, tier 6 first
    const official = diySlotIds(data)
      .map((slotId) => ({ slotId, slot: diySlot(slotId, data) }))
      .filter((x) => x.slot && !this.diy[x.slotId] && (tier === undefined || x.slot.tier === tier))
      .sort((a, b) => b.slot.tier - a.slot.tier);
    for (const { slotId, slot } of official) {
      const pick = this._devDiyPick(slotId, id, { skillIndex, moduleId });
      if (!pick) continue;
      let normal;
      let golden;
      try {
        normal = diyRecord(slotId, pick, { elite: false, data });
        golden = diyRecord(slotId, pick, { elite: true, data });
      } catch { normal = null; golden = null; }
      if (!normal || !golden) continue;
      this._registerDiySlot({ baseId: slot.baseId, goldenId: slot.goldenId, normal, golden, pick, shopLevel: slot.shopLevel, dev: false });
      return this._devDiyGain(slot.baseId, id, normal.name);
    }
    // 3. a new dev slot — the official four are not a limit in a dev match
    const tiers = tier !== undefined ? [tier] : [6, 5];
    for (const t of tiers) {
      const template = `chess_char_${t}_diy1_a`;
      if (!isObj(data?.backups?.diy?.slots) || !Object.hasOwn(data.backups.diy.slots, template)) continue;
      const pick = this._devDiyPick(template, id, { skillIndex, moduleId });
      if (!pick) continue;
      const max = Number.isInteger(this.m.devDiyMaxSlots) ? this.m.devDiyMaxSlots : DEV_DIY_MAX_SLOTS;
      if (Object.keys(this.diy).length >= max) {
        // a defensive bound only (a runaway client / script), never a rule: said out loud, with the number
        this.m.toast(this, 'warn', msg('调试自选位已达安全上限（{max}），属防御性限制', { max }));
        return fail(ERR.DEV_NO_SLOT, `dev 自选位 defensive bound ${max}`); // i18n-ignore: developer detail
      }
      const baseId = this._nextDevDiySlotId(t, data);
      if (!baseId) break;
      const goldenId = baseId.replace(/_a$/, '_b');
      const composed = this._devDiySlotRecords(template, baseId, goldenId, pick);
      if (!composed) continue;
      this._registerDiySlot({ baseId, goldenId, normal: composed.normal, golden: composed.golden, pick: composed.pick, shopLevel: diySlot(template, data)?.shopLevel ?? t, dev: true, template });
      return this._devDiyGain(baseId, id, composed.normal.name);
    }
    // nothing could be slotted: an explicit skill / module that no slot accepts is a bad request, anything else means
    // the data cannot field this operator at all (the panel greys exactly these rows)
    if (skillIndex !== undefined || moduleId !== undefined) {
      return fail(ERR.BAD_TARGET, `bad skill / module for ${id}`); // i18n-ignore: developer detail
    }
    return fail(ERR.DEV_NO_SLOT, `no 自选 slot takes ${id}`); // i18n-ignore: developer detail
  }

  /**
   * The composed records of this player's dev-only 自选 slots (both forms), `{ [id]: record }` — for THIS player's own
   * client only (`m.private.devChess`, player/views.js): their ids are not in data/chess.json, so the board, the bench
   * cards and the detail card resolve the operator through this map (public/js/data.js setChessOverlay). Null when the
   * match has no dev slot; an official 自选 slot's record is in the data and needs no overlay.
   * @returns {Record<string, object>|null}
   */
  devChessRecords() {
    const out = {};
    for (const [slotId, pick] of Object.entries(this.diy || {})) {
      if (!isObj(pick) || typeof pick.slotId !== 'string') continue;
      for (const id of [slotId, slotId.replace(/_a$/, '_b')]) {
        const rec = this._diyRecords.get(id);
        if (rec) out[id] = rec;
      }
    }
    return Object.keys(out).length ? out : null;
  }

  /**
   * Acquire one copy of a registered 自选 slot's chess through the ordinary path (copies, immediate merge, hand /
   * overflow temp, recompute).
   * @param {string} baseId a registered slot (official or dev) @param {string} charId the operator it holds
   * @param {string} [name] the composed record's name (for the reply)
   */
  _devDiyGain(baseId, charId, name = undefined) {
    const piece = this.acquireChess(baseId, { source: 'dev' });
    if (!piece) return fail(ERR.DEV_NO_SLOT, `cannot acquire ${baseId}`); // i18n-ignore: developer detail
    this.dirty();
    return { ...OK, kind: 'diy', id: piece.id, uid: piece.uid, charId, slot: baseId, name: name || this.gd.chess(piece.id)?.name };
  }

  /**
   * Register a 自选 slot on this player exactly as setDiy does: pick, both composed records, the data view, and the
   * slot's own stock. `dev: true` marks a slot this debugger created — player/diy.js keeps those out of the shop, the
   * promotion reward and the random-grant draws, so the formal pools never list them; `template` names the official slot
   * its records borrow from, and rides in the pick (`slotId`) for the client and the sim.
   * @param {{ baseId: string, goldenId: string, normal: object, golden: object, pick: any, shopLevel: number, dev: boolean, template?: string }} x
   */
  _registerDiySlot({ baseId, goldenId, normal, golden, pick, shopLevel, dev, template = undefined }) {
    const stored = dev && typeof template === 'string' ? { ...pick, slotId: template } : pick;
    this.diy = Object.freeze({ ...this.diy, [baseId]: Object.freeze({ ...stored }) });
    this._diyRecords = new Map([...this._diyRecords, [baseId, Object.freeze(normal)], [goldenId, Object.freeze(golden)]]);
    // the player's view first: tier / copies are read through its composed records (a dev slot has no data record)
    this.gd = diyGameData(this.m.gd, this._diyRecords);
    if (!this.diyStock.has(baseId)) {
      const cap = this.gd.poolCopies(baseId);
      if (cap > 0) {
        this.diyStock.entries.set(baseId, { cap, left: cap, tier: this.gd.tierOf(baseId), shopLevel, ...(dev ? { dev: true } : null) });
      }
    }
  }

  /**
   * The id of the next dev slot of `tier`: the lowest free `chess_char_<tier>_diy<N>_a` with N ≥ 3 (the official four are
   * `_diy1_` / `_diy2_` of tiers 5 and 6), so the ids are unique and predictable across gains.
   * @param {number} tier 5 | 6 @param {any} data data/backups.json + data/chess.json
   * @returns {string|null}
   */
  _nextDevDiySlotId(tier, data) {
    for (let n = 3; n < 1000; n++) {
      const id = `chess_char_${tier}_diy${n}_a`;
      if (Object.hasOwn(data.backups.diy.slots, id) || Object.hasOwn(this.diy, id) || this._diyRecords.has(id)) continue;
      return id;
    }
    return null;
  }

  /**
   * Compose a dev slot's two records: the tier's official slot identity (tier, price, sell price, 3 → elite merge, the
   * E2 Lv1 / E2 Lv60 status) under the dev ids, filled with the operator through the same composer the formal 自选 path
   * uses (shared/standIn.js composeUnitRecord; shared/diy.js diyRecordOf's rules, checked by checkDiyPick against the
   * official template).
   * @param {string} templateId an official slot of the wanted tier (`chess_char_<tier>_diy1_a`)
   * @param {string} baseId the dev slot's normal id @param {string} goldenId its elite id @param {any} pick
   * @returns {{ normal: object, golden: object, pick: { charId: string, skillIndex: number, uniEquipId: string|null } }|null}
   */
  _devDiySlotRecords(templateId, baseId, goldenId, pick) {
    const data = this.m.gd.raw;
    const template = diySlot(templateId, data);
    if (!template) return null;
    const checked = checkDiyPick(templateId, pick, data);
    if (!('ok' in checked)) return null;
    const { charId, skillIndex, uniEquipId } = checked.pick;
    const backups = data.backups;
    const unit = backups?.units?.[charId] ?? null;
    const proto = isPrototypePick(data, template.tier, charId);
    const bonds = isObj(backups?.diy?.operators?.[charId]?.bonds) ? backups.diy.operators[charId].bonds : null;
    const build = (tplRec, id, isGolden) => {
      if (!isObj(tplRec)) return null;
      const identity = { ...tplRec, chessId: id, baseId, goldenId, isGolden, upgradeChessId: goldenId, isDiy: true, visible: false };
      const form = unitForm(backups, charId, identity.status);
      const rec = composeUnitRecord(identity, unit, proto ? form : atPotential(form, null), { skillIndex, moduleId: uniEquipId, bonds });
      if (!rec || !rec.skill) return null;
      rec.diyFor = baseId;
      // the official slot this dev slot borrows its rules / records from (the sim's getDiy: pick.slotId)
      rec.diyTemplate = templateId;
      if (proto) rec.diyProto = true;
      return rec;
    };
    const normal = build(template.normal, baseId, false);
    const golden = build(template.golden, goldenId, true);
    return normal && golden ? { normal, golden, pick: checked.pick } : null;
  }

  /**
   * The pick a dev `diy` gain slots `charId` with in `slotId` — completed by shared/diy.js checkDiyPick, so only a
   * legal pick comes back. `skillIndex` / `moduleId` override the default; a prototype takes its locked selection.
   * @param {string} slotId @param {string} charId @param {{ skillIndex?: number, moduleId?: string }} [want]
   * @returns {{ charId: string, skillIndex: number, uniEquipId: string|null }|null}
   */
  _devDiyPick(slotId, charId, { skillIndex = undefined, moduleId = undefined } = {}) {
    const data = this.m.gd.raw;
    const slot = diySlot(slotId, data);
    if (!slot) return null;
    const pick = { charId };
    if (skillIndex !== undefined) pick.skillIndex = skillIndex;
    if (moduleId !== undefined) pick.uniEquipId = moduleId;
    if (isPrototypePick(data, slot.tier, charId)) {
      const c = checkDiyPickSafe(slotId, pick, data);
      return c ? c.pick : null;
    }
    // an owned pick: the 自选 picker's default (the last skill and the first module it may carry), else try the rest
    const forms = data?.backups?.units?.[charId]?.forms;
    const normal = unitForm(data?.backups, charId, slot.normal?.status);
    const elite = unitForm(data?.backups, charId, slot.golden?.status);
    if (!isObj(forms) || !normal || !elite) return null;
    const skills = (Array.isArray(normal.skills) ? normal.skills : []).filter((s) => s && Number.isInteger(s.index)).map((s) => s.index);
    const order = skillIndex !== undefined ? [skillIndex] : [...skills].reverse();
    const defModule = moduleId !== undefined
      ? moduleId
      : ((Array.isArray(elite.modules) ? elite.modules.filter(isDiyModule) : []).find((m) => m && m.uniEquipId)?.uniEquipId ?? null);
    for (const idx of order) {
      const c = checkDiyPickSafe(slotId, { charId, skillIndex: idx, uniEquipId: defModule }, data);
      if (c) return c.pick;
    }
    return null;
  }
}

/** shared/diy.js checkDiyPick as `{ pick }` or null (the checks live there; this module only picks a default). */
function checkDiyPickSafe(slotId, pick, data) {
  const res = checkDiyPick(slotId, pick, data);
  return res && 'ok' in res ? res : null;
}
