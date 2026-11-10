/**
 * Intégration headless du tutoriel : un « humain » scripté joue tout le tutoriel avec la même boucle que `GameScene`
 * (partenaire scripté + directeur + `knockDown`). Voir `tutorial.solution.ts`.
 */
import { describe, expect, it } from 'vitest';
import { saveContextFromLevels } from '../core/save';
import { MemorySaveRepository } from '../core/saveRepository';
import { LEVELS } from '../levels';
import { SIM_STEP_MS } from '../core/constants';
import { TUTORIAL_STEPS } from '../tutorial/steps';
import { tutorialLevel } from '../levels/tutorial';
import type { ActionFrame, GameState, GearItem } from '../core/types';
import { TutorialRun, type HumanStrategy } from './tutorial.solution';

const MAX_MS = 10 * 60_000;
const T = 60_000;

function expectCompleted(run: TutorialRun, ms: number): void {
  expect(run.done, `étape bloquée : ${run.director.step.id} (salle ${run.state.roomIndex}) après ${(ms / 1000).toFixed(0)} s`).toBe(true);
  expect(run.state.phase === 'levelComplete' || run.director.finished).toBe(true);
}

describe('tutoriel : terminable de bout en bout', () => {
  it('humain scripté : toutes les étapes `do` validées, en moins de 10 min simulées', () => {
    const run = new TutorialRun();
    const ms = run.run(MAX_MS);
    expectCompleted(run, ms);
    const done = new Set(run.director.snapshot().done);
    for (const s of TUTORIAL_STEPS) if (s.kind === 'do' && s.id !== 'exit.final') expect(done.has(s.id), `étape ${s.id}`).toBe(true);
    expect(run.skips).toBe(0);
    expect(run.state.objectives.every((o) => o.done)).toBe(true);
    expect(run.state.clearedRooms).toEqual(tutorialLevel.rooms.map((r) => r.id));
    console.info(`[tutoriel] ${TUTORIAL_STEPS.length} étapes, terminé en ${(ms / 1000).toFixed(0)} s simulées`);
  }, T);

  it('personnage différent (partenaire choisi en conséquence) : terminé aussi', () => {
    const run = new TutorialRun({ human: 'sandrine', partner: 'valentine' });
    expectCompleted(run, run.run(MAX_MS));
  }, T);

  it('Romain joué (trait « parle beaucoup » : appels sans attente, croix toutes les 3 s) : terminé aussi, sans étape bloquée', () => {
    const run = new TutorialRun({ human: 'romain', partner: 'sandrine' });
    expectCompleted(run, run.run(MAX_MS));
    expect(run.state.players[0].characterId).toBe('romain');
    expect(run.state.players[0].callCooldownMs).toBe(0);
  }, T);

  it('variante « tout passer » : le tutoriel est ENTIÈREMENT saute-able (étapes puis salles), sans jamais bloquer', () => {
    // Comme GameScene : « Passer » saute l'étape ; sur une étape de sortie (ou après 45 s sans progrès) la scène relance à la salle suivante.
    let room = 0;
    let restarts = 0;
    while (room < tutorialLevel.rooms.length) {
      const run = new TutorialRun({ startRoomIndex: room, strategy: 'idle' });
      let skippedRoom = false;
      for (let i = 0; i < 60 * 600 && !run.done; i++) {
        if (run.director.skipKind() === 'room') {
          skippedRoom = true;
          break;
        }
        run.director.skipStep();
        run.tick();
      }
      expect(run.done || skippedRoom, `salle ${room} : ni terminée ni saute-able`).toBe(true);
      if (run.done) break;
      room = run.director.roomIndex + 1; // GameScene : startRoomIndex = roomIndex + 1 (au-delà de la dernière : carte de fin)
      restarts++;
    }
    expect(room).toBeGreaterThanOrEqual(tutorialLevel.rooms.length - 1);
    expect(restarts).toBeGreaterThanOrEqual(tutorialLevel.rooms.length - 1);
  }, T);

  it('variante « tout passer » avec un humain qui joue : les étapes sautées ne bloquent jamais le partenaire', () => {
    const run = new TutorialRun({ skipAll: true });
    const ms = run.run(MAX_MS);
    expect(run.skips).toBeGreaterThan(5);
    expect(ms).toBeGreaterThan(0);
  }, T);

  it('variante « mort d équipe réelle » : le tutoriel reprend et se termine', () => {
    const run = new TutorialRun({ dieAtMs: 20_000 });
    const ms = run.run(MAX_MS);
    expectCompleted(run, ms);
    expect(run.events.some((e) => e.type === 'teamWipe')).toBe(true);
  }, T);

  it('variante « humain inactif » : aucune étape `do` validée à tort, l astuce « bloqué » apparaît', () => {
    const run = new TutorialRun({ strategy: 'idle' });
    run.run(120_000);
    const done = run.director.snapshot().done;
    expect(done).toContain('welcome');
    expect(done).not.toContain('move');
    expect(run.director.view().stuck).toBe(true);
    expect(run.director.view().skipKind).toBe('room');
  }, T);
});

