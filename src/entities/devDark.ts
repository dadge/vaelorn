/**
 * Paramètre de DÉVELOPPEMENT `?dark=1` : force `dark: true` sur toutes les salles du niveau chargé afin de tester
 * visuellement les salles sombres (obscurité, torches, braseros) sans modifier les données de niveaux.
 *
 *  - `forceDarkLevel` renvoie un CLONE du LevelDef (les définitions d'origine ne sont jamais mutées) ;
 *  - si une salle forcée sombre n'a aucun brasero, un brasero virtuel ALLUMÉ est ajouté près des points d'apparition
 *    (uniquement quand `addVirtualBrazier` est vrai : GameScene ne le demande qu'en mode DEV, `import.meta.env.DEV`),
 *    pour qu'on puisse toujours recharger sa torche pendant les tests.
 *
 * Fonctions pures (aucune dépendance à Phaser), testées sous Node.
 */
import { RoomGrid } from '../core/grid';
import type { BrazierDef, LevelDef, MechanismDef, RoomDef, TileXY } from '../core/types';

/** Identifiant du brasero virtuel ajouté par `?dark=1`. */
export const DEV_BRAZIER_ID = 'dev_brazier';

/** `?dark=1` (ou `dark=true`) présent dans la chaîne de requête ? */
export function isDevDarkRequested(search: string): boolean {
  try {
    const v = new URLSearchParams(search).get('dark');
    return v === '1' || v === 'true';
  } catch {
    return false;
  }
}

/** Tuiles occupées par les mécanismes, décors, panneaux et sortie (à éviter pour poser le brasero virtuel). */
function occupiedTiles(room: RoomDef): Set<string> {
  const occ = new Set<string>();
  const add = (tx: number, ty: number): void => {
    occ.add(`${tx},${ty}`);
  };
  for (const m of room.mechanisms) {
    switch (m.type) {
      case 'door':
        for (const t of m.tiles) add(t[0], t[1]);
        break;
      case 'block':
      case 'socket':
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) add(m.tile[0] + dx, m.tile[1] + dy);
        break;
      case 'runePuzzle':
        add(m.displayTile[0], m.displayTile[1]);
        for (const p of m.pedestals) add(p.tile[0], p.tile[1]);
        break;
      case 'statuePair':
        for (const st of m.statues) {
          add(st.tile[0], st.tile[1]);
          add(st.standTile[0], st.standTile[1]);
        }
        break;
      case 'hourglass':
        add(m.displayTile[0], m.displayTile[1]);
        for (const t of m.levers) add(t[0], t[1]);
        for (const t of m.gate) add(t[0], t[1]);
        break;
      case 'lightBridge':
        for (const t of m.tiles) add(t[0], t[1]);
        break;
      default:
        add(m.tile[0], m.tile[1]);
    }
  }
  for (const d of room.decor ?? []) add(d.tile[0], d.tile[1]);
  for (const s of room.signs ?? []) add(s.tile[0], s.tile[1]);
  for (const s of room.playerSpawns) add(s[0], s[1]);
  const er = room.exit.rect;
  for (let y = er.y; y < er.y + er.h; y++) for (let x = er.x; x < er.x + er.w; x++) add(x, y);
  return occ;
}

/**
 * Cherche une tuile praticable et libre proche du premier point d'apparition (anneaux de rayon croissant).
 * Retourne `null` si la salle n'offre aucune tuile libre.
 */
export function findBrazierTile(room: RoomDef): TileXY | null {
  const grid = new RoomGrid(room.layout);
  const occ = occupiedTiles(room);
  const origin = room.playerSpawns[0] ?? [Math.floor(grid.width / 2), Math.floor(grid.height / 2)];
  const maxR = Math.max(grid.width, grid.height);
  for (let r = 2; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const tx = origin[0] + dx;
        const ty = origin[1] + dy;
        if (grid.blocksMovement(tx, ty) || occ.has(`${tx},${ty}`)) continue;
        // évite de coller le brasero à un mur de tous côtés (reste accessible) : au moins 2 voisins praticables
        let free = 0;
        if (!grid.blocksMovement(tx + 1, ty)) free++;
        if (!grid.blocksMovement(tx - 1, ty)) free++;
        if (!grid.blocksMovement(tx, ty + 1)) free++;
        if (!grid.blocksMovement(tx, ty - 1)) free++;
        if (free >= 2) return [tx, ty];
      }
    }
  }
  return null;
}

/** Salle forcée sombre (clone) ; ajoute un brasero virtuel allumé si aucun brasero n'existe et que demandé. */
export function forceDarkRoom(room: RoomDef, addVirtualBrazier: boolean): RoomDef {
  const hasBrazier = room.mechanisms.some((m) => m.type === 'brazier');
  let mechanisms: MechanismDef[] = room.mechanisms;
  if (addVirtualBrazier && !hasBrazier) {
    const tile = findBrazierTile(room);
    if (tile) {
      const brazier: BrazierDef = { id: DEV_BRAZIER_ID, type: 'brazier', tile, lit: true };
      mechanisms = [...room.mechanisms, brazier];
    }
  }
  return { ...room, dark: true, mechanisms };
}

/**
 * Clone du niveau avec `dark: true` sur toutes les salles (voir l'en-tête du module).
 * @param addVirtualBrazier ajoute un brasero allumé virtuel aux salles qui n'en ont pas (DEV uniquement)
 */
export function forceDarkLevel(level: LevelDef, addVirtualBrazier: boolean): LevelDef {
  return { ...level, rooms: level.rooms.map((r) => forceDarkRoom(r, addVirtualBrazier)) };
}

/**
 * Le paramètre `?dark=1` est-il pris en compte ? Seulement en mode DEV (`dev`) ou avec `?debug=1` (comme `window.__vaelorn`) :
 * jamais dans une partie normale en production.
 */
export function isDevDarkAllowed(search: string, dev: boolean): boolean {
  if (!isDevDarkRequested(search)) return false;
  if (dev) return true;
  try {
    const d = new URLSearchParams(search).get('debug');
    return d === '1' || d === 'true';
  } catch {
    return false;
  }
}
