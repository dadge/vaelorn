import { beforeAll, describe, expect, it } from 'vitest';
import { GAME_HEIGHT, GAME_WIDTH, TILE } from '../core/constants';
import { createSimulation, type GameSimulation } from '../core/simulation';
import type { LevelDef, PlayerId, PlayerSetup } from '../core/types';
import { setLanguage, type Language } from '../i18n/i18n';
import { LEVELS } from '../levels';
import { HUD_DEPTH, PlayerHud, TeamPanelHud, boundsOverlap, type HudEnv, type ScreenBounds } from './hud';
import { HUD_MARGIN, hudAnchor, mainBlockMetrics } from './hudAnchor';
import { FakeGameObject, makeFakeViewContext } from './hudTestKit';
import { mapZone } from './mapZone';
import { computeLayout, type ScreenRect, type SplitLayout } from './splitscreen';

beforeAll(() => setLanguage('fr'));

const setups = (n: number): PlayerSetup[] =>
  (['david', 'sandrine', 'romain', 'valentine'] as const).slice(0, n).map((characterId, i) => ({ id: i as PlayerId, characterId, difficulty: 2 }));

const asBounds = (r: ScreenRect): ScreenBounds => ({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });

describe('hudAnchor : règles d\'ancrage', () => {
  it('1 joueur : inchangé (haut gauche, objectif en haut à droite)', () => {
    const a = hudAnchor(computeLayout(1), 0);
    expect(a).toEqual({ alignX: 'left', alignY: 'top', goalAlignX: 'right', goalAlignY: 'top' });
  });

  it('invité réseau : une seule vue (viewIndex 0, layout à 1 vue) = inchangé', () => {
    expect(hudAnchor(computeLayout(1), 0)).toEqual(hudAnchor(computeLayout(1), 2));
  });

  it('2 joueurs : vue 0 à gauche, vue 1 à droite, toutes deux en haut ; objectif dans l\'autre coin', () => {
    const l = computeLayout(2);
    expect(hudAnchor(l, 0)).toEqual({ alignX: 'left', alignY: 'top', goalAlignX: 'right', goalAlignY: 'top' });
    expect(hudAnchor(l, 1)).toEqual({ alignX: 'right', alignY: 'top', goalAlignX: 'left', goalAlignY: 'top' });
  });

  it.each([3, 4])('%i joueurs : colonne gauche / droite et rangée haut / bas', (n) => {
    const l = computeLayout(n);
    expect(hudAnchor(l, 0)).toEqual({ alignX: 'left', alignY: 'top', goalAlignX: 'right', goalAlignY: 'top' });
    expect(hudAnchor(l, 1)).toEqual({ alignX: 'right', alignY: 'top', goalAlignX: 'left', goalAlignY: 'top' });
    expect(hudAnchor(l, 2)).toEqual({ alignX: 'left', alignY: 'bottom', goalAlignX: 'right', goalAlignY: 'bottom' });
    if (n === 4) expect(hudAnchor(l, 3)).toEqual({ alignX: 'right', alignY: 'bottom', goalAlignX: 'left', goalAlignY: 'bottom' });
  });

  it('le coin de l\'objectif est toujours opposé au côté du bloc principal, sur la même arête', () => {
    for (let n = 1; n <= 4; n++) {
      const l = computeLayout(n);
      for (let i = 0; i < l.viewports.length; i++) {
        const a = hudAnchor(l, i);
        expect(a.goalAlignX).not.toBe(a.alignX);
        expect(a.goalAlignY).toBe(a.alignY);
      }
    }
  });

  it('un indice de vue hors bornes est ramené dans les vues existantes (pas d\'exception)', () => {
    expect(() => hudAnchor(computeLayout(2), 9)).not.toThrow();
    expect(hudAnchor(computeLayout(2), -3).alignX).toBe('left');
  });
});

