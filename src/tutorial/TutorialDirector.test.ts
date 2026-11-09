import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from '../core/constants';
import type { SimEvent } from '../core/types';
import { tutorialLevel } from '../levels/tutorial';
import { ALL_REGIONS, TutorialRun } from '../testing/tutorial.solution';
import { FLASH_MS, STUCK_MS, TutorialDirector, resolveMarker } from './TutorialDirector';
import { TUTORIAL_STEPS } from './steps';

function ticks(run: TutorialRun, n: number): void {
  for (let i = 0; i < n; i++) run.tick();
}

function runUntilStep(run: TutorialRun, id: string, maxTicks = 60 * 600): void {
  for (let i = 0; i < maxTicks && run.director.step.id !== id; i++) run.tick();
  expect(run.director.step.id).toBe(id);
}

describe('TutorialDirector : étapes', () => {
  it('démarre à la première étape de la salle de départ (startRoomIndex = k)', () => {
    for (let k = 0; k < tutorialLevel.rooms.length; k++) {
      const d = new TutorialDirector(tutorialLevel, { startRoomIndex: k });
      expect(d.step.room).toBe(tutorialLevel.rooms[k].id);
      expect(d.step.id).toBe(TUTORIAL_STEPS.find((s) => s.room === tutorialLevel.rooms[k].id)!.id);
    }
    // valeur invalide : salle 0
    expect(new TutorialDirector(tutorialLevel, { startRoomIndex: Number.NaN }).step.id).toBe('welcome');
    expect(new TutorialDirector(tutorialLevel, { startRoomIndex: 99 }).step.room).toBe('t_seal');
  });

  it('une étape `tip` se ferme seule après minMs (et ne bloque jamais), même avec un joueur inactif', () => {
    const run = new TutorialRun({ strategy: 'idle' });
    expect(run.director.step.id).toBe('welcome');
    ticks(run, Math.floor(9000 / SIM_STEP_MS) - 5);
    expect(run.director.step.id).toBe('welcome');
    ticks(run, 20);
    expect(run.director.step.id).toBe('move'); // le tip est fermé ; `move` attend une action
  });

  it('une étape `do` n est PAS validée par un joueur inactif ; l astuce « bloqué » apparaît après 45 s et propose la salle suivante', () => {
    const run = new TutorialRun({ strategy: 'idle' });
    runUntilStep(run, 'move');
    ticks(run, 60 * 30);
    expect(run.director.step.id).toBe('move');
    expect(run.director.view().stuck).toBe(false);
    expect(run.director.skipKind()).toBe('step');
    ticks(run, Math.ceil((STUCK_MS - 30_000) / SIM_STEP_MS) + 60);
    const v = run.director.view();
    expect(v.stuck).toBe(true);
    expect(v.skipKind).toBe('room');
    expect(run.director.skipStep()).toBe('room'); // la scène relance à la salle suivante
    expect(run.director.step.id).toBe('move'); // rien n a changé côté directeur
  });

  it('minMs est respecté même si la condition est déjà vraie à l entrée de l étape', () => {
    // `hearts` n a pas de condition ; `clearYard` : tous les ennemis déjà vaincus à l entrée → reste lisible 1200 ms
    const run = new TutorialRun({ startRoomIndex: 0 });
    const d = run.director;
    d.skipStep(); // welcome
    d.skipStep(); // move
    d.skipStep(); // sign
    d.skipStep(); // roomGoals
    d.skipStep(); // attack
    d.skipStep(); // personalGoal
    d.skipStep(); // hearts
    d.skipStep(); // special
    d.skipStep(); // specialRecharge
    expect(d.step.id).toBe('clearYard');
    // la cour est vidée « en coulisse » : la condition est vraie immédiatement
    run.state.room.enemies.length = 0;
    run.state.room.spawnedSpawnIdx.push(0, 1, 2, 3);
    ticks(run, 30);
    expect(d.step.id).toBe('clearYard');
    ticks(run, Math.ceil(1200 / SIM_STEP_MS));
    expect(d.step.id).not.toBe('clearYard');
  });

  it('sauter une étape ordinaire la marque faite ; sauter une étape de sortie propose de sauter la salle', () => {
    const run = new TutorialRun({ strategy: 'idle' });
    const d = run.director;
    expect(d.skipKind()).toBe('step');
    expect(d.skipStep()).toBe('step');
    expect(d.step.id).toBe('move');
    expect(d.snapshot().done).toContain('welcome');
    const exit = new TutorialDirector(tutorialLevel);
    for (let i = 0; i < 10; i++) exit.skipStep();
    expect(exit.step.id).toBe('exit.yard');
    expect(exit.skipKind()).toBe('room');
    expect(exit.skipStep()).toBe('room');
  });

  it('sauter l étape des plaques garde la plaque B tenue par le partenaire (opération essentielle)', () => {
    const run = new TutorialRun({ startRoomIndex: 1, strategy: 'solver' });
    runUntilStep(run, 'plates'); // le levier est tiré pour de vrai (étape prérequis : non sautable)
    const d = run.director;
    expect(d.step.id).toBe('plates');
    d.skipStep(); // plates : le partenaire doit TENIR la plaque B même si on saute
    expect(d.step.id).toBe('teamGoal');
    expect(d.snapshot().backlog.some((o) => o.op === 'stand')).toBe(true);
    let held = false;
    for (let i = 0; i < 60 * 12 && !held && run.state.roomIndex === 1; i++) {
      run.tick();
      held = (run.state.room.mechanisms.find((m) => m.id === 'pB') as { active?: boolean } | undefined)?.active === true;
    }
    expect(held).toBe(true);
  });

  it('étapes prérequis (levier, bloc) : « Passer » propose la salle suivante (les étapes suivantes seraient impossibles) et ne change pas d étape', () => {
    for (const [room, id] of [[1, 'lever'], [2, 'block']] as const) {
      const run = new TutorialRun({ startRoomIndex: room, strategy: 'idle' });
      const d = run.director;
      expect(d.step.id).toBe(id);
      expect(d.skipKind()).toBe('room');
      expect(d.view().skipKind).toBe('room');
      expect(d.skipStep()).toBe('room');
      expect(d.step.id).toBe(id);
    }
  });

  it('bloc poussable coincé contre une paroi : astuce « bloqué » IMMÉDIATE (pas 45 s) ; bloc bien placé : rien', () => {
    const run = new TutorialRun({ startRoomIndex: 2, strategy: 'idle' });
    ticks(run, 5);
    expect(run.director.view().stuck).toBe(false);
    const block = run.state.room.mechanisms.find((m) => m.id === 'b') as { tile: [number, number]; pos: { x: number; y: number } };
    block.tile = [8, 1]; // collé au mur nord, socle en rangée 3 : plus personne ne peut le ramener
    block.pos = { x: 8 * 16, y: 16 };
    ticks(run, 5);
    const v = run.director.view();
    expect(v.stuck).toBe(true);
    expect(v.skipKind).toBe('room');
  });

  it('sans saut, l étape suivante ne reprend pas les opérations déjà terminées', () => {
    const run = new TutorialRun({ startRoomIndex: 1 });
    run.run(120_000);
    expect(run.director.snapshot().backlog).toEqual([]);
  });
});

