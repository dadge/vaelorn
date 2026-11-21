/**
 * TACTIQUES DE BOSS dans la simulation : recopie du drapeau à l'apparition (boss seulement), monde des tactiques construit seulement si besoin, boss qui rejoint un joueur à terre / un
 * cristal / un bonus, confiscation (`itemSeized`) et ramassage disputé, états sans tactiques inchangés (aucune clé `tact*`), restauration en plein but.
 * Aucune horloge réelle : pas fixes.
 */
import { describe, expect, it } from 'vitest';
import { SIM_STEP_MS } from './constants';
import { makeTestLayout, makeTestLevel, makeTestRoom } from './levelValidation';
import { dist } from './geometry';
import { createSimulation, GameSimulation } from './simulation';
import type { BossTacticId, CharacterId, EnemyAIContext, EnemyKind, EnemySpawnDef, LevelDef, PlayerId, SimEvent } from './types';

const DT = SIM_STEP_MS;

function level(boss: EnemySpawnDef, extra: EnemySpawnDef[] = []): LevelDef {
  const room = makeTestRoom({
    id: 'arena',
    layout: makeTestLayout(60, 36),
    playerSpawns: [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ],
    enemies: [boss, ...extra],
    mechanisms: [],
    healCrystals: [
      { id: 'c1', tile: [12, 28] },
      { id: 'c2', tile: [26, 4] },
      { id: 'c3', tile: [14, 6], minPlayers: 3 },
    ],
    exit: { rect: { x: 56, y: 16, w: 2, h: 3 }, requires: ['clear'], final: true },
  });
  return makeTestLevel({ rooms: [room] });
}

function mk(lv: LevelDef, n = 2, seed = 5, heartSlot = false, chars: readonly CharacterId[] = ['david', 'sandrine', 'romain', 'valentine']): GameSimulation {
  return createSimulation(
    { levelId: lv.id, players: Array.from({ length: n }, (_, i) => ({ id: i as PlayerId, characterId: chars[i], difficulty: 2 as const })), seed, ...(heartSlot ? { heartSlot: true } : {}) },
    lv,
  );
}

function stepMs(s: GameSimulation, ms: number): SimEvent[] {
  const out: SimEvent[] = [];
  for (let t = 0; t < ms; t += DT) out.push(...s.step(DT, {}));
  return out;
}

const boss = (s: GameSimulation, kind: EnemyKind): NonNullable<ReturnType<GameSimulation['state']['room']['enemies']['find']>> => {
  const e = s.state.room.enemies.find((x) => x.kind === kind);
  if (!e) throw new Error('boss absent');
  return e;
};

const ofType = <T extends SimEvent['type']>(events: readonly SimEvent[], type: T): Extract<SimEvent, { type: T }>[] =>
  events.filter((e): e is Extract<SimEvent, { type: T }> => e.type === type);

/** Fabrique le contexte d'IA de la simulation (méthode privée) pour inspecter `world`. */
function aiContext(s: GameSimulation): EnemyAIContext {
  const priv = s as unknown as { makeAIContext: (dt: number, ev: SimEvent[], cctx: unknown, alive: unknown[]) => EnemyAIContext; aliveEnemies: () => unknown[] };
  return priv.makeAIContext(DT, [], {}, priv.aliveEnemies());
}

describe('apparition : le drapeau tact vient des données du niveau, pour un boss seulement', () => {
  it('un demi-boss tactique reçoit `data.tact` ; sans `tactics` aucune clé tact*', () => {
    const a = mk(level({ kind: 'warden', tile: [40, 20], tactics: ['guardDowned', 'seizeItems'] }));
    stepMs(a, 100);
    expect(boss(a, 'warden').data.tact).toBe(1 | 16);
    const b = mk(level({ kind: 'warden', tile: [40, 20] }));
    stepMs(b, 5000);
    expect(Object.keys(boss(b, 'warden').data).filter((k) => k.startsWith('tact'))).toEqual([]);
    expect(b.serialize()).not.toContain('tact');
  });

  it('`tactics` sur un ennemi ordinaire est ignoré (la validation de niveau l\'interdit aussi)', () => {
    const s = mk(level({ kind: 'skeleton', tile: [40, 20], tactics: ['guardDowned'] }));
    stepMs(s, 200);
    expect(Object.keys(boss(s, 'skeleton').data).some((k) => k.startsWith('tact'))).toBe(false);
  });

  it('les sbires invoqués n\'héritent pas du drapeau', () => {
    const s = mk(level({ kind: 'frostqueen', tile: [10, 8], tactics: ['guardDowned'] }), 2);
    const q = boss(s, 'frostqueen');
    q.hp = q.maxHp * 0.3;
    stepMs(s, 30000);
    const minions = s.state.room.enemies.filter((e) => e.data.summoner === q.id);
    for (const m of minions) expect(m.data.tact).toBeUndefined();
  });
});