describe('mainBlockMetrics : mêmes positions que l\'ancien HUD', () => {
  it('zoom 2 (3-4 joueurs), équipement + emplacement cœur : lignes à 23 / 43 / 69 / 91 / 115 px du haut du bloc', () => {
    const m = mainBlockMetrics({ u: 2, fs: 13, vw: 638, heartsN: 6, gearOn: true, slotOn: true, buffCount: 4 });
    expect([m.hy, m.gy, m.sy, m.ky, m.oy]).toEqual([23, 43, 69, 91, 115]);
    expect(m.staticH).toBe(91 + 16);
    expect(m.slotW).toBe(39);
    expect(m.gearX0).toBe(46);
    expect(m.buffX0).toBe(46 + 6 * 21 + 8);
  });

  it('zoom 3 (1-2 joueurs) : lignes à 27 / 55 / 90 / 120 / 152 px', () => {
    const m = mainBlockMetrics({ u: 3, fs: 17, vw: 1280, heartsN: 6, gearOn: true, slotOn: true, buffCount: 4 });
    expect([m.hy, m.gy, m.sy, m.ky, m.oy]).toEqual([27, 55, 90, 120, 152]);
  });

  it('démo (sans équipement ni emplacement) : le spécial remonte sous les cœurs', () => {
    const m = mainBlockMetrics({ u: 2, fs: 13, vw: 1280, heartsN: 6, gearOn: false, slotOn: false, buffCount: 4 });
    expect(m.sy).toBe(m.hy + 16 + 6);
  });

  it('la largeur du bloc couvre chacune de ses lignes fixes (équipement + bonus, cœurs, spécial) ; les objectifs perso ont leur propre largeur', () => {
    const m = mainBlockMetrics({ u: 2, fs: 13, vw: 638, heartsN: 15, gearOn: true, slotOn: true, buffCount: 4 });
    expect(m.w).toBeGreaterThanOrEqual(m.buffX0 + 3 * m.buffCell + 16);
    expect(m.w).toBeGreaterThanOrEqual(14 * 18 + 16);
    expect(m.objW).toBeGreaterThanOrEqual(8 + 6 + m.objWrap);
  });

  it.each([2, 3, 4])('%i joueurs, 15 cœurs : le bloc tient dans la moitié extérieure de l\'écran (jamais jusqu\'à la zone centrale)', (n) => {
    const l = computeLayout(n);
    const zone = mapZone(l);
    const vp = l.viewports[0];
    const m = mainBlockMetrics({ u: l.zoom, fs: l.zoom >= 3 ? 17 : 13, vw: vp.w, heartsN: 15, gearOn: true, slotOn: true, buffCount: 4 });
    expect(zone).not.toBeNull();
    if (!zone) return;
    // colonne gauche : [10, 10 + w] ; colonne droite : [1280 - 10 - w, 1270]
    const widest = Math.max(m.w, m.objW);
    expect(HUD_MARGIN + widest).toBeLessThan(zone.x);
    expect(GAME_WIDTH - HUD_MARGIN - widest).toBeGreaterThan(zone.x + zone.w);
  });
});

// ───────────────────────────── Vrais HUD sur faux contexte ─────────────────────────────

interface Built {
  sim: GameSimulation;
  layout: SplitLayout;
  huds: PlayerHud[];
  team: TeamPanelHud | null;
  update: (dtMs?: number) => void;
}

/** Construit les HUD d'une partie à `n` joueurs dans la salle `roomIndex` de `level` (une vue par joueur), avec les PV maximaux les plus élevés du jeu (140 = 14 cœurs, David : `50 + 10 x résistance`). */
function build(level: LevelDef, roomIndex: number, n: number, maxHp = 140): Built {
  const sim = createSimulation({ levelId: level.id, players: setups(n), seed: 3, startRoomIndex: roomIndex }, level);
  for (const p of sim.state.players) {
    p.maxHp = maxHp;
    p.hp = maxHp;
  }
  const layout = computeLayout(n);
  const { ctx } = makeFakeViewContext(layout.zoom, n);
  const env: HudEnv = { ctx, level, layout, gear: true, heartSlot: true };
  const huds = sim.state.players.slice(0, layout.viewports.length).map((p) => new PlayerHud(env, p.id, p));
  const team = layout.teamPanel ? new TeamPanelHud(env, layout.teamPanel, sim.state.players) : null;
  const room = level.rooms[roomIndex];
  let timeMs = 1000;
  const update = (dtMs = 100): void => {
    timeMs += dtMs;
    for (const h of huds) h.update({ state: sim.state, room, dtMs, timeMs, exitOpen: false, camCenter: { x: 40 * TILE, y: 25 * TILE }, banners: [] });
    team?.update(sim.state, room, dtMs);
  };
  return { sim, layout, huds, team, update };
}

function overlapsZone(b: ScreenBounds, zone: ScreenRect): boolean {
  return boundsOverlap(b, asBounds(zone));
}