describe('tutoriel : le relevage est incontournable', () => {
  it('un humain qui fonce vers la sortie pendant que le partenaire est à terre ne termine PAS la salle (herse fermée), relevage non validé', () => {
    const run = new TutorialRun({ startRoomIndex: 4, strategy: 'rush' });
    run.run(60_000);
    expect(run.state.roomIndex).toBe(4);
    expect(run.state.players[1].status).toBe('down');
    expect(run.director.snapshot().done).not.toContain('revive');
    expect(run.director.view().stepId).toBe('revive');
  }, T);

  it('après le relevage, le partenaire tire le levier de la herse puis rejoint la sortie : la salle se termine', () => {
    const run = new TutorialRun({ startRoomIndex: 4, strategy: 'solver' });
    for (let i = 0; i < 60 * 90 && run.state.roomIndex === 4; i++) run.tick();
    expect(run.state.roomIndex).toBe(5);
    expect(run.events.some((e) => e.type === 'playerRevived' && e.playerId === 1 && e.reviverId === 0)).toBe(true);
    expect(run.director.snapshot().done).toContain('revive');
  }, T);
});

describe('tutoriel : déterminisme et absence de sauvegarde', () => {
  it('deux exécutions identiques donnent le même serialize() et le même snapshot() du directeur', () => {
    const a = new TutorialRun({ seed: 5 });
    const b = new TutorialRun({ seed: 5 });
    for (let i = 0; i < 6000; i++) {
      a.tick();
      b.tick();
    }
    expect(a.sim.serialize()).toBe(b.sim.serialize());
    expect(JSON.stringify(a.director.snapshot())).toBe(JSON.stringify(b.director.snapshot()));
    expect(a.sim.state.timeMs).toBeCloseTo(6000 * SIM_STEP_MS, 3);
  });

  it('ne touche jamais au dépôt de sauvegarde', () => {
    const repo = new MemorySaveRepository(saveContextFromLevels(LEVELS), { raw: null });
    const run = new TutorialRun(); // la boucle du tutoriel n'a AUCUN accès au dépôt (GameScene ne construit pas d'AutoSaver)
    run.run(MAX_MS);
    expect(repo.writes).toBe(0);
    expect(repo.clears).toBe(0);
    expect(repo.raw).toBeNull();
  });
});

describe('tutoriel : partenaire', () => {
  const strategies: HumanStrategy[] = ['idle', 'rush', 'hitAndRun', 'spamSpecial'];
  it('ne perd jamais un PV dans la cour (20 graines × 4 stratégies)', () => {
    for (const strategy of strategies) {
      for (let seed = 1; seed <= 20; seed++) {
        const run = new TutorialRun({ seed, strategy });
        for (let i = 0; i < 60 * 40 && run.state.roomIndex === 0; i++) run.tick();
        expect(run.partnerMinHp, `stratégie ${strategy}, graine ${seed}`).toBe(run.state.players[1].maxHp);
      }
    }
  }, T);
});

