/**
 * Les 44 étapes du tutoriel (DONNÉES). Chaque étape `do` est validée par une ACTION du joueur ; une étape `tip` se ferme seule.
 * Les textes sont des clés i18n `tutorial.step.<id>` (src/i18n/parts/tutorial.*.json) avec jetons de boutons résolus par appareil
 * (`deviceHints.ts`). Les conditions de réussite sont fondées sur l'ÉTAT quand c'est possible (pas seulement sur un événement) :
 * un joueur qui a déjà accompli l'action avant que l'étape ne s'affiche n'est jamais bloqué.
 *
 * Couverture : déplacement, panneaux, bloc « Objectifs de la salle » (haut à droite), « Ton objectif » (haut à gauche), attaque,
 * cœurs, spécial et recharge, ennemis restants, levier, plaques, porte, objectif d'équipe, bloc poussable, clé et porte de couleur,
 * torche et braseros (salle sombre), RELEVAGE, EMPLACEMENT CŒUR (ranger, se soigner avec B, soigner un coéquipier blessé, emplacement entier = appel automatique),
 * APPELS AUTOMATIQUES (cœur qu'on ne peut pas ranger, objet moins puissant laissé, échange d'accessoire, croix rouge = demande de soins, page récapitulative de toutes les règles), APPEL (recevoir puis lancer),
 * mort d'équipe, sortie scellée.
 */
import type { PartnerOp, TutorialStepDef } from './types';

const goExit: PartnerOp[] = [{ op: 'goExit' }];

/** Raccourci : texte `tutorial.step.<id>`. */
function step(def: Omit<TutorialStepDef, 'textKey'>): TutorialStepDef {
  return { ...def, textKey: `tutorial.step.${def.id}` };
}