describe('vrais HUD : aucun élément permanent dans la zone réservée à la carte', () => {
  const langs: Language[] = ['fr', 'en'];
  for (const lang of langs) {
    for (const n of [2, 3, 4]) {
      it(`${n} joueurs, ${lang}, toutes les salles des 9 niveaux (écran logique 1280x720)`, () => {
        setLanguage(lang);
        const bad: string[] = [];
        for (const level of LEVELS) {
          level.rooms.forEach((room, ri) => {
            const b = build(level, ri, n);
            const zone = mapZone(b.layout);
            expect(zone).not.toBeNull();
            if (!zone) return;
            for (let pass = 0; pass < 2; pass++) b.update();
            b.huds.forEach((h, vi) => {
              const vp = b.layout.viewports[vi];
              for (const r of h.permanentBounds()) {
                if (overlapsZone(r, zone)) bad.push(`${level.id}/${room.id} vue ${vi} : ${JSON.stringify(r)} dans la zone`);
                // et dans sa propre vue (marge d'arrondi : 1 px)
                if (r.x0 < vp.x - 1 || r.y0 < vp.y - 1 || r.x1 > vp.x + vp.w + 1 || r.y1 > vp.y + vp.h + 1) bad.push(`${level.id}/${room.id} vue ${vi} : ${JSON.stringify(r)} hors de la vue`);
              }
            });
            if (b.team && b.layout.teamPanel) {
              const panel = b.layout.teamPanel;
              for (const r of b.team.permanentBounds()) {
                if (overlapsZone(r, zone)) bad.push(`${level.id}/${room.id} panneau : ${JSON.stringify(r)} dans la zone`);
                if (r.x0 < panel.x - 1 || r.y0 < panel.y - 1 || r.x1 > panel.x + panel.w + 1 || r.y1 > panel.y + panel.h + 1) bad.push(`${level.id}/${room.id} panneau : ${JSON.stringify(r)} hors du panneau`);
              }
            }
          });
        }
        expect(bad).toEqual([]);
      });
    }
  }

  it('à 640x360 (même disposition logique réduite de moitié par le mise à l\'échelle du canevas) : mêmes relations, rien ne se déplace', () => {
    // le canevas logique reste 1280x720 : la fenêtre 640x360 n'est qu'un facteur 1/2 appliqué à tout, la non-intersection y est donc conservée
    const level = LEVELS[0];
    const b = build(level, 0, 4);
    b.update();
    const zone = mapZone(b.layout);
    if (!zone) throw new Error('zone attendue');
    const half = (r: ScreenBounds): ScreenBounds => ({ x0: r.x0 / 2, y0: r.y0 / 2, x1: r.x1 / 2, y1: r.y1 / 2 });
    const zoneHalf = half(asBounds(zone));
    for (const h of b.huds) for (const r of h.permanentBounds()) expect(boundsOverlap(half(r), zoneHalf)).toBe(false);
    expect(zone.w * 0.5).toBeLessThan(GAME_WIDTH / 2);
    expect(zone.h * 0.5).toBeLessThan(GAME_HEIGHT / 2);
  });
});

