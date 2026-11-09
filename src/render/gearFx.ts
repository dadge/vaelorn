/**
 * Équipement — fonctions PURES de rendu (testées) : frames d'atlas, couleurs de halo par niveau, clignotement des 4 dernières secondes, flottement,
 * libellés (nom, effet, texte flottant du ramassage), modèle de la rangée d'icônes du HUD (ordre, pastilles de niveau). Aucune dépendance à Phaser :
 * l'habillage vit dans `entities/LifeViews.ts` (objets au sol) et `render/hud.ts` (rangée d'icônes).
 * Aucune chaîne en dur : tout texte passe par une clé i18n `gear.*` (parts `gear.fr.json` / `gear.en.json`).
 */
import {
  ACCESSORY_BONUS,
  BUFF_RAGE_BONUS,
  BUFF_SPEED_BONUS,
  GEAR_AXE_COOLDOWN_MULT,
  GEAR_BLINK_MS,
  GEAR_BONUS,
  GEAR_BOW_RANGED_BONUS,
  HORN_DURATION_MS,
  VAMPIRE_HEAL_HP,
  VAMPIRE_KILLS_PER_HEAL,
} from '../core/balance';
import { GEAR_SLOTS, ROMAN_LEVELS, buffDurationMs, gearLevelOf, itemOfSlot } from '../core/gear';
import type { ActiveBuff, BuffKind, DroppedBuffKind, GearItem, GearSlot, PlayerGear } from '../core/types';

/** Couleur d'un niveau (halo au sol, pastille du HUD) : I argenté, II bleu clair, III doré. Indice 0 = vide (gris). */
export const GEAR_LEVEL_COLORS: readonly number[] = [0x6e6a82, 0xdfe8ff, 0x7fd0ff, 0xffd85a];

/** Couleur du niveau `level` (0 = emplacement vide). */
export function gearLevelColor(level: number): number {
  return GEAR_LEVEL_COLORS[Math.max(0, Math.min(3, Math.floor(level)))] ?? GEAR_LEVEL_COLORS[0];
}

/** Frame d'atlas 16×16 d'un objet au sol. */
export function gearFrame(item: GearItem): string {
  return item.slot === 'accessory' ? `gear_accessory_${item.accessory ?? 'lantern'}_${item.level}` : `gear_${item.slot}_${item.level}`;
}

/** Frame d'atlas 8×8 de l'icône de HUD d'un objet. */
export function gearIconFrameOf(item: GearItem): string {
  return item.slot === 'accessory' ? `gear_icon_accessory_${item.accessory ?? 'lantern'}_${item.level}` : `gear_icon_${item.slot}_${item.level}`;
}

/** Opacité fixe d'un objet qui va disparaître quand l'utilisateur demande moins d'animation (`prefers-reduced-motion`) : pas de clignotement. */
export const GEAR_REDUCED_ALPHA = 0.55;

/**
 * Opacité d'un objet d'équipement au sol : 1 tant qu'il lui reste plus de `GEAR_BLINK_MS` de vie ; ensuite il clignote (plein / presque éteint) à 2 Hz,
 * puis à 3 Hz pendant la dernière seconde (jamais plus de 3 flashs par seconde : sûr pour la photosensibilité). Avec `reducedMotion` : opacité fixe
 * `GEAR_REDUCED_ALPHA` pendant les 4 dernières secondes. Dépend uniquement de `ttlMs`, du temps de jeu et de la préférence.
 */
export function gearAlpha(ttlMs: number, timeMs: number, reducedMotion = false): number {
  if (!(ttlMs <= GEAR_BLINK_MS)) return 1;
  if (reducedMotion) return GEAR_REDUCED_ALPHA;
  const halfPeriodMs = ttlMs > 1000 ? 250 : 167;
  return Math.floor(Math.max(0, timeMs) / halfPeriodMs) % 2 === 0 ? 1 : 0.2;
}

