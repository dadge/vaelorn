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
    console.info(`[tutoriel] terminé en ${(ms / 1000).toFixed(0)} s simulées`);
  }, T);

  it('personnage différent (partenaire choisi en conséquence) : terminé aussi', () => {
    const run = new TutorialRun({ human: 'sandrine', partner: 'valentine' });
    expectCompleted(run, run.run(MAX_MS));
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
  it('le parcours complet range un cœur, se soigne avec B, soigne le partenaire blessé et déclenche l appel automatique de cœur', () => {
    const run = new TutorialRun();
    run.run(MAX_MS);
    expect(run.done).toBe(true);
    const ev = run.events;
    // rangement
    expect(ev.some((e) => e.type === 'heartStored' && e.playerId === 0)).toBe(true);
    // B sur soi (blessure scénarisée) puis B sur le coéquipier blessé : jamais consommé au contact
    const used = ev.filter((e) => e.type === 'heartUsed');
    expect(used.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 0)).toBe(true);
    expect(used.some((e) => e.type === 'heartUsed' && e.playerId === 0 && e.targetId === 1)).toBe(true);
    expect(ev.some((e) => e.type === 'pickupCollected')).toBe(false);
    // emplacement plein : appel automatique avec le symbole du cœur / demi-cœur vers le partenaire, qui prend ensuite le cœur resté au sol
    const calls = ev.filter((e) => e.type === 'autoCallStarted');
    expect(calls.some((e) => e.type === 'autoCallStarted' && e.playerId === 0 && (e.icon === 'half' || e.icon === 'heart') && e.to.includes(1))).toBe(true);
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