describe('tutoriel : emplacement cœur', () => {
  it('le parcours complet range puis FUSIONNE deux demi-cœurs, se soigne avec B, soigne le partenaire blessé et déclenche l appel automatique de cœur', () => {
    const run = new TutorialRun();
    run.run(MAX_MS);
    expect(run.done).toBe(true);
    const ev = run.events;
    // rangement d'un demi-cœur, puis FUSION du second (cœur entier : de quoi se soigner de 10 PV)
    const stored = ev.filter((e) => e.type === 'heartStored' && e.playerId === 0);
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(stored.some((e) => e.type === 'heartStored' && e.merged === true)).toBe(true);
    // B sur soi (blessure scénarisée) puis B sur le coéquipier blessé : jamais consommé au contact
    const used = ev.filter((e) => e.type === 'heartUsed');
    expect(used.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 0)).toBe(true);
    expect(used.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 1)).toBe(true);
    expect(ev.some((e) => e.type === 'pickupCollected')).toBe(false);
    // emplacement ENTIER : appel automatique avec le symbole du cœur entier vers le partenaire, qui prend ensuite le cœur resté au sol
    const calls = ev.filter((e) => e.type === 'autoCallStarted');
    expect(calls.some((e) => e.type === 'autoCallStarted' && e.playerId === 0 && e.icon === 'heart' && e.to.includes(1))).toBe(true);
    expect(ev.some((e) => e.type === 'heartStored' && e.playerId === 1)).toBe(true);
    const done = new Set(run.director.snapshot().done);
    for (const id of ['heartStore', 'heartSelf', 'heartAlly', 'heartFull', 'exit.heart']) expect(done.has(id), id).toBe(true);
  }, T);

  it('la simulation du tutoriel a l emplacement cœur actif, l appel automatique actif et aucun butin aléatoire', () => {
    const run = new TutorialRun();
    expect(run.state.heartSlot).toBe(true);
    expect(run.state.autoCallDisabled).toBeUndefined();
    expect(run.state.lootEnabled).toBe(false);
  });

  it('le joueur ne se soigne jamais tout seul : sans appuyer sur B, ses PV restent ceux de la blessure scénarisée', () => {
    const run = new TutorialRun({ startRoomIndex: 5 });
    // l humain scripté joue la salle ; on vérifie qu aucun PV n est jamais rendu sans événement heartUsed
    let last = run.state.players[0].hp;
    let unexplained = 0;
    for (let i = 0; i < 60 * 60 && run.state.roomIndex === 5; i++) {
      const before = last;
      const nEv = run.events.length;
      run.tick();
      const used = run.events.slice(nEv).some((e) => e.type === 'heartUsed' && e.targetId === 0);
      if (run.state.players[0].hp > before && !used) unexplained++;
      last = run.state.players[0].hp;
    }
    expect(unexplained).toBe(0);
  }, T);
});

