/**
 * Colle SANS PHASER entre `GameScene` et le tutoriel : choix du partenaire, décoration des entrées (le partenaire scripté est le
 * joueur 1), appareil courant (clavier / manette / PlayStation / tactile) et libellés de boutons, saut. Toute la logique est
 * dans `src/tutorial/` (pur, testé) ; ce module ne fait que relier le directeur aux entrées et à l'appareil, et reste testable
 * sous Node.
 */
import { SIM_STEP_MS } from '../core/constants';
import type { GameSimulation } from '../core/simulation';
import type { ActionFrame, CharacterId, GameState, LevelDef, PlayerId, PlayerSetup, SimEvent, TickInputs } from '../core/types';
import type { Bindings } from '../input/actions';
import { TutorialDirector } from '../tutorial/TutorialDirector';
import { buttonLabels, resolveDevice } from '../tutorial/deviceHints';
import type { ButtonName, DeviceKind, HudRegionId, ScriptedAction, TutorialView } from '../tutorial/types';

/** Durée de vie (ms) des cœurs posés par le tutoriel : longue, pour qu'ils ne disparaissent pas pendant la lecture de la consigne. */
export const TUTORIAL_HEART_TTL_MS = 10 * 60_000;
/** Durée de vie (ms) des objets d'équipement posés par le tutoriel : longue, comme les cœurs. */
export const TUTORIAL_GEAR_TTL_MS = 10 * 60_000;

/**
 * Applique une mise en scène du directeur à la simulation (comme `knockDown`, ENTRE deux pas) : blessure d'un joueur, cœur posé au sol ou rangé d'office, équipement porté ou posé au sol. Partagée par la scène et le harnais de test.
 * Retourne false si la simulation l'a refusée (hors phase 'playing', joueur déjà plus bas…).
 */
export function applyScripted(sim: GameSimulation, a: ScriptedAction): boolean {
  switch (a.k) {
    case 'wound':
      return sim.woundPlayer(a.id, a.fraction);
    case 'equip':
      return sim.equipScripted(a.id, a.item);
    case 'giveHeart':
      return sim.giveScriptedHeart(a.id, a.kind);
    case 'gear':
      return sim.spawnScriptedGear({ x: a.x, y: a.y }, a.item, TUTORIAL_GEAR_TTL_MS);
    default:
      return sim.spawnScriptedHeart({ x: a.x, y: a.y }, a.kind, TUTORIAL_HEART_TTL_MS);
  }
}

/** Ordre de préférence du partenaire scripté : le premier personnage de la famille différent de celui du joueur. */
export const PARTNER_PREFERENCE: readonly CharacterId[] = ['sandrine', 'valentine', 'romain', 'david'];

/** Personnage du partenaire scripté. */
export function pickPartnerCharacter(human: CharacterId): CharacterId {
  return PARTNER_PREFERENCE.find((c) => c !== human) ?? 'sandrine';
}

/** Les 2 joueurs simulés du tutoriel : le joueur (id 0) et le partenaire (id 1), difficulté 1 (facile) pour les deux. */
export function tutorialPlayers(human: PlayerSetup | undefined): PlayerSetup[] {
  const character = human?.characterId ?? 'david';
  return [
    { id: 0 as PlayerId, characterId: character, difficulty: 1 },
    { id: 1 as PlayerId, characterId: pickPartnerCharacter(character), difficulty: 1 },
  ];
}

export interface TutorialRuntimeOptions {
  initialDevice?: DeviceKind;
  startRoomIndex?: number;
}

/** Ce que `GameScene` fournit pour résoudre l'appareil (lu toutes les ~250 ms). */
export interface DeviceProbe {
  label: string;
  gamepadIndex?: number;
  gamepadName?: string;
  virtualPadConnected: boolean;
}

export class TutorialRuntime {
  readonly director: TutorialDirector;
  private device: DeviceKind;
  private keyboardUsed = false;

  constructor(
    readonly level: LevelDef,
    private readonly opts: TutorialRuntimeOptions = {},
  ) {
    this.director = new TutorialDirector(level, { startRoomIndex: opts.startRoomIndex });
    this.device = opts.initialDevice ?? 'keyboard';
  }

  /** Famille d'appareil courante. */
  get currentDevice(): DeviceKind {
    return this.device;
  }

  /** Une touche du clavier a été pressée : le clavier est bien l'appareil utilisé. */
  noteKeyboard(): void {
    this.keyboardUsed = true;
  }

  /** Met à jour la famille d'appareil (rendu seulement : n'influence jamais la simulation). Retourne true si elle a changé. */
  refreshDevice(probe: DeviceProbe): boolean {
    const next = resolveDevice({
      label: probe.label,
      gamepadIndex: probe.gamepadIndex,
      gamepadName: probe.gamepadName,
      virtualPadConnected: probe.virtualPadConnected,
      initialDevice: this.opts.initialDevice,
      keyboardUsed: this.keyboardUsed,
    });
    const changed = next !== this.device;
    this.device = next;
    return changed;
  }

  /** Libellés des boutons pour l'appareil courant (bindings courants au clavier). */
  labels(bindings?: Bindings): Record<ButtonName, string> {
    return buttonLabels(this.device, bindings);
  }

  /** Ajoute les entrées du partenaire scripté (joueur 1) à celles du joueur. À appeler une fois par pas, avant `sim.step`. */
  decorate(inputs: TickInputs, state: GameState): TickInputs {
    const partner: ActionFrame = this.director.partnerFrame(state, SIM_STEP_MS);
    return { ...inputs, 1: partner };
  }

  /** À appeler après chaque `sim.step` (les mises à terre scénarisées sont à appliquer ensuite par la scène). */
  observe(events: readonly SimEvent[], state: GameState, regions: readonly HudRegionId[]): void {
    this.director.observe(events, state, { regions }, SIM_STEP_MS);
  }

  takeKnockDowns(): PlayerId[] {
    return this.director.takeKnockDowns();
  }

  /** Mises en scène du soin à appliquer ensuite par la scène (`applyScripted`). */
  takeScripted(): ScriptedAction[] {
    return this.director.takeScripted();
  }

  view(): TutorialView {
    return this.director.view();
  }

  /** Saute l'étape (ou propose de sauter la salle : la scène relance alors à `roomIndex + 1`). */
  skip(): { kind: 'step' | 'room'; nextRoomIndex: number } {
    const kind = this.director.skipStep();
    return { kind, nextRoomIndex: this.director.roomIndex + 1 };
  }
}