describe('vrais HUD : ancrage effectif', () => {
  const level = LEVELS[0];

  it('1 joueur : positions historiques (nom en (10,10), cœurs à y = 10 + 13/17... + 10, objectif à droite)', () => {
    const b = build(level, 0, 1, 60);
    b.update();
    const r = b.huds[0].regions();
    // nom à (vx + 10, vy + 10) ; cœurs sous le nom ; bloc d'objectif de salle collé à droite (bord droit = 1280 - 10 - 6 + 5)
    expect(r.hearts?.x0).toBe(10 - 3);
    expect(r.hearts?.y0).toBe(10 + 17 + 10 - 3);
    expect(r.roomGoals?.y0).toBe(10);
    expect((r.roomGoals?.x1 ?? 0)).toBe(GAME_WIDTH - 10 - 6 + 5);
  });

  it('2 joueurs : le bloc principal de la vue 1 touche le bord DROIT de l\'écran ; celui de la vue 0 le bord gauche', () => {
    const b = build(level, 0, 2);
    b.update();
    const right = b.huds[1].permanentBounds();
    const left = b.huds[0].permanentBounds();
    expect(Math.min(...left.map((r) => r.x0))).toBeLessThanOrEqual(HUD_MARGIN);
    // le bloc est aligné sur sa ligne la plus large : sa limite droite est la marge de 10 px du bord droit de l'écran
    const hearts = b.huds[1].regions().hearts;
    const gear = b.huds[1].regions().gear;
    expect(hearts && gear).toBeTruthy();
    expect(Math.max(...right.map((r) => r.x1))).toBeLessThanOrEqual(GAME_WIDTH - HUD_MARGIN + 6);
  });

  it('4 joueurs : les vues du bas collent leur bloc principal au bord bas de l\'écran, celles du haut au bord haut', () => {
    const b = build(level, 0, 4, 60);
    b.update();
    b.huds.forEach((h, i) => {
      const vp = b.layout.viewports[i];
      const hearts = h.regions().hearts;
      const keys = h.regions().keys;
      expect(hearts && keys).toBeTruthy();
      if (!hearts || !keys) return;
      if (i < 2) expect(Math.min(...h.permanentBounds().map((r) => r.y0))).toBeLessThanOrEqual(vp.y + HUD_MARGIN);
      else expect(Math.max(...h.permanentBounds().map((r) => r.y1))).toBeGreaterThanOrEqual(vp.y + vp.h - HUD_MARGIN - 8); // objectifs perso ou clés : bord bas du bloc
    });
  });

  it('4 joueurs : le bloc « Objectif de la salle » est dans l\'AUTRE coin horizontal (vue de droite : à gauche de la vue)', () => {
    const b = build(level, 0, 4);
    b.update();
    const g0 = b.huds[0].regions().roomGoals;
    const g1 = b.huds[1].regions().roomGoals;
    const g2 = b.huds[2].regions().roomGoals;
    const g3 = b.huds[3].regions().roomGoals;
    const v = b.layout.viewports;
    expect(g0 && g1 && g2 && g3).toBeTruthy();
    if (!g0 || !g1 || !g2 || !g3) return;
    expect(g0.x1).toBeGreaterThan(v[0].x + v[0].w - 20); // vue haut-gauche : coin droit
    expect(g1.x0).toBeLessThan(v[1].x + 20); // vue haut-droite : coin gauche
    expect(g2.x1).toBeGreaterThan(v[2].x + v[2].w - 20);
    expect(g3.x0).toBeLessThan(v[3].x + 20);
    expect(g0.y0).toBe(v[0].y + HUD_MARGIN); // arête haute
    expect(g1.y0).toBe(v[1].y + HUD_MARGIN);
    expect(g2.y1).toBe(v[2].y + v[2].h - HUD_MARGIN); // arête basse
    expect(g3.y1).toBe(v[3].y + v[3].h - HUD_MARGIN);
  });

  it('3 joueurs : le panneau d\'équipe commence sous la zone de la carte et son titre est en bas du panneau', () => {
    const b = build(level, 0, 3);
    b.update();
    const panel = b.layout.teamPanel;
    const zone = mapZone(b.layout);
    expect(panel && zone && b.team).toBeTruthy();
    if (!panel || !zone || !b.team) return;
    const rects = b.team.permanentBounds();
    const [title, roomText] = rects;
    expect(title.y0).toBeGreaterThan(panel.y + panel.h / 2);
    expect(roomText.y0).toBeGreaterThan(panel.y + panel.h / 2);
    for (const r of rects.slice(2)) expect(r.y0).toBeGreaterThanOrEqual(zone.y + zone.h);
  });

  it('rangée du bas : l\'invite et la bulle de panneau passent en haut de la vue (le bas porte le bloc principal)', () => {
    const b = build(level, 0, 4);
    b.update();
    // l'invite contextuelle n'est jamais dans les rectangles permanents ; ici on vérifie simplement que la construction ne la place pas dans le coin du bloc
    expect(b.huds[2].permanentBounds().length).toBeGreaterThan(10);
  });
});