/** Petit flottement vertical (px) d'un objet au sol, déphasé par son id ; nul avec `reducedMotion`. */
export function gearBob(timeMs: number, id: number, reducedMotion = false): number {
  if (reducedMotion) return 0;
  return Math.sin(timeMs / 260 + id * 1.3) * 1.2;
}

/** Clé i18n du nom d'un objet (sans le chiffre romain) : `gear.name.<emplacement>.<niveau>` ; accessoire : `gear.name.accessory.<sorte>` (même nom à tous les niveaux). */
export function gearNameKey(item: GearItem): string {
  return item.slot === 'accessory' ? `gear.name.accessory.${item.accessory ?? 'lantern'}` : `gear.name.${item.slot}.${item.level}`;
}

/** Le libellé de l'objet porte-t-il son niveau ? Non pour l'anneau du vampire (toujours de niveau III). */
export function hasLevelInLabel(item: GearItem): boolean {
  return !(item.slot === 'accessory' && item.accessory === 'vampire');
}

/** Clé i18n du nom d'un emplacement (`gear.slot.<emplacement>`). */
export function gearSlotKey(slot: GearSlot): string {
  return `gear.slot.${slot}`;
}

/** Pourcentage entier d'une fraction (0,3 → 30). */
function pct(f: number): number {
  return Math.round(f * 100);
}

/** Texte d'effet d'un objet : clé i18n + paramètres (valeurs lues dans `balance.ts`, jamais recopiées). `ranged` : le porteur tire déjà (effet de l'Arc). */
export function gearEffect(item: GearItem, ranged = false): { key: string; params?: Record<string, number> } {
  const i = Math.max(0, Math.min(2, item.level - 1));
  switch (item.slot) {
    case 'boots':
      return { key: 'gear.effect.boots', params: { n: pct(GEAR_BONUS.boots[i]) } };
    case 'protection':
      return { key: 'gear.effect.protection', params: { n: pct(GEAR_BONUS.protection[i]) } };
    case 'artifact':
      return { key: 'gear.effect.artifact', params: { n: pct(GEAR_BONUS.artifact[i]) } };
    case 'magic':
      return { key: 'gear.effect.magic', params: { n: pct(GEAR_BONUS.magic[i]) } };
    case 'weapon':
      if (item.level === 1) return { key: 'gear.effect.sword', params: { n: pct(GEAR_BONUS.weapon[0]) } };
      if (item.level === 2) return { key: 'gear.effect.axe', params: { n: pct(GEAR_BONUS.weapon[1]), m: pct(GEAR_AXE_COOLDOWN_MULT - 1) } };
      return ranged ? { key: 'gear.effect.bow.ranged', params: { n: pct(GEAR_BOW_RANGED_BONUS) } } : { key: 'gear.effect.bow.melee' };
    default:
      switch (item.accessory) {
        case 'magnet':
          return { key: 'gear.effect.magnet', params: { n: ACCESSORY_BONUS.magnet[i] } };
        case 'warhorn':
          return { key: 'gear.effect.warhorn', params: { n: pct(ACCESSORY_BONUS.warhorn[i]) } };
        case 'vampire':
          return { key: 'gear.effect.vampire', params: { n: VAMPIRE_HEAL_HP, k: VAMPIRE_KILLS_PER_HEAL } };
        default:
          return { key: 'gear.effect.lantern', params: { n: pct(ACCESSORY_BONUS.lantern[i]) } };
      }
  }
}

/** Traducteur minimal (`t` de i18n, ou un faux dans les tests). */
export type Translate = (key: string, params?: Record<string, string | number>) => string;

/** Libellé d'un objet : « Bottes ailées III » ; « Anneau du vampire » (sans niveau, il est toujours III). */
export function gearLabel(item: GearItem, tr: Translate): string {
  if (!hasLevelInLabel(item)) return tr(gearNameKey(item));
  return `${tr(gearNameKey(item))} ${ROMAN_LEVELS[item.level] ?? ''}`.trim();
}