describe('tutoriel : appels automatiques (objet laissé, échange d accessoire, croix rouge, récapitulatif)', () => {
  it('le parcours complet : appel de l objet moins puissant, échange avec appel de l ANCIEN accessoire, croix rouge du partenaire soigné, toutes les nouvelles étapes validées', () => {
    const run = new TutorialRun();
    let swapCallItem: GearItem | undefined;
    let sawSwap = false;
    while (!run.done && run.sim.state.timeMs < MAX_MS) {
      const n = run.events.length;
      run.tick();
      for (const e of run.events.slice(n)) {
        if (e.type === 'gearSwapped') sawSwap = true;
        if (e.type === 'autoCallStarted' && e.playerId === 0 && e.icon === 'gear' && sawSwap && !swapCallItem) swapCallItem = run.state.players[0].autoCall?.item;
      }
    }
    expect(run.done).toBe(true);
    const ev = run.events;
    // 1. équipement refusé (moins puissant) : appel avec le symbole de l'objet, le partenaire le prend
    const gearCalls = ev.filter((e) => e.type === 'autoCallStarted' && e.playerId === 0 && e.icon === 'gear');
    expect(gearCalls.length).toBe(2); // objet refusé + ancien accessoire de l'échange
    expect(gearCalls.every((e) => e.type === 'autoCallStarted' && e.to.length === 1 && e.to[0] === 1)).toBe(true);
    const picked = ev.filter((e) => e.type === 'gearPicked' && e.playerId === 1);
    expect(picked.length).toBe(2);
    // 2. échange manuel : le nouvel accessoire (aimant) est équipé, l'ancien (lanterne) est posé et SIGNALÉ avec son icône
    const swap = ev.find((e) => e.type === 'gearSwapped');
    expect(swap).toMatchObject({ type: 'gearSwapped', playerId: 0, item: { slot: 'accessory', accessory: 'magnet' }, dropped: { slot: 'accessory', accessory: 'lantern' } });
    expect(swapCallItem).toEqual({ slot: 'accessory', level: 1, accessory: 'lantern' });
    // 3. croix rouge : le partenaire blessé sous 30 % la lance, le joueur (cœur rangé d'office) la reçoit et le soigne
    const crossCalls = ev.filter((e) => e.type === 'autoCallStarted' && e.icon === 'cross');
    expect(crossCalls.length).toBeGreaterThanOrEqual(1);
    expect(crossCalls.every((e) => e.type === 'autoCallStarted' && e.playerId === 1 && e.to.includes(0))).toBe(true);
    expect(ev.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 1)).toBe(true);
    const done = new Set(run.director.snapshot().done);
    for (const id of ['gearLeft', 'gearSwap', 'exit.gear', 'crossCall', 'crossWho', 'exit.cross', 'autoCallRecap1', 'autoCallRecap2', 'exit.call']) expect(done.has(id), id).toBe(true);
  }, T);

  it('équipement actif dans le tutoriel, mais AUCUN tirage parasite : pas de butin d équipement ni de vie aléatoire, flux gearRngState et lootRngState inchangés, seuls les objets posés par script existent', () => {
    const run = new TutorialRun();
    expect(run.state.gearEnabled).toBe(true);
    expect(run.state.gearDropsDisabled).toBe(true);
    expect(run.state.lootEnabled).toBe(false);
    const gear0 = run.state.gearRngState;
    const loot0 = run.state.lootRngState;
    run.run(MAX_MS);
    expect(run.done).toBe(true);
    expect(run.state.gearRngState).toBe(gear0);
    expect(run.state.lootRngState).toBe(loot0);
    expect(run.events.some((e) => e.type === 'buffDropped')).toBe(false);
    // objets d'équipement posés : la protection I, l'aimant à échanger et la lanterne posée par l'échange (+ éventuel éparpillement de la démonstration de mort d'équipe : `scattered`)
    const dropped = run.events.filter((e) => e.type === 'gearDropped' && !e.scattered);
    expect(dropped.length).toBe(3);
  }, T);

  it('humain inactif dans l armurerie : aucun appel, le partenaire ne prend rien tout seul (il attend l appel), les objets restent au sol', () => {
    const run = new TutorialRun({ startRoomIndex: 6, strategy: 'idle' });
    run.run(60_000);
    expect(run.events.some((e) => e.type === 'autoCallStarted')).toBe(false);
    expect(run.events.some((e) => e.type === 'gearPicked')).toBe(false);
    expect(run.state.room.gearDrops?.length).toBe(1); // protection I posée à l'étape gearLeft
    expect(run.director.view().stepId).toBe('gearLeft');
  }, T);

  it('humain inactif au poste de soins : la croix part dès que le partenaire est blessé (le joueur a un cœur rangé), et se RÉPÈTE toutes les 10 s tant qu il n est pas soigné', () => {
    const run = new TutorialRun({ startRoomIndex: 7, strategy: 'idle' });
    run.run(35_000);
    const crosses = run.events.filter((e) => e.type === 'autoCallStarted' && e.icon === 'cross');
    expect(crosses.length).toBeGreaterThanOrEqual(3);
    expect(crosses.length).toBeLessThanOrEqual(4);
    expect(run.state.players[0].heart).toBe('full');
    const p1 = run.state.players[1];
    expect(p1.hp).toBeLessThanOrEqual(p1.maxHp * 0.3);
    expect(run.director.snapshot().done).not.toContain('crossCall');
  }, T);

  it("B PRÉMATURÉ au poste de soins (joueur blessé, loin du partenaire, cœur consommé sur soi) : le cœur est redonné, l'étape n'est jamais bloquée et le solveur soigne ensuite le partenaire", () => {
    const run = new TutorialRun({ startRoomIndex: 7, strategy: 'idle', pressHeartEveryMs: 400 });
    // le joueur arrive blessé (comme après la salle du cœur) : B se rabat sur lui-même (aucun allié à portée)
    run.state.players[0].hp = Math.floor(run.state.players[0].maxHp * 0.5);
    run.run(8_000);
    const selfUses = run.events.filter((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 0);
    expect(selfUses.length).toBeGreaterThanOrEqual(2); // le cœur a été gaspillé sur soi PUIS redonné (sans `keepHeart` : un seul usage et plus rien)
    expect(run.director.step.id).toBe('crossCall'); // étape toujours en cours
    // sans l'appui répété : le joueur a un cœur à redonner tant que le partenaire n'est pas soigné
    const p0 = run.state.players[0];
    expect(p0.hp).toBeGreaterThan(Math.floor(p0.maxHp * 0.5));
    // finalement, un joueur qui joue bien (solveur) termine l'étape depuis cet état
    const solver = new TutorialRun({ startRoomIndex: 7 });
    solver.state.players[0].hp = Math.floor(solver.state.players[0].maxHp * 0.5);
    solver.run(3 * 60_000);
    expect(solver.events.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 1)).toBe(true);
    expect(solver.director.snapshot().done).toContain('crossCall');
  }, T);

  /** Joueur blessé qui appuie UNE fois sur B (soin de soi) dès que son emplacement tient quelque chose pendant `stepId` : le solveur continue ensuite normalement. */
  function runWithOneEarlyB(stepId: string): TutorialRun {
    const run = new TutorialRun({ startRoomIndex: 5 });
    const orig = (run as unknown as { humanFrame: (s: GameState) => ActionFrame }).humanFrame.bind(run);
    let woundDone = false;
    let pressed = false;
    (run as unknown as { humanFrame: (s: GameState) => ActionFrame }).humanFrame = (state: GameState): ActionFrame => {
      const f = orig(state);
      const me = state.players[0];
      if (run.director.step.id === stepId) {
        if (!woundDone) {
          woundDone = true;
          me.hp = Math.floor(me.maxHp * 0.6); // blessé mais au-dessus de la blessure mise en scène (50 %) : le solveur de heartSelf attend celle-ci
        }
        if (!pressed && me.heart !== undefined) {
          pressed = true;
          return { ...f, moveX: 0, moveY: 0, heart: true };
        }
      }
      return f;
    };
    run.run(3 * 60_000);
    return run;
  }

  it('B ENTRE les deux demi-cœurs (joueur blessé) : heartStore n est pas bloquée (deux rangements suffisent, pas de fusion) et la salle se termine', () => {
    const run = runWithOneEarlyB('heartStore');
    const stored = run.events.filter((e) => e.type === 'heartStored' && e.playerId === 0);
    expect(stored.length).toBeGreaterThanOrEqual(2);
    expect(run.events.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 0)).toBe(true);
    expect(run.director.snapshot().done).toEqual(expect.arrayContaining(['heartStore', 'heartSelf', 'heartAlly', 'heartFull', 'exit.heart']));
  }, T);

  it('B ENTRE les cœurs entiers de heartFull (joueur blessé) : le troisième cœur garantit le refus, l appel part et l étape se termine', () => {
    const run = runWithOneEarlyB('heartFull');
    expect(run.events.some((e) => e.type === 'autoCallStarted' && e.playerId === 0 && e.icon === 'heart')).toBe(true);
    expect(run.director.snapshot().done).toEqual(expect.arrayContaining(['heartFull', 'exit.heart']));
  }, T);

  it('départ direct dans chaque nouvelle salle (?room=N) : l étape de la salle est jouable de bout en bout avec le solveur', () => {
    for (const [room, last] of [[6, 'exit.gear'], [7, 'exit.cross']] as const) {
      const run = new TutorialRun({ startRoomIndex: room });
      for (let i = 0; i < 60 * 120 && run.state.roomIndex === room; i++) run.tick();
      expect(run.state.roomIndex, `salle ${room}`).toBe(room + 1);
      expect(run.director.snapshot().done, `salle ${room}`).toContain(last);
    }
  }, T);

  it('déterminisme : deux parcours complets identiques donnent le même état de simulation et le même snapshot du directeur', () => {
    const a = new TutorialRun();
    const b = new TutorialRun();
    a.run(MAX_MS);
    b.run(MAX_MS);
    expect(a.sim.serialize()).toBe(b.sim.serialize());
    expect(JSON.stringify(a.director.snapshot())).toBe(JSON.stringify(b.director.snapshot()));
  }, T);

  it('personnage différent (partenaire Valentine) : les nouvelles salles se terminent aussi', () => {
    const run = new TutorialRun({ human: 'sandrine', partner: 'valentine', startRoomIndex: 6 });
    for (let i = 0; i < 60 * 240 && run.state.roomIndex < 9; i++) run.tick();
    expect(run.state.roomIndex).toBe(9);
    expect(run.director.snapshot().done).toEqual(expect.arrayContaining(['gearLeft', 'gearSwap', 'crossCall']));
  }, T);
});
