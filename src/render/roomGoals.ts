/**
 * Objectifs lisibles à l'écran — PARTIE PURE (aucune dépendance à Phaser, testée sans lui).
 *
 * Deux familles :
 *  1. L'OBJECTIF DE LA SALLE (partagé, identique pour tous les joueurs) : ce qu'il faut faire pour ouvrir la sortie,
 *     dérivé de `room.exit.requires` (+ des objectifs personnels de tout le niveau dans la salle finale, comme le fait
 *     `GameSimulation.isExitOpen`). `describeRoomGoals` renvoie une liste de `GoalLine` à cocher.
 *  2. Les OBJECTIFS PERSONNELS d'un joueur (`describePersonalObjectives`) : libellé du niveau + détail de progression
 *     (coups fatals PORTÉS PAR LE JOUEUR, temps à tenir dans une zone…), sans fraction orpheline.
 *
 * On regroupe aussi ici les aides d'affichage historiquement dans `hud.ts` (sortie ouverte, ennemis restants, objectifs
 * visibles…) : `hud.ts` les ré-exporte, les imports existants restent valides. Aucun changement de règle de jeu : tout
 * est calculé en LECTURE SEULE depuis `GameState`. Aucune chaîne en dur : tout texte passe par `t(clé)`.
 */
import { CHARACTERS } from '../core/characters';
import { isAnyBossKind } from '../core/enemies';
import { pointInTileRect } from '../core/geometry';
import {
  areAllRequirementsMet,
  isMechanismSolved,
  isRequirementMet,
  mechanismLabelKey,
  type RequirementContext,
} from '../core/mechanisms';
import { allObjectivesDone, isObjectiveDone, isZoneOccupied, objectivesForPlayer } from '../core/objectives';
import type {
  GameState,
  LevelDef,
  MechanismDef,
  MechanismState,
  ObjectiveDef,
  ObjectiveState,
  PlayerId,
  RoomDef,
} from '../core/types';
import { t } from '../i18n/i18n';

// ───────────────────────────── Aides historiques du HUD (sortie, ennemis, objectifs) ─────────────────────────────

/** « 40% » à partir d'une progression 0..1 (bornée, arrondie, jamais NaN). */
export function formatPercent(progress: number): string {
  const p = Number.isFinite(progress) ? Math.max(0, Math.min(1, progress)) : 0;
  return `${Math.round(p * 100)}%`;
}

/** Ligne d'objectif personnel prête à afficher. */
export interface ObjectiveLine {
  id: string;
  done: boolean;
  /** Libellé traduit (t(labelKey)). */
  label: string;
  /** Détail de progression traduit (zone/kills) ou chaîne vide (mécanisme / accompli). */
  detail: string;
  /** Pourcentage « 40% » pour une zone en cours (temps à tenir), sinon chaîne vide (kills : le détail « x/y » suffit). */
  percent: string;
  progress: number;
  /** Compteur « 1/3 » d'un objectif de coups fatals en cours, sinon ''. */
  counter: string;
  /** Nom de la salle où se trouve l'objectif quand ce n'est PAS la salle courante (objectif d'une salle passée), sinon ''. */
  where: string;
}

/**
 * Décrit un objectif personnel : libellé, détail et pourcentage (pourcentage pour une zone seulement : pour des coups
 * fatals, « Coups fatals portés : 1/3 » suffit). `roomName` : nom de la salle à signaler (objectif d'une autre salle).
 */
export function describeObjective(def: ObjectiveDef, state: ObjectiveState, roomName = ''): ObjectiveLine {
  const progress = Number.isFinite(state.progress) ? Math.max(0, Math.min(1, state.progress)) : 0;
  let detail = '';
  let percent = '';
  let counter = '';
  if (!state.done) {
    if (def.kind === 'kills') {
      const total = Math.max(1, def.count ?? 1);
      const count = Math.min(total, Math.round(progress * total));
      counter = `${count}/${total}`;
      detail = t('hud.kills', { count, total });
    } else if (def.kind === 'zone') {
      const seconds = Math.max(0, def.seconds ?? 0);
      detail = t('hud.zoneHold', { seconds: Math.max(0, Math.ceil(seconds * (1 - progress))) });
      percent = formatPercent(progress);
    }
  }
  return { id: def.id, done: state.done, label: t(def.labelKey), detail, percent, progress, counter, where: state.done ? '' : roomName };
}