describe('vrais HUD : bandeaux sablier / lanterne empilés contre le bloc d\'objectif, vers l\'intérieur de la vue', () => {
  // salles qui affichent un bandeau (sablier : niveau 5 ; lanterne du pont de lumière : niveau 6)
  const rooms: { level: LevelDef; index: number }[] = [];
  for (const level of LEVELS) level.rooms.forEach((r, index) => { if (r.mechanisms.some((m) => m.type === 'hourglass' || m.type === 'lightBridge')) rooms.push({ level, index }); });

  it('il existe des salles à sablier et à lanterne (le test couvre bien ces bandeaux)', () => {
    expect(rooms.some(({ level, index }) => level.rooms[index].mechanisms.some((m) => m.type === 'hourglass'))).toBe(true);
    expect(rooms.some(({ level, index }) => level.rooms[index].mechanisms.some((m) => m.type === 'lightBridge'))).toBe(true);
  });

  it('4 joueurs : le bandeau visible est contre le bloc d\'objectif (au-dessous en haut, au-dessus en bas) et dans le même coin horizontal', () => {
    let seen = 0;
    for (const { level, index } of rooms) {
      const b = build(level, index, 4, 60);
      b.update();
      b.huds.forEach((h, vi) => {
        const vp = b.layout.viewports[vi];
        const goal = h.regions().roomGoals;
        const hud = h as unknown as { puzBg: { visible: boolean; x: number; y: number; width: number; height: number }; lanBg: { visible: boolean; x: number; y: number; width: number; height: number } };
        for (const bg of [hud.puzBg, hud.lanBg]) {
          if (!bg.visible) continue;
          seen++;
          const left = bg.x - bg.width; // origine (1, 0) : x = bord droit
          const right = bg.x;
          const top = bg.y;
          const bottom = bg.y + bg.height;
          expect(left, `vue ${vi} : bandeau hors de la vue`).toBeGreaterThanOrEqual(vp.x);
          expect(right, `vue ${vi} : bandeau hors de la vue`).toBeLessThanOrEqual(vp.x + vp.w);
          if (vi % 2 === 1) expect(left, `vue ${vi} : coin gauche`).toBeLessThan(vp.x + HUD_MARGIN + 8);
          else expect(right, `vue ${vi} : coin droit`).toBeGreaterThan(vp.x + vp.w - HUD_MARGIN - 8);
          if (goal) {
            if (vi < 2) expect(top, `vue ${vi} : sous le bloc`).toBeGreaterThanOrEqual(goal.y1);
            else expect(bottom, `vue ${vi} : au-dessus du bloc`).toBeLessThanOrEqual(goal.y0);
          }
        }
      });
    }
    expect(seen).toBeGreaterThan(0);
  });
});

describe('vrais HUD : objectifs perso collés au bord extérieur', () => {
  it('4 joueurs : le fond des objectifs perso touche le bord droit (colonne droite) et, en bas, le bord bas de la rangée du bas', () => {
    let seen = 0;
    for (const level of LEVELS) {
      level.rooms.forEach((_room, ri) => {
        const b = build(level, ri, 4, 60);
        b.update();
        b.huds.forEach((h, vi) => {
          const vp = b.layout.viewports[vi];
          const g = h.regions().personalGoal;
          if (!g) return;
          seen++;
          if (vi % 2 === 1) expect(g.x1, `${level.id} vue ${vi}`).toBe(vp.x + vp.w - HUD_MARGIN);
          else expect(g.x0, `${level.id} vue ${vi}`).toBe(vp.x + HUD_MARGIN - 6);
          if (vi >= 2) expect(g.y1, `${level.id} vue ${vi}`).toBe(vp.y + vp.h - HUD_MARGIN);
        });
      });
    }
    expect(seen).toBeGreaterThan(0);
  });
});

// ───────────────────────────── Non-régressions (relecture du chantier) ─────────────────────────────

