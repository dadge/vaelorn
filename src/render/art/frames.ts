/**
 * Registre : fusionne toutes les familles de sprites en un dictionnaire nom → Bitmap.
 * Détecte les doublons de nom (erreur) : chaque frame a un seul auteur.
 */
import type { Bitmap } from './bitmap';
import { buildBossFrames } from './bosses';
import { buildBoss46Frames } from './bosses46';
import { buildDecorFrames } from './decor';
import { buildEnemyFrames } from './enemies';
import { buildFxFrames } from './fx';
import { buildHeroFrames } from './heroes';
import { buildLightFrames } from './light';
import { buildKeyIcons, buildMechanismFrames } from './mechanisms';
import { buildMechanism46Frames } from './mechanisms46';
import { buildTileFrames } from './tiles';
import { buildUiFrames } from './ui';

export function buildAllFrames(): Record<string, Bitmap> {
  const all: Record<string, Bitmap> = {};
  const families: Array<Record<string, Bitmap>> = [
    buildHeroFrames(),
    buildEnemyFrames(),
    buildBossFrames(),
    buildBoss46Frames(),
    buildTileFrames(),
    buildMechanismFrames(),
    buildMechanism46Frames(),
    buildDecorFrames(),
    buildFxFrames(),
    buildUiFrames(),
    buildKeyIcons(),
    buildLightFrames(),
  ];
  for (const fam of families) {
    for (const [name, bm] of Object.entries(fam)) {
      if (all[name]) throw new Error(`frame en double : ${name}`);
      all[name] = bm;
    }
  }
  return all;
}