/** Indice d'une salle dans le niveau (-1 si absente). */
export function roomIndexOf(level: LevelDef, roomId: string): number {
  for (let i = 0; i < level.rooms.length; i++) if (level.rooms[i].id === roomId) return i;
  return -1;
}

/**
 * Objectifs d'un joueur à afficher : ceux de la salle courante + ceux des salles passées non accomplis
 * (ces derniers portent le nom de leur salle dans `where`).
 */
export function visibleObjectives(state: GameState, level: LevelDef, playerId: PlayerId, room: RoomDef): ObjectiveLine[] {
  const current = roomIndexOf(level, room.id);
  const out: ObjectiveLine[] = [];
  for (const e of objectivesForPlayer(state.objectives, level, playerId)) {
    const idx = roomIndexOf(level, e.def.roomId);
    if (e.def.roomId === room.id) out.push(describeObjective(e.def, e.state));
    else if (idx >= 0 && idx < current && !e.state.done) out.push(describeObjective(e.def, e.state, t(level.rooms[idx].nameKey)));
  }
  return out;
}

/** Nombre d'objectifs accomplis / total d'un joueur sur tout le niveau. */
export function objectiveTotals(state: GameState, level: LevelDef, playerId: PlayerId): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const e of objectivesForPlayer(state.objectives, level, playerId)) {
    total++;
    if (e.state.done) done++;
  }
  return { done, total };
}

/** Nombre d'ennemis vivants de la salle courante (même définition que la simulation : ni `dead` ni PV épuisés). */
function aliveEnemyCount(state: GameState): number {
  let alive = 0;
  for (const e of state.room.enemies) if (!e.dead && e.hp > 0) alive++;
  return alive;
}

/** Contexte d'évaluation des exigences, miroir de `GameSimulation.requirementContext` (lecture seule). */
export function requirementContextFor(state: GameState, level: LevelDef, room: RoomDef): RequirementContext {
  return {
    mechanisms: state.room.mechanisms,
    aliveEnemyCount: aliveEnemyCount(state) + pendingSpawnCount(state, room),
    objectiveDone: (id) => isObjectiveDone(state.objectives, id),
    zoneOccupied: (id) => isZoneOccupied(state.objectives, level, room, state.players, id),
    zoneEntered: (zoneId) => {
      const zone = (room.zones ?? []).find((z) => z.id === zoneId);
      if (!zone) return false;
      return state.players.some((p) => p.status === 'alive' && pointInTileRect(p.pos, zone.rect));
    },
  };
}

/** La sortie de cette salle termine-t-elle le niveau ? (miroir de `GameSimulation.isFinalRoom`) */
function isFinalRoom(state: GameState, level: LevelDef, room: RoomDef): boolean {
  if (room.exit.final === true) return true;
  const idx = roomIndexOf(level, room.id);
  return (idx >= 0 ? idx : state.roomIndex) >= level.rooms.length - 1;
}

/**
 * La sortie de la salle est-elle ouverte ? Miroir exact de `GameSimulation.isExitOpen` : toutes les exigences
 * `room.exit.requires` satisfaites ET, dans la salle finale, tous les objectifs personnels du niveau accomplis.
 */
export function computeExitOpen(state: GameState, level: LevelDef, room: RoomDef): boolean {
  if (!areAllRequirementsMet(room.exit.requires, requirementContextFor(state, level, room))) return false;
  return !isFinalRoom(state, level, room) || allObjectivesDone(state.objectives);
}

