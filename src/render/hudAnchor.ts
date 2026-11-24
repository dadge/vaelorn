/**
 * Ancrage du HUD vers les bords EXTÉRIEURS de l'écran (PUR : aucune dépendance à Phaser ni au DOM).
 *
 * Pourquoi : à 2-4 joueurs, un HUD collé en haut à gauche de SA vue se retrouve, pour les vues de droite et du bas, près du CENTRE de
 * l'écran, là où la minicarte (voir `mapZone.ts`) est dessinée. Règles :
 *  - colonne gauche : bloc principal (nom, PV, cœurs, équipement, spécial, clés, objectifs perso) collé au bord GAUCHE de l'écran ;
 *    colonne droite : collé au bord DROIT (chaque ligne touche le bord individuellement ; les bonus se rangent à gauche de l'équipement : `mirror`) ;
 *  - rangée du haut : collé en HAUT ; rangée du bas (vues 3 et 4 à 3-4 joueurs) : collé en BAS ;
 *  - le bloc « Objectif de la salle » (et les bandeaux sablier / lanterne empilés dessous) passe dans l'AUTRE coin horizontal de la
 *    même arête extérieure ; les bandeaux s'empilent vers l'INTÉRIEUR de la vue (vers le bas en haut, vers le haut en bas) ;
 *  - le bloc d'objectif de salle et les bandeaux sont bornés en largeur (`sideBlockMaxWidth`, `bannerMaxWidth`) : ils ne recouvrent jamais le bloc principal ;
 *  - 1 joueur (et invité réseau : une seule vue plein écran) : INCHANGÉ (déjà aux bords).
 *
 * `mainBlockMetrics` calcule les dimensions du bloc principal à partir des MÊMES constantes que le constructeur de `PlayerHud`
 * (qui les lit ici : aucune dérive possible entre le dessin et le calcul).
 */
import type { SplitLayout } from './splitscreen';

export type HudAlignX = 'left' | 'right';
export type HudAlignY = 'top' | 'bottom';

/** Où se place le HUD d'une vue. */
export interface HudAnchor {
  /** Bord horizontal du bloc principal. */
  alignX: HudAlignX;
  /** Arête verticale (haut / bas) commune au bloc principal et au bloc d'objectif de salle. */
  alignY: HudAlignY;
  /** Coin horizontal du bloc « Objectif de la salle » : l'opposé de `alignX` (même arête verticale). */
  goalAlignX: HudAlignX;
  /** Arête verticale du bloc d'objectif de salle (= `alignY`). */
  goalAlignY: HudAlignY;
}

/** Marge (px) entre le HUD et le bord de la vue (inchangée par rapport à l'ancien HUD). */
export const HUD_MARGIN = 10;

/** Ancrage de la vue `viewIndex` pour la disposition `layout` (ordre des vues : voir `computeLayout`). Pur. */
export function hudAnchor(layout: SplitLayout, viewIndex: number): HudAnchor {
  const n = layout.playerCount;
  if (n <= 1) return { alignX: 'left', alignY: 'top', goalAlignX: 'right', goalAlignY: 'top' };
  const i = Math.max(0, Math.min(layout.viewports.length - 1, Math.floor(viewIndex)));
  // 2 joueurs : [gauche, droite] ; 3-4 joueurs : [haut-gauche, haut-droite, bas-gauche, bas-droite]
  const alignX: HudAlignX = i % 2 === 0 ? 'left' : 'right';
  const alignY: HudAlignY = n >= 3 && i >= 2 ? 'bottom' : 'top';
  return { alignX, alignY, goalAlignX: alignX === 'left' ? 'right' : 'left', goalAlignY: alignY };
}

/** Largeur (en caractères) réservée au texte de la jauge de spécial quand on ne connaît pas les vrais libellés (« PRÊT [F/X / Y] », « Nom du spécial 12 s »). */
export const SPECIAL_TEXT_EST_CHARS = 24;
/** Longueur maximale (caractères) du rappel de touche du spécial (« F/X / Y » : 7 ; marge pour des touches de nom plus long). */
export const SPECIAL_HINT_MAX_CHARS = 9;
/** Largeur (en caractères) réservée au texte des PV (« PV 150/150 »). */
export const HP_TEXT_EST_CHARS = 10;
/** Écart minimal (px) entre le bloc principal et un bloc posé sur la même arête (objectif de salle, bandeaux). */
export const BLOCK_GAP = 8;
/** Largeur d'un caractère de la police monospace grasse, en part de la taille (estimation pour réserver la place). */
export const MONO_CHAR_RATIO = 0.62;