describe('TutorialDirector : salles, défaite, interruptions', () => {
  it('vraie défaite (restart) : retour à la première étape `do` de la salle, sans rejouer le tip d accueil', () => {
    const run = new TutorialRun({ strategy: 'solver' });
    runUntilStep(run, 'personalGoal');
    run.sim.knockDown(0);
    run.sim.knockDown(1);
    ticks(run, 60 * 4);
    expect(run.events.some((e) => e.type === 'roomEntered' && e.reason === 'restart')).toBe(true);
    const after = run.stepsSeen.slice(run.stepsSeen.lastIndexOf('personalGoal') + 1);
    expect(after[0]).toBe('move'); // reprise à la première étape `do` (pas le tip d accueil)
    expect(after).not.toContain('welcome');
    expect(run.director.snapshot().done).not.toContain('personalGoal');
  });

  it('la démonstration de mort d équipe ne se rejoue pas : après `wipe`, un restart revient à `finalGoals`', () => {
    const run = new TutorialRun({ startRoomIndex: 6, strategy: 'idle' });
    runUntilStep(run, 'finalGoals');
    expect(run.director.snapshot().wipeDone).toBe(true);
    run.sim.knockDown(0);
    run.sim.knockDown(1);
    ticks(run, 60 * 4);
    expect(run.director.step.id).toBe('finalGoals');
  });

  it('démonstration `wipe` : les deux joueurs tombent 4 s après le début de l étape, puis la salle redémarre', () => {
    const run = new TutorialRun({ startRoomIndex: 6, strategy: 'idle' });
    expect(run.director.step.id).toBe('wipe');
    ticks(run, Math.floor(3900 / SIM_STEP_MS));
    expect(run.events.some((e) => e.type === 'teamWipe')).toBe(false);
    ticks(run, 20);
    expect(run.events.some((e) => e.type === 'teamWipe')).toBe(true);
    expect(run.director.view().visible).toBe(false); // phase 'wipe' : carte masquée
    ticks(run, 60 * 3);
    expect(run.director.step.id).toBe('finalGoals');
    expect(run.director.view().visible).toBe(true);
  });

  it('relevage : le partenaire tombe 1,2 s après le début de l étape et l étape se valide quand le joueur le relève', () => {
    const run = new TutorialRun({ startRoomIndex: 4 });
    expect(run.director.step.id).toBe('revive');
    ticks(run, Math.floor(1100 / SIM_STEP_MS));
    expect(run.state.players[1].status).toBe('alive');
    ticks(run, 20);
    expect(run.state.players[1].status).toBe('down');
    expect(run.director.view().interrupt).toBeNull(); // scénario : pas de carte d interruption
    expect(run.director.view().markers.length).toBe(1); // repère sur le partenaire
    runUntilStep(run, 'exit.revive');
    expect(run.state.players[1].status).toBe('alive');
    // la mise à terre n est déclenchée qu UNE fois
    expect(run.events.filter((e) => e.type === 'playerDown').length).toBe(1);
  });

  it('joueur à terre et partenaire debout : carte `youDown` et le partenaire vient le relever', () => {
    const run = new TutorialRun({ startRoomIndex: 0, strategy: 'idle' });
    ticks(run, 30);
    run.sim.knockDown(0);
    ticks(run, 5);
    expect(run.director.view().interrupt).toBe('youDown');
    expect(run.director.view().textKey).toBe('tutorial.card.youDown');
    ticks(run, 60 * 12);
    expect(run.state.players[0].status).toBe('alive');
    expect(run.director.view().interrupt).toBeNull();
  });

  it('partenaire à terre hors scénario : carte `partnerDown` avec repère et bouton d action', () => {
    const run = new TutorialRun({ startRoomIndex: 0, strategy: 'idle' });
    ticks(run, 30);
    run.sim.knockDown(1);
    ticks(run, 5);
    const v = run.director.view();
    expect(v.interrupt).toBe('partnerDown');
    expect(v.buttons).toEqual(['action']);
    expect(v.markers.length).toBe(1);
  });

  it('relevage interrompu : carte temporaire qui s efface', () => {
    const run = new TutorialRun({ startRoomIndex: 4, strategy: 'idle' });
    const ev: SimEvent = { type: 'reviveInterrupted', reviverId: 0, targetId: 1, reason: 'released' };
    run.director.observe([ev], run.state, { regions: ALL_REGIONS });
    expect(run.director.view().interrupt).toBe('reviveInterrupted');
    ticks(run, Math.ceil(FLASH_MS / SIM_STEP_MS) + 10);
    expect(run.director.view().interrupt).toBeNull();
  });

  it('la vue est masquée hors phase `playing` et à la fin ; `exit.final` + levelCompleted termine le tutoriel', () => {
    const run = new TutorialRun();
    run.run(10 * 60_000);
    expect(run.director.finished).toBe(true);
    expect(run.director.view().visible).toBe(false);
    expect(run.director.view().finished).toBe(true);
  });

  it('une porte (`gate`) ouverte une fois ne se referme plus : refuel validé même si la torche est pleine ensuite', () => {
    const run = new TutorialRun({ startRoomIndex: 3 });
    runUntilStep(run, 'refuel');
    expect(run.director.view().waiting).toBe(false);
    for (let i = 0; i < 60 * 60 && run.director.step.room === 't_dark'; i++) run.tick();
    expect(run.director.step.room).toBe('t_revive');
    expect(run.director.snapshot().done).toContain('refuel');
  });

  it('étape à porte fermée : carte « en attente » et temps d affichage figé (callSend avant que le partenaire s éloigne)', () => {
    const run = new TutorialRun({ startRoomIndex: 5, strategy: 'solver' });
    runUntilStep(run, 'callSend');
    const v = run.director.view();
    expect(v.waiting).toBe(true);
    expect(v.activeMs).toBe(0);
  });
});