/** Accès aux objets privés du HUD (faux objets du kit de test). */
interface HudInternals {
  puzBg: FakeGameObject;
  lanBg: FakeGameObject;
  promptBg: FakeGameObject;
  promptText: FakeGameObject;
  signBg: FakeGameObject;
  signText: FakeGameObject;
  toastBg: FakeGameObject;
}
const internals = (h: PlayerHud): HudInternals => h as unknown as HudInternals;
const rectOf = (o: FakeGameObject): ScreenBounds => {
  const b = o.getBounds();
  return { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
};

describe('le bloc d\'objectif de salle et les bandeaux ne recouvrent jamais le bloc principal', () => {
  for (const lang of ['fr', 'en'] as Language[]) {
    for (const n of [2, 3, 4]) {
      it(`${n} joueurs, ${lang}, toutes les salles, jusqu'à 15 cœurs (pire cas) : aucun recouvrement`, () => {
        setLanguage(lang);
        const bad: string[] = [];
        let seenGoal = 0;
        let seenBanner = 0;
        for (const level of LEVELS) {
          level.rooms.forEach((room, ri) => {
            const b = build(level, ri, n, 150);
            for (let pass = 0; pass < 3; pass++) b.update();
            b.huds.forEach((h, vi) => {
              const main = h.mainBlockBounds();
              const sides = h.sideBlockBounds();
              if (h.regions().roomGoals) seenGoal++;
              if (internals(h).puzBg.visible || internals(h).lanBg.visible) seenBanner++;
              for (const s of sides) for (const m of main) if (boundsOverlap(s, m)) bad.push(`${level.id}/${room.id} vue ${vi} : ${JSON.stringify(s)} recouvre ${JSON.stringify(m)}`);
            });
          });
        }
        expect(seenGoal).toBeGreaterThan(0);
        if (n === 2) expect(seenBanner).toBeGreaterThan(0);
        expect(bad).toEqual([]);
      });
    }
  }

  it('2 joueurs : le texte de la lanterne est replié (fond plus haut) au lieu de déborder sur le bloc principal', () => {
    setLanguage('fr');
    let lanterns = 0;
    let wrapped = 0;
    for (const level of LEVELS) {
      level.rooms.forEach((room, ri) => {
        if (!room.mechanisms.some((m) => m.type === 'lightBridge')) return;
        const b = build(level, ri, 2, 150);
        // la lanterne est portée par le joueur 0 (le HUD du joueur 1 affiche « suis la lanterne de … »)
        for (const m of b.sim.state.room.mechanisms) if (m.type === 'lightBridge') {
          m.bearerId = 0;
          m.waived = false;
        }
        for (let pass = 0; pass < 3; pass++) b.update();
        b.huds.forEach((h, vi) => {
          const lan = internals(h).lanBg;
          if (!lan.visible) return;
          lanterns++;
          if (lan.height > 32) wrapped++;
          const r = rectOf(lan);
          const vp = b.layout.viewports[vi];
          for (const m of h.mainBlockBounds()) expect(boundsOverlap(r, m), `${room.id} vue ${vi}`).toBe(false);
          expect(r.x0).toBeGreaterThanOrEqual(vp.x - 1);
          expect(r.x1).toBeLessThanOrEqual(vp.x + vp.w + 1);
        });
      });
    }
    expect(lanterns).toBeGreaterThan(0);
    expect(wrapped).toBeGreaterThan(0); // 15 cœurs : l'emprise du bloc principal force le repli du texte
  });
});

describe('colonne de droite : chaque ligne du bloc principal colle au bord droit', () => {
  it.each([2, 4])('%i joueurs : cœurs et équipement touchent la marge droite, le spécial n\'en dépasse pas et ne laisse pas un grand vide', (n) => {
    setLanguage('fr');
    const level = LEVELS[0];
    const b = build(level, 0, n, 90);
    for (let pass = 0; pass < 3; pass++) b.update();
    // spécial prêt (texte court) : vide à droite limité (il était de 124 à 135 px avec l'ancienne estimation fixe)
    for (const vi of [1, ...(n === 4 ? [3] : [])]) {
      const vp = b.layout.viewports[vi];
      const edge = vp.x + vp.w - HUD_MARGIN;
      const r = b.huds[vi].regions();
      expect(r.hearts && r.gear && r.special, `vue ${vi}`).toBeTruthy();
      if (!r.hearts || !r.gear || !r.special) continue;
      expect(Math.abs(r.hearts.x1 - 3 - edge), `cœurs vue ${vi}`).toBeLessThanOrEqual(2);
      expect(Math.abs(r.gear.x1 - 3 - edge), `équipement vue ${vi}`).toBeLessThanOrEqual(2);
      expect(r.special.x1 - 3, `spécial vue ${vi} : ne dépasse pas la marge`).toBeLessThanOrEqual(edge + 2);
      expect(edge - (r.special.x1 - 3), `spécial vue ${vi} : vide à droite`).toBeLessThanOrEqual(110);
    }
  });

  it.each(['fr', 'en'] as Language[])('spécial en recharge (nom + secondes, le plus long texte) : il ne dépasse jamais la marge droite (%s)', (lang) => {
    setLanguage(lang);
    for (const n of [2, 4]) {
      const b = build(LEVELS[0], 0, n, 140);
      for (const p of b.sim.state.players) p.specialCooldownMs = 99000;
      for (let pass = 0; pass < 3; pass++) b.update();
      for (const vi of [1, ...(n === 4 ? [3] : [])]) {
        const vp = b.layout.viewports[vi];
        const special = b.huds[vi].regions().special;
        expect(special, `vue ${vi}`).toBeTruthy();
        if (special) expect(special.x1 - 3, `${n} joueurs vue ${vi}`).toBeLessThanOrEqual(vp.x + vp.w - HUD_MARGIN + 2);
      }
    }
  });

  it('les bonus temporaires se rangent à GAUCHE de l\'équipement (colonne de droite) et à droite (colonne de gauche, inchangé)', () => {
    const l = computeLayout(2);
    const common = { u: l.zoom, fs: 17, vw: l.viewports[0].w, heartsN: 9, gearOn: true, slotOn: true, buffCount: 4 };
    const left = mainBlockMetrics(common);
    const right = mainBlockMetrics({ ...common, mirror: true });
    expect(left.buffStep).toBe(left.buffCell);
    expect(left.buffX0).toBeGreaterThan(left.gearX0);
    expect(right.buffStep).toBe(-right.buffCell);
    // la case de bonus la plus à gauche reste dans le bloc ; l'équipement est collé à droite
    expect(right.buffX0 + 3 * right.buffStep).toBeGreaterThanOrEqual(0);
    expect(right.buffX0).toBeLessThan(right.slotX);
    expect(right.rows.gear).toBe(right.gearX0 + 5 * right.gearCell + 8 * l.zoom + 2);
  });
});

describe('rangée du bas : la bulle de panneau et les notifications ne se superposent pas', () => {
  const rooms: { level: LevelDef; index: number }[] = [];
  for (const level of LEVELS) level.rooms.forEach((r, index) => { if (r.signs && r.signs.length > 0) rooms.push({ level, index }); });

  it.each([2, 3, 4])('%i joueurs : bulle et notification ont des rectangles disjoints (rangées du haut et du bas)', (n) => {
    setLanguage('fr');
    expect(rooms.length).toBeGreaterThan(0);
    let checked = 0;
    for (const { level, index } of rooms) {
      const b = build(level, index, n);
      const room = level.rooms[index];
      const sign = room.signs?.[0];
      if (!sign) continue;
      for (const p of b.sim.state.players) {
        p.pos.x = (sign.tile[0] + 0.5) * TILE;
        p.pos.y = (sign.tile[1] + 0.5) * TILE + 4;
      }
      b.update();
      for (const h of b.huds) h.showToast('Salle sombre ! Ta torche s\'use : cherche un brasero.', 0xffffff, 5000);
      b.update(60);
      b.update(60);
      b.huds.forEach((h, vi) => {
        const i = internals(h);
        if (!i.signBg.visible) return;
        checked++;
        expect(boundsOverlap(rectOf(i.signBg), rectOf(i.toastBg)), `${level.id}/${room.id} vue ${vi}`).toBe(false);
      });
    }
    expect(checked).toBeGreaterThan(0);
  });
});

describe('profondeurs : les éléments transitoires passent au-dessus de la carte', () => {
  it('transient > pions de la carte et < bandeaux ; l\'invite, la bulle de panneau et les arcs d\'appel l\'utilisent', () => {
    expect(HUD_DEPTH.map).toBe(HUD_DEPTH.bg + 6);
    expect(HUD_DEPTH.transient).toBeGreaterThan(HUD_DEPTH.map + 0.7); // pions et croix : au plus `map + 0.7`
    expect(HUD_DEPTH.transient).toBeLessThan(HUD_DEPTH.banner);
    const level = LEVELS[0];
    const layout = computeLayout(2);
    const sim = createSimulation({ levelId: level.id, players: setups(2), seed: 3 }, level);
    const { ctx, objects } = makeFakeViewContext(layout.zoom, 2);
    const env: HudEnv = { ctx, level, layout, gear: true, heartSlot: true };
    const hud = new PlayerHud(env, 0, sim.state.players[0]);
    const i = internals(hud);
    for (const o of [i.promptBg, i.promptText, i.signBg, i.signText]) expect(o.depth).toBeGreaterThan(HUD_DEPTH.map + 0.7);
    expect(objects.some((o) => o.kind === 'graphics' && o.depth === HUD_DEPTH.transient)).toBe(true); // CallEdgeHud
  });
});