export const TUTORIAL_STEPS: readonly TutorialStepDef[] = [
  // ───────── t_yard : déplacement, panneau, objectifs à l'écran, combat, spécial ─────────
  step({ id: 'welcome', room: 't_yard', kind: 'tip', minMs: 9000, buttons: ['skip', 'pause'] }),
  step({ id: 'move', room: 't_yard', kind: 'do', minMs: 600, done: { k: 'moved', px: 64 }, buttons: ['move'] }),
  step({
    id: 'sign',
    room: 't_yard',
    kind: 'do',
    minMs: 1200,
    done: { k: 'nearSign', id: 's_yard', ms: 1500 },
    markers: [{ sign: 's_yard' }],
    highlights: ['sign'],
  }),
  step({
    id: 'roomGoals',
    room: 't_yard',
    kind: 'tip',
    minMs: 11000,
    gate: { k: 'regionVisible', id: 'roomGoals' },
    highlights: ['roomGoals'],
  }),
  step({
    id: 'attack',
    room: 't_yard',
    kind: 'do',
    minMs: 800,
    done: { k: 'any', of: [{ k: 'event', type: 'enemyDied', by: 0 }, { k: 'enemiesGone' }] },
    buttons: ['attack'],
    markers: [{ nearestEnemy: true }],
  }),
  step({
    id: 'personalGoal',
    room: 't_yard',
    kind: 'do',
    minMs: 3500,
    done: { k: 'objective', id: 'o_kills' },
    highlights: ['personalGoal'],
  }),
  step({ id: 'hearts', room: 't_yard', kind: 'tip', minMs: 8000, highlights: ['hearts'] }),
  step({
    id: 'special',
    room: 't_yard',
    kind: 'do',
    minMs: 800,
    done: { k: 'event', type: 'specialUsed', by: 0 },
    buttons: ['special'],
    highlights: ['special'],
  }),
  step({ id: 'specialRecharge', room: 't_yard', kind: 'tip', minMs: 7000, highlights: ['special'] }),
  step({
    id: 'clearYard',
    room: 't_yard',
    kind: 'do',
    minMs: 1200,
    done: { k: 'enemiesGone' },
    highlights: ['roomGoals'],
    markers: [{ nearestEnemy: true }],
  }),
  step({
    id: 'exit.yard',
    room: 't_yard',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    highlights: ['roomGoals'],
    partner: goExit,
  }),

  // ───────── t_workshop : levier, plaques, porte, objectif d'équipe ─────────
  step({
    id: 'lever',
    room: 't_workshop',
    kind: 'do',
    prerequisite: true, // ouvre la herse : sans elle, la plaque A (derrière) est inaccessible
    minMs: 1200,
    done: { k: 'req', token: 'lv' },
    buttons: ['interact'],
    markers: [{ mech: 'lv' }],
    highlights: ['prompt'],
  }),
  step({
    id: 'plates',
    room: 't_workshop',
    kind: 'do',
    minMs: 1200,
    done: { k: 'req', token: 'd_plates' },
    markers: [{ mech: 'pA' }],
    highlights: ['roomGoals'],
    partner: [{ op: 'stand', at: { mech: 'pB' }, until: { k: 'req', token: 'd_plates' }, essential: true }],
  }),
  step({
    id: 'teamGoal',
    room: 't_workshop',
    kind: 'do',
    minMs: 3000,
    done: { k: 'objective', id: 'o_lever' },
    markers: [{ mech: 'lv1' }],
    highlights: ['roomGoals'],
    partner: [
      { op: 'walk', at: { mech: 'lv1' }, essential: true },
      { op: 'press', button: 'interact', essential: true },
    ],
  }),
  step({
    id: 'exit.workshop',
    room: 't_workshop',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_vault : bloc poussable, clé et porte de couleur ─────────
  step({
    id: 'block',
    room: 't_vault',
    kind: 'do',
    prerequisite: true, // ouvre la porte du socle : sans elle, la clé est inaccessible
    minMs: 1500,
    done: { k: 'req', token: 'so' },
    stuckWhen: { k: 'blockDead', id: 'b' }, // bloc collé à une paroi : irrécupérable, on propose tout de suite la salle suivante
    markers: [{ mech: 'b' }, { mech: 'so' }],
  }),
  step({
    id: 'keyPick',
    room: 't_vault',
    kind: 'do',
    minMs: 1200,
    done: { k: 'any', of: [{ k: 'holdsKey' }, { k: 'req', token: 'kd' }] },
    markers: [{ mech: 'k0' }],
    highlights: ['keys'],
  }),
  step({
    id: 'keyDoor',
    room: 't_vault',
    kind: 'do',
    noCompact: true,
    minMs: 1200,
    done: { k: 'all', of: [{ k: 'req', token: 'kd' }, { k: 'objective', id: 'o_key' }] },
    buttons: ['interact'],
    markers: [{ mech: 'kd' }],
    highlights: ['prompt'],
  }),
  step({
    id: 'exit.vault',
    room: 't_vault',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_dark : torche et braseros ─────────
  step({ id: 'darkIntro', room: 't_dark', kind: 'tip', minMs: 6500, highlights: ['torch'] }),
  step({
    id: 'refuel',
    room: 't_dark',
    kind: 'do',
    minMs: 1200,
    gate: { k: 'torchUsed' },
    done: { k: 'event', type: 'torchRefueled', by: 0 },
    buttons: ['interact'],
    markers: [{ mech: 'br_a' }],
    highlights: ['torch', 'prompt'],
  }),
  step({
    id: 'lightBrazier',
    room: 't_dark',
    kind: 'do',
    minMs: 1200,
    done: { k: 'req', token: 'br_b' },
    buttons: ['interact'],
    markers: [{ mech: 'br_b' }],
    highlights: ['roomGoals'],
  }),
  step({
    id: 'exit.dark',
    room: 't_dark',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_revive : RELEVAGE ─────────
  step({
    id: 'revive',
    room: 't_revive',
    kind: 'do',
    minMs: 1500,
    done: { k: 'event', type: 'playerRevived', match: { playerId: 1, reviverId: 0 } },
    buttons: ['action'],
    noCompact: true, // « maintiens ~3 s, sinon ça recommence » doit rester lisible jusqu'au bout
    markers: [{ partner: true }],
    highlights: ['prompt'],
    knockDown: { afterMs: 1200, ids: [1] },
  }),
  step({
    id: 'exit.revive',
    room: 't_revive',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    // la herse de sortie ne s'ouvre que par le levier du partenaire : relevé, il va le tirer puis rejoint la sortie
    partner: [{ op: 'walk', at: { mech: 'lv_r' }, essential: true }, { op: 'press', button: 'interact', essential: true }, ...goExit],
  }),

  // ───────── t_heart : EMPLACEMENT CŒUR (ranger et FUSIONNER deux demi-cœurs, B sur soi, B sur un coéquipier blessé, emplacement plein = appel automatique) ─────────
  step({
    id: 'heartStore',
    room: 't_heart',
    kind: 'do',
    minMs: 2500,
    // deux DEMI-cœurs au sol : le premier est rangé, le second FUSIONNE (`merged`) : l'emplacement tient alors un cœur entier (10 PV, de quoi enchaîner sur `heartSelf`). Aucun reste au sol.
    // Validée par DEUX rangements du joueur (le second est la fusion) et non par `merged` seul : un appui sur B entre les deux (joueur blessé, bordure « prêt ») consomme le premier demi-cœur,
    // le second est alors simplement rangé (pas de fusion) et l'étape ne doit pas rester bloquée ; l'emplacement tient dans les deux cas un cœur (gate de `heartSelf`).
    done: { k: 'event', type: 'heartStored', by: 0, count: 2 },
    markers: [{ tile: [8, 6] }, { tile: [12, 6] }],
    highlights: ['heartSlot'],
    script: {
      afterMs: 0,
      hearts: [
        { tile: [8, 6], kind: 'half' },
        { tile: [12, 6], kind: 'half' },
      ],
    },
  }),
  step({
    id: 'heartSelf',
    room: 't_heart',
    kind: 'do',
    minMs: 1500,
    // la blessure n'est mise en scène que quand le joueur tient un cœur (porte ouverte) : jamais de blessure sans de quoi se soigner
    gate: { k: 'holdsHeart' },
    done: { k: 'event', type: 'heartUsed', by: 0, match: { targetId: 0 } },
    buttons: ['heart'],
    noCompact: true, // « jamais tout seul, c'est toi qui décides » doit rester lisible
    highlights: ['heartSlot'],
    script: { afterMs: 0, wound: [{ id: 0, fraction: 0.5 }] },
  }),
  step({
    id: 'heartAlly',
    room: 't_heart',
    kind: 'do',
    minMs: 2000,
    done: { k: 'event', type: 'heartUsed', by: 0, match: { targetId: 1 } },
    buttons: ['heart'],
    noCompact: true, // priorité allié blessé > soi : à garder sous les yeux
    markers: [{ partner: true }, { tile: [12, 6] }],
    highlights: ['heartSlot'],
    script: { afterMs: 0, wound: [{ id: 1, fraction: 0.4 }], hearts: [{ tile: [12, 6], kind: 'full' }] },
  }),
  step({
    id: 'heartFull',
    room: 't_heart',
    kind: 'do',
    minMs: 2500,
    // validée quand l appel automatique est parti ET que le partenaire a pris le cœur resté au sol (il vient de lui-même : l appel a un effet visible)
    // (l'appel doit porter le symbole du CŒUR ENTIER : une croix rouge du joueur, blessé en arrivant, ne doit pas la valider à tort)
    // Cœurs ENTIERS : avec la fusion, deux demi-cœurs ne refuseraient rien (demi + demi = entier) ; un cœur entier rangé en premier remplit l'emplacement, le suivant est refusé quel que soit l'ordre.
    // TROIS cœurs : un appui sur B entre le premier et le suivant (joueur encore blessé) consomme le premier ; le troisième garantit alors le refus (et l'appel) sans bloquer l'étape.
    done: { k: 'all', of: [{ k: 'event', type: 'autoCallStarted', by: 0, match: { icon: 'heart' } }, { k: 'event', type: 'heartStored', by: 1 }] },
    noCompact: true,
    markers: [{ tile: [8, 6] }, { tile: [12, 6] }],
    highlights: ['heartSlot'],
    script: {
      afterMs: 0,
      hearts: [
        { tile: [8, 6], kind: 'full' },
        { tile: [10, 6], kind: 'full' },
        { tile: [12, 6], kind: 'full' },
      ],
    },
    // l'appel automatique du joueur prévient le partenaire (emplacement libre) : il vient ramasser le cœur resté au sol
    partner: [{ op: 'idle', until: { k: 'event', type: 'autoCallStarted', by: 0, match: { icon: 'heart' } } }, { op: 'walk', at: { pickup: true } }],
  }),
  step({
    id: 'exit.heart',
    room: 't_heart',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_gear : OBJETS LAISSÉS (équipement moins puissant, échange d'accessoire) : appel automatique avec le symbole de l'objet ─────────
  step({
    id: 'gearLeft',
    room: 't_gear',
    kind: 'do',
    minMs: 2500,
    // validée quand l'appel automatique est parti (symbole de l'objet) ET que le partenaire, qui n'a rien à cet emplacement, est venu prendre l'objet resté au sol
    done: {
      k: 'all',
      of: [
        { k: 'event', type: 'autoCallStarted', by: 0, match: { icon: 'gear' } },
        { k: 'event', type: 'gearPicked', by: 1 },
      ],
    },
    noCompact: true,
    markers: [{ tile: [9, 6] }],
    highlights: ['gear'],
    // le joueur porte une protection de niveau II (de quoi refuser une protection de niveau I) ; au sol, une protection de niveau I
    script: { afterMs: 0, equip: [{ id: 0, item: { slot: 'protection', level: 2 } }], gear: [{ tile: [9, 6], item: { slot: 'protection', level: 1 } }] },
    partner: [{ op: 'idle', until: { k: 'event', type: 'autoCallStarted', by: 0 } }, { op: 'walk', at: { gear: true } }],
  }),
  step({
    id: 'gearSwap',
    room: 't_gear',
    kind: 'do',
    minMs: 2500,
    // échange manuel (A) : le nouvel accessoire est équipé, l'ancien est posé aux pieds, l'appel part avec son symbole, le partenaire (sans accessoire) vient le prendre
    done: {
      k: 'all',
      of: [
        { k: 'event', type: 'gearSwapped', by: 0 },
        { k: 'event', type: 'autoCallStarted', by: 0, match: { icon: 'gear' } },
        { k: 'event', type: 'gearPicked', by: 1 },
      ],
    },
    buttons: ['interact'],
    noCompact: true, // « l'ancien est posé à tes pieds, l'appel part » doit rester lisible
    markers: [{ tile: [15, 6] }],
    highlights: ['gear', 'prompt'],
    script: {
      afterMs: 0,
      equip: [{ id: 0, item: { slot: 'accessory', level: 1, accessory: 'lantern' } }],
      gear: [{ tile: [15, 6], item: { slot: 'accessory', level: 1, accessory: 'magnet' } }],
    },
    partner: [{ op: 'idle', until: { k: 'event', type: 'autoCallStarted', by: 0 } }, { op: 'walk', at: { gear: true } }],
  }),
  step({
    id: 'exit.gear',
    room: 't_gear',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_cross : CROIX ROUGE = demande de soins (PV à 30 % ou moins), qui peut soigner ─────────
  step({
    id: 'crossCall',
    room: 't_cross',
    kind: 'do',
    minMs: 3000,
    // validée quand la croix rouge est partie du partenaire (sous 30 % de ses PV, hors de la vue) ET que le joueur l'a soigné avec son cœur rangé
    done: {
      k: 'all',
      of: [
        { k: 'event', type: 'autoCallStarted', by: 1, match: { icon: 'cross' } },
        { k: 'event', type: 'heartUsed', by: 0, match: { targetId: 1 } },
      ],
    },
    buttons: ['heart'],
    noCompact: true, // qui peut soigner et comment doit rester sous les yeux
    markers: [{ partner: true }],
    highlights: ['heartSlot'],
    // un cœur est rangé d'office (de quoi soigner : sans cœur ni Valentine, personne ne verrait la croix) et le partenaire tombe à 20 % de ses PV ; `keepHeart` : un appui prématuré sur B (le joueur est
    // blessé depuis la salle précédente, loin du partenaire : le cœur serait consommé sur lui) ne bloque pas l'étape, le cœur est redonné tant que le partenaire n'est pas soigné
    script: { afterMs: 0, giveHeart: [{ id: 0, kind: 'full' }], keepHeart: true, wound: [{ id: 1, fraction: 0.2 }] },
  }),
  step({ id: 'crossWho', room: 't_cross', kind: 'tip', minMs: 22000, highlights: ['heartSlot'] }),
  step({
    id: 'exit.cross',
    room: 't_cross',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_call : APPEL (recevoir, puis lancer), puis RÉCAPITULATIF des appels automatiques ─────────
  step({
    id: 'callReceive',
    room: 't_call',
    kind: 'do',
    minMs: 2500,
    done: { k: 'near', tiles: 6 },
    edgeToPartner: true,
    partner: [{ op: 'callEvery', ms: 5200, until: { k: 'near', tiles: 6 } }],
  }),
  step({
    id: 'callSend',
    room: 't_call',
    kind: 'do',
    minMs: 800,
    gate: { k: 'far', tiles: 16 },
    done: { k: 'event', type: 'callStarted', by: 0 },
    buttons: ['call'],
    noCompact: true, // durées (1 s immobile, signal 3 s, rappel 5 s) à garder sous les yeux
    partner: [
      { op: 'walk', at: { tile: [10, 6] } },
      { op: 'idle', until: { k: 'event', type: 'callStarted', by: 0 } },
      { op: 'walk', at: { human: true } },
    ],
  }),
  // récapitulatif : TOUTES les règles de l'appel automatique, en deux pages de lecture (les étapes précédentes les ont fait vivre une à une)
  // (durées de lecture ≈ 20 caractères / s : le texte est long, mieux vaut lentement que trop vite)
  step({ id: 'autoCallRecap1', room: 't_call', kind: 'tip', minMs: 28000 }),
  step({ id: 'autoCallRecap2', room: 't_call', kind: 'tip', minMs: 33000 }),
  step({
    id: 'exit.call',
    room: 't_call',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomCleared' },
    markers: [{ exit: true }],
    partner: goExit,
  }),

  // ───────── t_seal : mort d'équipe, objectifs, sortie scellée ─────────
  step({
    id: 'wipe',
    room: 't_seal',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'roomEntered', match: { reason: 'restart' } },
    knockDown: { afterMs: 4000, ids: [0, 1] },
  }),
  step({
    id: 'finalGoals',
    room: 't_seal',
    kind: 'do',
    minMs: 2500,
    done: { k: 'exitOpen' },
    highlights: ['roomGoals', 'personalGoal'],
    partner: [{ op: 'stand', at: { zone: 'z_seal' }, until: { k: 'objective', id: 'o_zone' }, essential: true }],
  }),
  step({
    id: 'exit.final',
    room: 't_seal',
    kind: 'do',
    minMs: 0,
    done: { k: 'event', type: 'levelCompleted' },
    markers: [{ exit: true }],
    highlights: ['roomGoals'],
    partner: goExit,
  }),
];

/** Indice de la première étape de la salle `roomId`, ou -1. */
export function firstStepIndexOfRoom(roomId: string): number {
  return TUTORIAL_STEPS.findIndex((s) => s.room === roomId);
}

/** Les étapes de sortie (`exit.*`) : les sauter revient à sauter la salle (la sortie dépend de toute la salle). */
export function isExitStep(def: TutorialStepDef): boolean {
  return def.id.startsWith('exit.');
}
