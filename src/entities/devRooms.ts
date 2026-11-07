/**
 * Paramètre de DÉVELOPPEMENT `?dev=statues|hourglass|bridge|bosses` : remplace le niveau chargé par une petite salle de test
 * qui montre un mécanisme ou des ennemis des niveaux 4-6 (rendu à vérifier à l'œil, sans attendre les vrais niveaux).
 *
 *  - statues   : deux statues jumelles et leurs socles (thème frost) ;
 *  - hourglass : sablier partagé, leviers et herse de trois tuiles (thème ember) ;
 *  - bridge    : pont de lumière sur un gouffre, salle SOMBRE avec un brasero (thème void) ;
 *  - bosses    : les trois demi-boss et les trois boss dans une grande salle (thème frost).
 *
 * Même garde que `?dark=1` : seulement en mode DEV ou avec `?debug=1`. Fonctions pures (aucune dépendance à Phaser).
 */
import type { LevelDef, MechanismDef, RoomDef, TileXY } from '../core/types';
import type { ZoneTheme } from '../core/types';

export const DEV_TEST_KINDS = ['statues', 'hourglass', 'bridge', 'bosses'] as const;
export type DevTestKind = (typeof DEV_TEST_KINDS)[number];

/** Valeur de `?dev=` si c'est un type de salle de test connu, sinon null. */
export function devTestRequested(search: string): DevTestKind | null {
  try {
    const v = new URLSearchParams(search).get('dev');
    return (DEV_TEST_KINDS as readonly string[]).includes(v ?? '') ? (v as DevTestKind) : null;
  } catch {
    return null;
  }
}

/** `?dev=<type>` pris en compte : seulement en mode DEV (`dev`) ou avec `?debug=1`. */
export function devTestKind(search: string, dev: boolean): DevTestKind | null {
  const kind = devTestRequested(search);
  if (!kind) return null;
  if (dev) return kind;
  try {
    const d = new URLSearchParams(search).get('debug');
    return d === '1' || d === 'true' ? kind : null;
  } catch {
    return null;
  }
}

/** Grille `w`×`h` bordée de murs, remplie de sol ; `paint(x, y)` peut remplacer un glyphe intérieur. */
function layout(w: number, h: number, paint?: (x: number, y: number) => string | undefined): string[] {
  const rows: string[] = [];
  for (let y = 0; y < h; y++) {
    let row = '';
    for (let x = 0; x < w; x++) {
      if (x === 0 || y === 0 || x === w - 1 || y === h - 1) row += '#';
      else row += paint?.(x, y) ?? '.';
    }
    rows.push(row);
  }
  return rows;
}

const SPAWNS = (x: number, y: number): TileXY[] => [
  [x, y],
  [x + 1, y],
  [x, y + 1],
  [x + 1, y + 1],
];

function room(id: string, theme: ZoneTheme, over: Partial<RoomDef> & Pick<RoomDef, 'layout' | 'playerSpawns' | 'exit'>): RoomDef {
  return { id, nameKey: `dev.room.${id}`, theme, enemies: [], mechanisms: [], ...over };
}

function statuesRoom(): RoomDef {
  const mechanisms: MechanismDef[] = [
    {
      id: 'statues',
      type: 'statuePair',
      statues: [
        { tile: [6, 4], standTile: [6, 8], facing: 'down' },
        { tile: [15, 4], standTile: [15, 8], facing: 'left' },
      ],
      targetDir: 'up',
      labelKey: 'dev.label.statues',
    },
  ];
  return room('statues', 'frost', {
    layout: layout(22, 12),
    playerSpawns: SPAWNS(10, 8),
    mechanisms,
    exit: { rect: { x: 19, y: 1, w: 2, h: 2 }, requires: ['statues'], final: true },
    decor: [
      { type: 'crystal', tile: [3, 2] },
      { type: 'crystal', tile: [18, 9] },
    ],
  });
}

function hourglassRoom(): RoomDef {
  const mechanisms: MechanismDef[] = [
    {
      id: 'hg',
      type: 'hourglass',
      levers: [
        [9, 5],
        [15, 5],
      ],
      gate: [
        [12, 4],
        [12, 5],
        [12, 6],
      ],
      periodMs: 12000,
      displayTile: [11, 2],
      labelKey: 'dev.label.hourglass',
    },
  ];
  return room('hourglass', 'ember', {
    // un mur central percé d'une brèche de 3 tuiles : c'est la herse
    layout: layout(24, 11, (x, y) => (x === 12 && (y < 4 || y > 6) ? '#' : undefined)),
    playerSpawns: SPAWNS(4, 4),
    mechanisms,
    exit: { rect: { x: 21, y: 4, w: 2, h: 3 }, requires: [], final: true },
    decor: [
      { type: 'torch', tile: [3, 1] },
      { type: 'torch', tile: [20, 1] },
    ],
  });
}

function bridgeRoom(): RoomDef {
  const bridgeTiles: TileXY[] = [];
  for (let x = 6; x <= 17; x++) bridgeTiles.push([x, 4]);
  const mechanisms: MechanismDef[] = [
    { id: 'bridge', type: 'lightBridge', tiles: bridgeTiles, lanternSlot: 0, radiusTiles: 3, labelKey: 'dev.label.bridge' },
    { id: 'br', type: 'brazier', tile: [2, 2], lit: true },
  ];
  return room('bridge', 'void', {
    // gouffre ('~') entre deux plates-formes ; seules les tuiles du pont sont du sol ('.') sous le rendu
    layout: layout(24, 9, (x, y) => (x >= 6 && x <= 17 && y !== 4 ? '~' : undefined)),
    playerSpawns: SPAWNS(2, 4),
    mechanisms,
    exit: { rect: { x: 21, y: 3, w: 2, h: 3 }, requires: [], final: true },
    dark: true,
  });
}

function bossesRoom(): RoomDef {
  return room('bosses', 'frost', {
    layout: layout(34, 18),
    playerSpawns: SPAWNS(16, 14),
    enemies: [
      { kind: 'warden', tile: [6, 4] },
      { kind: 'pyromancer', tile: [16, 3] },
      { kind: 'wraith', tile: [27, 4] },
      { kind: 'frostqueen', tile: [7, 10] },
      { kind: 'forgelord', tile: [17, 9] },
      { kind: 'voidlord', tile: [27, 10] },
    ],
    exit: { rect: { x: 31, y: 15, w: 2, h: 2 }, requires: ['clear'], final: true },
  });
}

/** Niveau de test à une salle (4 objectifs fictifs pour que le HUD fonctionne) pour `?dev=<kind>`. */
export function buildDevTestLevel(kind: DevTestKind): LevelDef {
  const r = kind === 'statues' ? statuesRoom() : kind === 'hourglass' ? hourglassRoom() : kind === 'bridge' ? bridgeRoom() : bossesRoom();
  const mech = r.mechanisms[0]?.id ?? '';
  return {
    id: `dev-${kind}`,
    nameKey: 'dev.level.name',
    theme: r.theme,
    estimatedMinutes: 1,
    intro: [],
    outro: [],
    rooms: [r],
    objectives: [0, 1, 2, 3].map((slot) =>
      mech
        ? { id: `dev-o${slot}`, slot, roomId: r.id, kind: 'mechanism' as const, labelKey: 'dev.objective', mechanismId: mech }
        : { id: `dev-o${slot}`, slot, roomId: r.id, kind: 'kills' as const, labelKey: 'dev.objective', count: 1 },
    ),
  };
}