/** Le compteur d'ennemis restants n'apparaît qu'à partir de ce nombre (garde la surprise des vagues). */
export const ENEMY_COUNTER_MAX = 5;

/** Apparitions de la salle applicables à ce nombre de joueurs qui n'ont pas encore eu lieu (miroir de la simulation). */
export function pendingSpawnCount(state: GameState, room: RoomDef): number {
  const spawned = state.room.spawnedSpawnIdx;
  let n = 0;
  room.enemies.forEach((def, i) => {
    if ((def.minPlayers ?? 1) <= state.playerCount && !spawned.includes(i)) n++;
  });
  return n;
}

/**
 * Ennemis restants (vivants + apparitions en attente) tant que la sortie exige `clear` et que ce n'est pas satisfait ;
 * null si la sortie n'exige pas `clear` ou si plus aucun ennemi ne reste. (Constat 18.)
 */
export function enemiesRemaining(state: GameState, room: RoomDef): number | null {
  if (!room.exit.requires.includes('clear')) return null;
  const n = aliveEnemyCount(state) + pendingSpawnCount(state, room);
  return n > 0 ? n : null;
}

// ───────────────────────────── Objectif de la salle ─────────────────────────────

/** Nature d'une ligne d'objectif de salle (tests, couleur). */
export type GoalKind = 'clear' | 'boss' | 'door' | 'mechanism' | 'objectives' | 'zone' | 'enter' | 'exit';

/** Ligne d'objectif de salle, partagée par tous les joueurs. */
export interface GoalLine {
  /** Jeton d'exigence d'origine (ou `objectives` / `exit`). */
  id: string;
  kind: GoalKind;
  /** Libellé traduit (« Vaincre tous les ennemis », « Ouvrir : Porte à plaques »…). Jamais vide. */
  label: string;
  /** Complément traduit (« (4 restants) », « (1/2) », « (en attente : David) »), ou ''. */
  detail: string;
  /** Exigence satisfaite (case cochée). */
  done: boolean;
  /** Ligne mise en évidence (sortie ouverte). */
  highlight: boolean;
}

/** Nombre maximal de lignes d'objectif de salle que le HUD sait dessiner. */
export const MAX_GOAL_LINES = 8;

/** Au plus ce nombre de joueurs en attente est nommé (au-delà : seulement le compte). */
export const GOAL_NAMED_PLAYERS_MAX = 2;

/** Clés i18n de repli du nom d'un mécanisme sans `labelKey` (par type). */
export const MECHANISM_FALLBACK_KEYS: Readonly<Record<MechanismDef['type'], string>> = {
  plate: 'mech.plate',
  lever: 'mech.lever',
  key: 'mech.key',
  door: 'mech.door',
  block: 'mech.block',
  socket: 'mech.socket',
  runePuzzle: 'mech.runeSequence',
  brazier: 'goal.mech.brazier',
  statuePair: 'goal.mech.statuePair',
  hourglass: 'goal.mech.hourglass',
  lightBridge: 'goal.mech.lightBridge',
};

/** Nom du mécanisme : son libellé monde COURANT (un brasero allumé s'affiche comme dans la salle : `mechanismLabelKey`). */
function mechanismName(def: MechanismDef | undefined, st?: MechanismState): string {
  if (!def) return t('goal.mech.generic');
  const labelKey = mechanismLabelKey(def, st);
  if (labelKey) return t(labelKey);
  const key = MECHANISM_FALLBACK_KEYS[def.type];
  return key ? t(key) : t('goal.mech.generic');
}

function findMechanismState(state: GameState, id: string): MechanismState | undefined {
  return state.room.mechanisms.find((m) => m.id === id);
}

function characterName(state: GameState, playerId: number): string {
  const p = state.players[playerId];
  return p ? t(CHARACTERS[p.characterId].nameKey) : '';
}

function remainingText(count: number): string {
  return t(count === 1 ? 'goal.remaining.one' : 'goal.remaining.other', { count });
}