/** Largeur (px monde) de retour à la ligne des textes flottants d'équipement (ramassage, échange, bonus) : ils restent dans la vue d'un joueur en écran partagé. */
export const GEAR_FLOAT_WRAP_PX = 120;

/** Clé i18n de l'invite « A : échanger » affichée quand un accessoire d'une autre sorte est à portée. */
export const GEAR_SWAP_PROMPT_KEY = 'gear.swap.prompt';

/** Texte flottant de l'échange manuel : « Cor de guerre II : l'appel donne +30 % de vitesse aux alliés » (même format que le ramassage). */
export function gearSwappedText(item: GearItem, tr: Translate): string {
  return gearPickedText(item, false, tr);
}

/** Frame de la silhouette (atténuée) d'un emplacement VIDE dans le HUD. */
export function gearEmptyFrame(slot: GearSlot): string {
  return slot === 'accessory' ? 'gear_icon_accessory_lantern_1' : `gear_icon_${slot}_1`;
}

/** Texte flottant du ramassage : « Bottes ailées III : +30 % vitesse » (clé `gear.picked`). */
export function gearPickedText(item: GearItem, ranged: boolean, tr: Translate): string {
  const eff = gearEffect(item, ranged);
  return tr('gear.picked', { name: gearLabel(item, tr), effect: tr(eff.key, eff.params) });
}

/** Couleur du texte flottant du ramassage : celle du niveau de l'objet. */
export function gearPickedColor(item: GearItem): number {
  return gearLevelColor(item.level);
}

// ───────────────────────────── Rangée d'icônes du HUD ─────────────────────────────

/** Une case de la rangée d'équipement du HUD. */
export interface GearHudSlot {
  slot: GearSlot;
  /** Niveau équipé (0 = vide). */
  level: number;
  /** Frame de l'icône 8×8, ou null si l'emplacement est vide. */
  frame: string | null;
  /** Pastille de niveau (« I », « II », « III »), vide si l'emplacement est vide. */
  pip: string;
  /** Couleur de la pastille (celle du niveau). */
  color: number;
}

/** Modèle de la rangée d'équipement : toujours les 6 emplacements, dans l'ordre bottes, protection, artefact, magie, arme, accessoire. */
export function gearHudSlots(gear: PlayerGear | undefined): GearHudSlot[] {
  return GEAR_SLOTS.map((slot): GearHudSlot => {
    const item = gear ? itemOfSlot(gear, slot) : null;
    const level = gear ? gearLevelOf(gear, slot) : 0;
    return { slot, level, frame: item ? gearIconFrameOf(item) : null, pip: ROMAN_LEVELS[level] ?? '', color: gearLevelColor(level) };
  });
}

/** Signature compacte de la rangée (rafraîchir le HUD seulement quand elle change). */
export function gearHudSignature(gear: PlayerGear | undefined): string {
  return gearHudSlots(gear)
    .map((s) => (s.frame ?? '-'))
    .join('|');
}

// ───────────────────────────── Bonus temporaires ─────────────────────────────

/** Ordre d'affichage des icônes de bonus temporaires dans le HUD (rangée compactée : seuls les bonus actifs sont affichés, dans cet ordre). */
export const BUFF_HUD_ORDER: readonly BuffKind[] = ['speed', 'rage', 'star', 'horn'];

/** Frame d'atlas 16×16 d'un bonus temporaire au sol. */
export function buffFrame(kind: DroppedBuffKind): string {
  return `gear_buff_${kind}`;
}

/** Niveau (1..3) du cor de guerre qui a donné une puissance `power` (fraction de vitesse) : sert à choisir l'icône du bonus reçu. */
export function hornLevelOfPower(power: number | undefined): number {
  const p = power ?? 0;
  const lv = ACCESSORY_BONUS.warhorn.findIndex((v) => Math.abs(v - p) < 1e-6);
  return lv >= 0 ? lv + 1 : p >= ACCESSORY_BONUS.warhorn[2] ? 3 : p >= ACCESSORY_BONUS.warhorn[1] ? 2 : 1;
}