/** Paramètres du bloc principal (tous connus à la construction du HUD). */
export interface MainBlockParams {
  /** Zoom entier de la disposition (taille d'une icône = 8 × u). */
  u: number;
  /** Taille de police de base du HUD (17 si u >= 3, sinon 13). */
  fs: number;
  /** Largeur de la vue (px écran). */
  vw: number;
  /** Nombre de cœurs. */
  heartsN: number;
  /** Rangée d'équipement + bonus présents (absents : démo). */
  gearOn: boolean;
  /** Emplacement cœur présent. */
  slotOn: boolean;
  /** Nombre d'icônes de bonus temporaires. */
  buffCount: number;
  /**
   * Bloc collé au bord DROIT (colonne de droite) : les bonus temporaires se rangent À GAUCHE de l'équipement (ils grandissent vers l'intérieur de l'écran) au lieu de
   * la droite, pour que l'équipement touche le bord ; sans effet sans rangée d'équipement. Défaut : non (disposition historique).
   */
  mirror?: boolean;
  /** Longueur (caractères) du nom du héros dans la langue courante (défaut 12) : estime la largeur de la ligne du nom. */
  nameChars?: number;
  /** Longueur (caractères) du plus long texte de la jauge de spécial (défaut `SPECIAL_TEXT_EST_CHARS`) ; 0 = pas de spécial (ligne sans largeur). */
  specialChars?: number;
}

/** Largeur (px) de chacune des lignes du bloc principal : dans la colonne de droite, CHAQUE ligne est collée au bord droit individuellement. */
export interface MainBlockRows {
  name: number;
  hearts: number;
  gear: number;
  sp: number;
  keys: number;
}

/** Dimensions et décalages (px, relatifs au coin haut-gauche du bloc) du bloc principal. */
export interface MainBlockMetrics {
  /** Y des cœurs, de l'équipement, du spécial, des clés, des objectifs perso. */
  hy: number;
  gy: number;
  sy: number;
  ky: number;
  oy: number;
  /** Hauteur de la partie statique (jusqu'à la rangée des clés comprise, sans objectifs perso). */
  staticH: number;
  /**
   * Largeur du bloc (la plus large de ses lignes FIXES : cœurs, équipement + bonus, spécial, clés, nom) : emprise réservée sur l'arête de la vue (les blocs d'objectif de salle et
   * les bandeaux ne la recouvrent jamais) et bord gauche du bloc dans la colonne de droite. Les objectifs perso, de largeur variable, ne comptent pas : le HUD les aligne
   * lui-même sur le bord droit (voir `objW`).
   */
  w: number;
  /** Largeur de chaque ligne fixe (la plus large vaut `w`). */
  rows: MainBlockRows;
  /** Largeur maximale du bloc des objectifs perso (fond compris). */
  objW: number;
  /** Détails des constantes partagées avec le constructeur. */
  pipH: number;
  slotH: number;
  slotW: number;
  hintSize: number;
  /** X (relatif au coin gauche de la ligne d'équipement) de l'emplacement cœur ; 0 sauf quand les bonus se rangent à sa gauche (`mirror`). */
  slotX: number;
  gearX0: number;
  gearCell: number;
  /** X de la première case de bonus et pas entre deux cases (négatif quand les bonus grandissent vers la gauche : `mirror`). */
  buffX0: number;
  buffStep: number;
  buffCell: number;
  spBarW: number;
  tx0: number;
  torchBarW: number;
  objWrap: number;
  /** Échelle des icônes d'objectif perso. */
  objScale: number;
}