/**
 * Ligne « Vaincre … » (jeton `clear`) : tous les ennemis / le boss, avec compteur selon les règles des vagues.
 * Le LIBELLÉ dépend de la définition de la salle (présence d'un boss, d'escortes), pas de l'état instantané du combat :
 * il ne change donc pas quand le boss invoque des renforts ou quand l'escorte tombe.
 */
function clearLine(state: GameState, room: RoomDef): GoalLine {
  const alive = aliveEnemyCount(state);
  const pending = pendingSpawnCount(state, room);
  const remaining = alive + pending;
  // boss / demi-boss et autres ennemis (escortes) vivants ou en attente : ne sert qu'au compteur
  let bosses = 0;
  let others = 0;
  for (const e of state.room.enemies) {
    if (e.dead || e.hp <= 0) continue;
    if (isAnyBossKind(e.kind)) bosses++;
    else others++;
  }
  const spawned = state.room.spawnedSpawnIdx;
  // composition de la salle (définition) : stable pendant tout le combat
  let defBoss = false;
  let defOthers = false;
  room.enemies.forEach((def, i) => {
    if ((def.minPlayers ?? 1) > state.playerCount) return;
    if (isAnyBossKind(def.kind)) defBoss = true;
    else defOthers = true;
    if (spawned.includes(i)) return;
    if (isAnyBossKind(def.kind)) bosses++;
    else others++;
  });
  if (!defBoss) for (const e of state.room.enemies) if (isAnyBossKind(e.kind)) defBoss = true;

  const done = remaining === 0;
  const label = t(!defBoss ? 'goal.clear.all' : defOthers ? 'goal.clear.bossAndMinions' : 'goal.clear.boss');
  // compteur : seulement s'il reste peu d'ennemis OU si plus aucune apparition n'est en attente (on garde la surprise des vagues)
  const showCount = !done && (remaining <= ENEMY_COUNTER_MAX || pending === 0) && !(bosses > 0 && others === 0);
  const detail = showCount ? remainingText(remaining) : '';
  return { id: 'clear', kind: defBoss ? 'boss' : 'clear', label, detail, done, highlight: false };
}

/** Ligne d'un mécanisme exigé (porte/herse/grille : « Ouvrir », autres : « Activer »). */
function mechanismLine(state: GameState, room: RoomDef, ctx: RequirementContext, req: string): GoalLine {
  const def = room.mechanisms.find((m) => m.id === req);
  const st = findMechanismState(state, req);
  const name = mechanismName(def, st);
  const isDoor = def?.type === 'door';
  const done = st ? isMechanismSolved(st) : false;
  let detail = '';
  // « (met/total) » n'a de sens que tant que la porte est fermée (ouverte, elle le reste même si les plaques sont relâchées)
  if (!done && def && def.type === 'door' && def.requires.length > 1) {
    let met = 0;
    for (const r of def.requires) if (isRequirementMet(r, ctx)) met++;
    detail = t('goal.progress', { done: met, total: def.requires.length });
  }
  return {
    id: req,
    kind: isDoor ? 'door' : 'mechanism',
    label: t(isDoor ? 'goal.open' : 'goal.activate', { name }),
    detail,
    done,
    highlight: false,
  };
}

/** Ligne unique « Objectifs personnels accomplis : x/y » pour les objectifs `ids` (nomme ceux qui n'ont pas fini). */
function objectivesLine(state: GameState, ids: readonly string[]): GoalLine {
  let done = 0;
  const waiting: number[] = [];
  for (const id of ids) {
    const st = state.objectives.find((o) => o.id === id);
    if (st?.done) {
      done++;
    } else if (st && !waiting.includes(st.ownerId)) {
      waiting.push(st.ownerId);
    }
  }
  const total = ids.length;
  let detail = '';
  if (done < total && waiting.length > 0) {
    detail =
      waiting.length <= GOAL_NAMED_PLAYERS_MAX
        ? t('goal.objectives.waitingNames', { names: waiting.map((id) => characterName(state, id)).join(', ') })
        : t('goal.objectives.waitingCount', { count: waiting.length });
  }
  return { id: 'objectives', kind: 'objectives', label: t('goal.objectives', { done, total }), detail, done: done >= total, highlight: false };
}