/** Frame d'atlas 8×8 de l'icône de HUD d'un bonus temporaire (le bonus du cor reprend l'icône du cor, au niveau du porteur). */
export function buffIconFrameOf(buff: Pick<ActiveBuff, 'kind' | 'power'>): string {
  if (buff.kind === 'horn') return `gear_icon_accessory_warhorn_${hornLevelOfPower(buff.power)}`;
  return `gear_icon_buff_${buff.kind}`;
}

/** Couleur d'un bonus temporaire (halo au sol, anneau de compte à rebours du HUD). */
export function buffColor(kind: BuffKind): number {
  switch (kind) {
    case 'speed':
      return 0x7fd0ff;
    case 'rage':
      return 0xff6a4a;
    case 'star':
      return 0xffe45a;
    default:
      return 0xffd85a;
  }
}

/** Durée totale (ms) d'un bonus temporaire à son démarrage (pour la fraction restante de l'anneau). */
export function buffTotalMs(kind: BuffKind): number {
  return kind === 'horn' ? HORN_DURATION_MS : buffDurationMs(kind);
}

/** Clé i18n du nom d'un bonus temporaire. */
export function buffNameKey(kind: BuffKind): string {
  return `gear.buff.${kind}`;
}

/** Texte d'effet d'un bonus temporaire : clé i18n + paramètres (n = pourcentage, s = secondes). */
export function buffEffect(kind: BuffKind, power?: number, durationMs?: number): { key: string; params: Record<string, number> } {
  const s = Math.round((durationMs ?? buffTotalMs(kind)) / 1000);
  switch (kind) {
    case 'speed':
      return { key: 'gear.buff.effect.speed', params: { n: pct(BUFF_SPEED_BONUS), s } };
    case 'rage':
      return { key: 'gear.buff.effect.rage', params: { n: pct(BUFF_RAGE_BONUS), s } };
    case 'star':
      return { key: 'gear.buff.effect.star', params: { s } };
    default:
      return { key: 'gear.buff.effect.horn', params: { n: pct(power ?? 0), s } };
  }
}

/** Texte flottant du démarrage d'un bonus : « Potion de vitesse : +40 % vitesse, 8 s » (clé `gear.picked`). */
export function buffStartedText(kind: BuffKind, power: number | undefined, durationMs: number, tr: Translate): string {
  const eff = buffEffect(kind, power, durationMs);
  return tr('gear.picked', { name: tr(buffNameKey(kind)), effect: tr(eff.key, eff.params) });
}

/** Une icône de bonus temporaire du HUD. */
export interface BuffHudEntry {
  kind: BuffKind;
  frame: string;
  /** Fraction de durée RESTANTE (0..1) : l'anneau se vide. */
  fraction: number;
  /** Secondes restantes, arrondies au-dessus (jamais 0 tant que le bonus dure). */
  seconds: number;
  color: number;
}

/** Modèle des icônes de bonus temporaires : les bonus actifs, dans l'ordre `BUFF_HUD_ORDER`. */
export function buffHudEntries(buffs: readonly ActiveBuff[] | undefined): BuffHudEntry[] {
  const out: BuffHudEntry[] = [];
  for (const kind of BUFF_HUD_ORDER) {
    const b = (buffs ?? []).find((x) => x.kind === kind && x.remainingMs > 0);
    if (!b) continue;
    const total = Math.max(1, buffTotalMs(kind));
    out.push({
      kind,
      frame: buffIconFrameOf(b),
      fraction: Math.max(0, Math.min(1, b.remainingMs / total)),
      seconds: Math.max(1, Math.ceil(b.remainingMs / 1000)),
      color: buffColor(kind),
    });
  }
  return out;
}

/** Signature compacte des icônes de bonus (rafraîchir les icônes seulement quand l'ensemble change ; l'anneau, lui, se redessine à chaque rafraîchissement). */
export function buffHudSignature(buffs: readonly ActiveBuff[] | undefined): string {
  return buffHudEntries(buffs)
    .map((e) => e.frame)
    .join('|');
}