describe('monde des tactiques (contexte d\'IA)', () => {
  it('`world` est undefined sans boss tactique (aucune allocation), présent avec', () => {
    const plain = mk(level({ kind: 'warden', tile: [40, 20] }));
    stepMs(plain, 100);
    expect(aiContext(plain).world).toBeUndefined();
    const tact = mk(level({ kind: 'warden', tile: [40, 20], tactics: ['campCrystal'] }));
    stepMs(tact, 100);
    const w = aiContext(tact).world;
    expect(w).toBeDefined();
    expect(w?.crystals.map((c) => c.id)).toEqual(['c1', 'c2']); // c3 : minPlayers 3, absent à 2 joueurs
  });

  it('un cristal utilisé disparaît du monde ; les objets au sol y figurent avec leur valeur', () => {
    const s = mk(level({ kind: 'warden', tile: [40, 20], tactics: ['seizeItems'] }), 3);
    stepMs(s, 100);
    expect(aiContext(s).world?.crystals.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    (s.state.room.healCrystals ?? [])[1].used = true;
    expect(aiContext(s).world?.crystals.map((c) => c.id)).toEqual(['c1', 'c3']);
    s.spawnScriptedHeart({ x: 200, y: 200 }, 'half', 60000);
    s.state.room.buffDrops?.push({ id: 90, kind: 'star', pos: { x: 300, y: 200 }, ttlMs: 60000 });
    stepMs(s, DT * 2);
    const items = aiContext(s).world?.items ?? [];
    expect(items.map((i) => [i.kind, i.value, i.eatable]).sort()).toEqual([
      ['buff', 2, true],
      ['heart', 2, true],
    ]);
  });
});

describe('comportement en simulation', () => {
  it('le boss tactique rejoint le joueur à terre (veille) puis relâche', () => {
    const s = mk(level({ kind: 'warden', tile: [30, 20], tactics: ['guardDowned'] }), 2);
    const b = boss(s, 'warden');
    b.data.engaged = 1;
    // les joueurs restent près du départ ; le joueur 1 tombe plus près du boss
    s.state.players[1].pos = { x: 22 * 16, y: 16 * 16 };
    s.knockDown(1);
    const ev = stepMs(s, 22000);
    expect(ofType(ev, 'bossTactic').some((e) => e.kind === 1)).toBe(true);
    let near = false;
    // on rejoue pour mesurer la distance de veille
    const s2 = mk(level({ kind: 'warden', tile: [30, 20], tactics: ['guardDowned'] }), 2);
    boss(s2, 'warden').data.engaged = 1;
    s2.state.players[1].pos = { x: 22 * 16, y: 16 * 16 };
    s2.knockDown(1);
    for (let t = 0; t < 22000; t += DT) {
      s2.step(DT, {});
      const bb = boss(s2, 'warden');
      if ((bb.data.tactKind ?? 0) === 1 && dist(bb.pos, s2.state.players[1].pos) < 60) near = true;
    }
    expect(near).toBe(true);
  });

  it.each(['pyromancer', 'wraith', 'voidlord'] as EnemyKind[])("un boss LÉVITANT (%s) atteint l'anneau du joueur à terre en simulation réelle (régression : il n'avançait que pendant les rares pas de poursuite)", (kind) => {
    for (const n of [2, 3, 4]) {
      const s = mk(level({ kind, tile: [30, 20], tactics: ['guardDowned'] }), n);
      boss(s, kind).data.engaged = 1;
      s.state.players[1].pos = { x: 22 * 16, y: 16 * 16 };
      s.knockDown(1);
      let posted = 0;
      for (let t = 0; t < 30000; t += DT) {
        s.step(DT, {});
        const bb = boss(s, kind);
        if ((bb.data.tactKind ?? 0) === 1 && dist(bb.pos, s.state.players[1].pos) <= 44 + 14) posted += DT;
      }
      expect(posted, `${kind} à ${n} joueurs : jamais posté`).toBeGreaterThan(500);
    }
  });

  it('un « rapace » se poste sur un demi-cœur et le confisque ; un cœur entier n\'est jamais confisqué', () => {
    const s = mk(level({ kind: 'warden', tile: [30, 20], tactics: ['seizeItems'] }), 2);
    boss(s, 'warden').data.engaged = 1;
    s.spawnScriptedHeart({ x: 26 * 16, y: 20 * 16 }, 'half', 60000);
    const ev = stepMs(s, 30000);
    const seized = ofType(ev, 'itemSeized');
    expect(seized.length).toBe(1);
    expect(seized[0].kind).toBe('heart');
    expect(s.state.room.pickups?.length).toBe(0);
    // cœur entier : posté dessus mais jamais mangé
    const t = mk(level({ kind: 'warden', tile: [30, 20], tactics: ['seizeItems'] }), 2);
    boss(t, 'warden').data.engaged = 1;
    t.spawnScriptedHeart({ x: 26 * 16, y: 20 * 16 }, 'full', 60000);
    const ev2 = stepMs(t, 30000);
    expect(ofType(ev2, 'itemSeized')).toEqual([]);
    expect(t.state.room.pickups?.length).toBe(1);
  });

  it('un objet ramassé par un joueur avant l\'échéance n\'est pas confisqué', () => {
    const s = mk(level({ kind: 'warden', tile: [30, 20], tactics: ['seizeItems'] }), 2);
    boss(s, 'warden').data.engaged = 1;
    s.state.players[0].hp = 10; // blessé : ramasse le demi-cœur au contact
    s.state.players[0].pos = { x: 26 * 16, y: 20 * 16 };
    s.spawnScriptedHeart({ x: 26 * 16, y: 20 * 16 }, 'half', 60000);
    const ev = stepMs(s, 20000);
    expect(ofType(ev, 'itemSeized')).toEqual([]);
    expect(ofType(ev, 'pickupCollected').length).toBe(1);
  });

  it('la partie est déterministe et restaurable en plein but : même suite d\'états après serialize/restore', () => {
    const lv = level({ kind: 'warden', tile: [30, 20], tactics: ['guardDowned', 'campCrystal', 'seizeItems'] }, [{ kind: 'skeleton', tile: [20, 10], minPlayers: 1 }]);
    const a = mk(lv, 3, 11);
    boss(a, 'warden').data.engaged = 1;
    a.state.players[1].pos = { x: 22 * 16, y: 16 * 16 };
    a.knockDown(1);
    stepMs(a, 9000);
    expect(boss(a, 'warden').data.tactKind ?? 0).toBeGreaterThanOrEqual(0);
    const snap = a.serialize();
    expect(snap).toContain('tactKind');
    const b = GameSimulation.restore(snap, lv);
    expect(b.serialize()).toBe(snap);
    for (let i = 0; i < 1200; i++) {
      a.step(DT, {});
      b.step(DT, {});
    }
    expect(b.serialize()).toBe(a.serialize());
    expect(JSON.parse(a.serialize())).toBeTruthy();
  });

  it('niveau sans tactiques : la partie et ses événements ne contiennent aucun événement tactique', () => {
    const s = mk(level({ kind: 'warden', tile: [30, 20] }), 2);
    boss(s, 'warden').data.engaged = 1;
    s.knockDown(1);
    const ev = stepMs(s, 15000);
    expect(ev.some((e) => e.type === 'bossTactic' || e.type === 'itemSeized')).toBe(false);
    const tactics: BossTacticId[] = [];
    expect(tactics.length).toBe(0);
  });
});

describe('contre-jeu : tout spécial de héros qui touche un boss tactique le déstabilise', () => {
  const HEROES: CharacterId[] = ['david', 'sandrine', 'romain', 'valentine', 'aelith', 'brokk', 'grok', 'mira'];
  it.each(HEROES)('%s : après son spécial, les buts du boss sont coupés (code 7) ; sans tactiques : aucun effet', (hero) => {
    for (const tactical of [true, false]) {
      const s = mk(level({ kind: 'forgelord', tile: [30, 20], ...(tactical ? { tactics: ['guardDowned', 'seizeItems'] as BossTacticId[] } : {}) }), 1, 5, false, [hero]);
      const b = boss(s, 'forgelord');
      b.data.engaged = 1;
      const p = s.state.players[0];
      p.pos = { x: b.pos.x - 30, y: b.pos.y };
      p.facing = 'right';
      const hp0 = b.hp;
      s.step(DT, { 0: { moveX: 0, moveY: 0, attack: false, interact: false, revive: false, special: true } });
      for (let i = 0; i < 40; i++) s.step(DT, {});
      expect(b.hp, `${hero} touche le boss`).toBeLessThan(hp0);
      if (tactical) expect(b.data.tactBreakMs ?? 0, hero).toBeGreaterThan(0);
      else expect(Object.keys(b.data).filter((k) => k.startsWith('tact'))).toEqual([]);
    }
  });
});

describe('veille et rapace : le boss ne se pose pas sur le joueur à terre (relevage jamais ralenti par le plan « bonus »)', () => {
  it('cœur rangé tombé aux pieds du joueur à terre : le forgeron reste à plus de DOWNED_THREAT_RADIUS pendant toute la chute', () => {
    const lv = level({ kind: 'forgelord', tile: [30, 20], tactics: ['guardDowned', 'campCrystal', 'heedCalls', 'interceptCarrier', 'seizeItems', 'huntWeak'] });
    const s = mk(lv, 2, 1, true);
    boss(s, 'forgelord').data.engaged = 1;
    s.state.players[1].pos = { x: 22 * 16, y: 16 * 16 };
    expect(s.giveScriptedHeart(1, 'full')).toBe(true);
    s.knockDown(1); // le cœur tombe sur place
    expect((s.state.room.pickups ?? []).length).toBeGreaterThan(0);
    let minD = Infinity;
    let seizeSeen = false;
    for (let t = 0; t < 40000; t += DT) {
      s.step(DT, {});
      const b = boss(s, 'forgelord');
      if (s.state.players[1].status === 'down') minD = Math.min(minD, dist(b.pos, s.state.players[1].pos));
      if ((b.data.tactKind ?? 0) === 5) seizeSeen = true;
    }
    expect(s.state.players[1].status).toBe('down');
    expect(minD).toBeGreaterThan(20);
    expect(seizeSeen).toBe(false); // le seul bonus du sol est sous le joueur à terre : pas de plan « rapace »
  });
});