/**
 * Ce qu'il faut faire pour ouvrir la sortie de `room`, ligne par ligne (partagé par tous les joueurs) :
 *  - `clear` → « Vaincre tous les ennemis » (ou « le boss ») + « (N restants) » selon les règles des vagues ;
 *  - id de mécanisme → « Ouvrir : … » (porte, herse, grille ; avec « (met/total) » si elle a plusieurs prérequis)
 *    ou « Activer : … » ;
 *  - `obj:<id>` → UNE ligne « Objectifs personnels accomplis : x/y » (avec les joueurs en attente) ;
 *  - `zone:<id>` / `enter:<zone>` → « Tenir la zone » / « Rejoindre la zone » ;
 *  - tout satisfait → « Sortie ouverte : rejoins-la ! » (mise en évidence) ; aucune exigence → « Rejoins la sortie ».
 * Dans la salle finale, les objectifs personnels de TOUT le niveau sont exigés en plus (comme `isExitOpen`).
 * Ne lève jamais d'exception (jeton inconnu → ligne générique). Au plus `MAX_GOAL_LINES` lignes.
 */
export function describeRoomGoals(state: GameState, level: LevelDef, room: RoomDef): GoalLine[] {
  const requires = room.exit.requires ?? [];
  const ctx = requirementContextFor(state, level, room);
  const lines: GoalLine[] = [];
  const seen = new Set<string>();
  const objIds: string[] = [];
  let objLineAt = -1;
  for (const req of requires) {
    if (seen.has(req)) continue;
    seen.add(req);
    if (req === 'clear') {
      lines.push(clearLine(state, room));
    } else if (req.startsWith('obj:')) {
      const id = req.slice(4);
      if (!objIds.includes(id)) objIds.push(id);
      if (objLineAt < 0) {
        objLineAt = lines.length;
        lines.push({ id: 'objectives', kind: 'objectives', label: '', detail: '', done: false, highlight: false });
      }
    } else if (req.startsWith('zone:')) {
      const owner = state.objectives.find((o) => o.id === req.slice(5));
      const name = owner ? characterName(state, owner.ownerId) : '';
      lines.push({
        id: req,
        kind: 'zone',
        label: name ? t('goal.zone.holdBy', { name }) : t('goal.zone.hold'),
        detail: '',
        done: isRequirementMet(req, ctx),
        highlight: false,
      });
    } else if (req.startsWith('enter:')) {
      lines.push({ id: req, kind: 'enter', label: t('goal.enter'), detail: '', done: isRequirementMet(req, ctx), highlight: false });
    } else {
      lines.push(mechanismLine(state, room, ctx, req));
    }
  }
  // salle finale : tous les objectifs personnels du niveau sont exigés en plus des jetons de sortie
  const finalNeedsObjectives = isFinalRoom(state, level, room) && !allObjectivesDone(state.objectives);
  if (finalNeedsObjectives) {
    for (const o of level.objectives) if (!objIds.includes(o.id)) objIds.push(o.id);
    if (objLineAt < 0 && objIds.length > 0) {
      objLineAt = lines.length;
      lines.push({ id: 'objectives', kind: 'objectives', label: '', detail: '', done: false, highlight: false });
    }
  }
  if (objLineAt >= 0) lines[objLineAt] = objectivesLine(state, objIds);

  const open = computeExitOpen(state, level, room);
  if (open || lines.length === 0) {
    const hasRequirements = requires.length > 0;
    return [
      {
        id: 'exit',
        kind: 'exit',
        label: t(hasRequirements ? 'goal.exit.open' : 'goal.exit.reach'),
        detail: '',
        done: false,
        highlight: hasRequirements,
      },
    ];
  }
  return lines.length > MAX_GOAL_LINES ? lines.slice(0, MAX_GOAL_LINES) : lines;
}