describe('TutorialDirector : état JSON et repères', () => {
  it('snapshot / restore : même état JSON et mêmes sorties ensuite', () => {
    const a = new TutorialRun({ seed: 3 });
    ticks(a, 60 * 25);
    const snap = a.director.snapshot();
    const copy = TutorialDirector.restore(snap, tutorialLevel);
    expect(JSON.stringify(copy.snapshot())).toBe(JSON.stringify(snap));
    // même suite d observations → mêmes sorties
    const state = a.state;
    const f1 = a.director.partnerFrame(state);
    const f2 = copy.partnerFrame(state);
    expect(f2).toEqual(f1);
    expect(JSON.stringify(copy.snapshot())).toBe(JSON.stringify(a.director.snapshot()));
  });

  it('l état est du JSON pur (aller-retour identique)', () => {
    const run = new TutorialRun();
    ticks(run, 60 * 20);
    const snap = run.director.snapshot();
    expect(JSON.parse(JSON.stringify(snap))).toEqual(snap);
  });

  it('resolveMarker : panneau, sortie, ennemi le plus proche, mécanisme (plus de repère une fois actif)', () => {
    const run = new TutorialRun();
    run.tick();
    const room = tutorialLevel.rooms[0];
    expect(resolveMarker({ sign: 's_yard' }, run.state, room)).toEqual({ x: 9.5 * 16, y: 5.5 * 16 });
    expect(resolveMarker({ exit: true }, run.state, room)).toEqual({ x: 34 * 16, y: 6.5 * 16 });
    expect(resolveMarker({ nearestEnemy: true }, run.state, room)).not.toBeNull();
    expect(resolveMarker({ sign: 'inconnu' }, run.state, room)).toBeNull();
    const w = new TutorialRun({ startRoomIndex: 1 });
    w.tick();
    const wr = tutorialLevel.rooms[1];
    expect(resolveMarker({ mech: 'lv' }, w.state, wr)).not.toBeNull();
    const lv = w.state.room.mechanisms.find((m) => m.id === 'lv')!;
    lv.active = true;
    expect(resolveMarker({ mech: 'lv' }, w.state, wr)).toBeNull();
  });

  it('déterminisme : deux directeurs nourris des mêmes observations ont le même état', () => {
    const a = new TutorialRun({ seed: 9 });
    const b = new TutorialRun({ seed: 9 });
    ticks(a, 60 * 60);
    ticks(b, 60 * 60);
    expect(JSON.stringify(a.director.snapshot())).toBe(JSON.stringify(b.director.snapshot()));
    expect(JSON.stringify(a.director.view())).toBe(JSON.stringify(b.director.view()));
  });
});