/** Calcule le plan du bloc principal. Pur ; mêmes formules que l'ancien constructeur de `PlayerHud` (aucune position ne change à 1 joueur ni dans la colonne de gauche). */
export function mainBlockMetrics(p: MainBlockParams): MainBlockMetrics {
  const { u, fs, vw } = p;
  const hy = fs + 10;
  const pipH = Math.max(3, u + 1);
  const gy = hy + 8 * u + 4;
  const slotH = 8 * u + pipH + 4;
  const hintSize = Math.max(12, fs - 3);
  const slotW = 8 * u + 5 + Math.round(hintSize * 0.62) * 2 + 4;
  const gearCell = 8 * u + u + 3;
  const buffCell = 8 * u + 8;
  const mirror = p.mirror === true && p.gearOn;
  // bonus à droite de l'équipement (historique) ou, collé au bord droit, à sa gauche (la première case touche l'emplacement cœur, les suivantes s'éloignent vers la gauche)
  const slotX = mirror ? 8 * u + 10 + (p.buffCount - 1) * buffCell : 0;
  const gearX0 = slotX + (p.slotOn ? slotW + 7 : 0);
  const buffX0 = mirror ? slotX - 8 - (8 * u + 2) : gearX0 + 6 * gearCell + 8;
  const buffStep = mirror ? -buffCell : buffCell;
  const sy = p.gearOn ? gy + 8 * u + pipH + 7 : p.slotOn ? gy + slotH + 6 : hy + 8 * u + 6;
  const spBarW = Math.max(64, Math.min(96, Math.floor(vw * 0.2)));
  const ky = sy + 8 * u + 6;
  const tx0 = 3 * (8 * u + u) + 10;
  const torchBarW = 14 * u;
  const oy = ky + 8 * u + 8;
  const objScale = Math.max(1, u - 1);
  const objWrap = Math.min(Math.floor(vw * 0.45), 460);

  // largeur de chaque ligne du bloc
  const specialChars = p.specialChars ?? SPECIAL_TEXT_EST_CHARS;
  const nameChars = p.nameChars ?? 12;
  const heartsW = (p.heartsN - 1) * (8 * u + u) + 8 * u;
  const gearW = mirror ? gearX0 + 5 * gearCell + 8 * u + 2 : p.gearOn ? buffX0 + (p.buffCount - 1) * buffCell + 8 * u + 2 : p.slotOn ? slotW : 0;
  const spW = specialChars > 0 ? 8 * u + 6 + spBarW + 10 + Math.ceil(specialChars * MONO_CHAR_RATIO * (fs - 1)) : 0;
  const keysW = tx0 + 8 * u + 4 + torchBarW + 2;
  const nameW = Math.ceil(nameChars * MONO_CHAR_RATIO * (fs + 2)) + 14 + Math.ceil(HP_TEXT_EST_CHARS * MONO_CHAR_RATIO * (fs - 2));
  const objW = 8 * objScale + 6 + objWrap + 8;
  const rows: MainBlockRows = { name: nameW, hearts: heartsW, gear: gearW, sp: spW, keys: keysW };
  const w = Math.max(heartsW, gearW, spW, keysW, nameW);

  return {
    hy, gy, sy, ky, oy,
    staticH: ky + 8 * u,
    w,
    rows,
    objW,
    pipH, slotH, slotW, hintSize, slotX, gearX0, gearCell, buffX0, buffStep, buffCell, spBarW, tx0, torchBarW, objWrap, objScale,
  };
}

/**
 * Largeur maximale (px) du FOND d'un bloc posé sur la même arête que le bloc principal, dans l'autre coin (objectif de salle) : il ne doit jamais recouvrir le bloc principal
 * (`mainW` = `MainBlockMetrics.w`). Le fond d'un bloc d'objectif déborde de 1 px à l'intérieur de la marge de la vue.
 */
export function sideBlockMaxWidth(vw: number, mainW: number, margin: number = HUD_MARGIN, gap: number = BLOCK_GAP): number {
  return Math.max(0, vw - 2 * margin - mainW - gap - 1);
}

/** Largeur maximale (px) du fond d'un bandeau (sablier, lanterne), posé 4 px en dehors de la marge, dans l'autre coin que le bloc principal. */
export function bannerMaxWidth(vw: number, mainW: number, margin: number = HUD_MARGIN, gap: number = BLOCK_GAP): number {
  return Math.max(0, vw - 2 * margin - mainW - gap + 4);
}