/** Espace insécable (retours à la ligne du HUD). */
const NBSP = String.fromCharCode(0xa0);

/**
 * Texte affiché d'une ligne d'objectif de salle : libellé + complément. Les espaces du complément sont insécables :
 * au retour à la ligne, « (19 restants) » reste d'un bloc au lieu d'être coupé au milieu de la parenthèse.
 */
export function goalLineText(l: Pick<GoalLine, 'label' | 'detail'>): string {
  return l.detail ? `${l.label} ${l.detail.replace(/ /g, NBSP)}` : l.label;
}

// ───────────────────────────── Objectifs personnels ─────────────────────────────

/** Texte à plusieurs lignes d'un objectif personnel : libellé, puis progression, puis salle (objectif d'une salle passée). */
export function objectiveLineText(l: ObjectiveLine): string {
  const parts: string[] = [l.label];
  if (l.done) parts.push(t('hud.done'));
  else {
    if (l.detail) parts.push(l.percent ? `${l.detail} (${l.percent})` : l.detail);
    if (l.where) parts.push(t('hud.objective.inRoom', { room: l.where }));
  }
  return parts.join('\n');
}

/** Bloc des objectifs personnels d'un joueur : en-tête (vide s'il n'y a aucune ligne) + lignes. */
export interface PersonalObjectivesView {
  /** En-tête traduit (« Ton objectif », « Tes objectifs (1/4 accomplis) »), ou '' s'il n'y a aucune ligne à montrer. */
  header: string;
  lines: ObjectiveLine[];
}

/**
 * Objectifs personnels à afficher dans la vue de `playerId`. Pas de ligne ⇒ pas d'en-tête (jamais de fraction orpheline) ;
 * la progression globale n'est écrite, en mots (« 1/4 accomplis »), que si le joueur a plusieurs objectifs sur le niveau.
 */
export function describePersonalObjectives(state: GameState, level: LevelDef, playerId: PlayerId, room: RoomDef): PersonalObjectivesView {
  const lines = visibleObjectives(state, level, playerId, room);
  if (lines.length === 0) return { header: '', lines };
  const totals = objectiveTotals(state, level, playerId);
  // pluriel dès que le joueur a plusieurs objectifs sur le niveau : « Tes objectifs (3/4 accomplis) », jamais « Ton objectif (3/4 accomplis) »
  let header = t(lines.length > 1 || totals.total > 1 ? 'hud.objective.personalMany' : 'hud.objective.personal');
  if (totals.total > 1) header += ` ${t('hud.objective.doneCount', { done: totals.done, total: totals.total })}`;
  return { header, lines };
}

/**
 * Résumé court (une ligne) de l'objectif personnel d'un joueur pour le panneau d'équipe : « ✗ libellé (1/3) », avec « (+n) »
 * s'il y en a d'autres ; « Pas d'objectif perso ici » / « Objectifs perso accomplis » quand il n'y a rien à montrer.
 */
export function teamObjectiveText(state: GameState, level: LevelDef, playerId: PlayerId, room: RoomDef): string {
  const lines = visibleObjectives(state, level, playerId, room);
  const first = lines.find((l) => !l.done) ?? lines[0];
  if (!first) {
    const totals = objectiveTotals(state, level, playerId);
    if (totals.total === 0) return '';
    return t(totals.done >= totals.total ? 'hud.objective.allDone' : 'hud.objective.none');
  }
  let s = `${first.done ? '✓' : '✗'} ${first.label}`;
  if (!first.done) {
    if (first.percent) s += ` ${first.percent}`;
    else if (first.counter) s += ` (${first.counter})`;
  }
  const more = lines.length - 1;
  if (more > 0) s += ` (+${more})`;
  return s;
}
