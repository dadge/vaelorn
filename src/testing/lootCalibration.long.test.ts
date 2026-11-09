/**
 * Calibrage LONG des sources de vie (à lancer À LA DEMANDE, ignoré par `npm test` : sans `LOOT_CALIB`, tous les tests sont « skipped »).
 *
 * Joue des niveaux complets avec des bots, avec et sans sources de vie, pour plusieurs graines, et écrit un résultat JSON par partie
 * (une ligne par partie) puis un tableau avant / après lisible dans la console (une ligne par niveau et nombre de joueurs).
 *
 * Usage (PowerShell) :
 *   $env:LOOT_CALIB='1'; $env:LOOT_CALIB_LEVELS='3,4'; $env:LOOT_CALIB_PLAYERS='1,4'; $env:LOOT_CALIB_SEEDS='7,11,13,17,19'
 *   $env:LOOT_CALIB_OUT='C:\temp\calib.jsonl'; npx vitest run src/testing/lootCalibration.long.test.ts
 * Variables : LOOT_CALIB (obligatoire), LOOT_CALIB_LEVELS (défaut 1..6), LOOT_CALIB_PLAYERS (défaut 1,4), LOOT_CALIB_SEEDS (défaut 7,11,13,17,19),
 * LOOT_CALIB_OUT (fichier .jsonl, ajouté en fin ; défaut : console seulement), LOOT_CALIB_EAT_RADIUS (rayon de repérage des bots, px, défaut 160),
 * LOOT_CALIB_EAT_BELOW (seuil de PV de la brique de ramassage, défaut 0,7), LOOT_CALIB_EAT=0 (bots « passifs » : ils ne ramassent que par contact fortuit).
 * Un test par (niveau, joueurs, graine) : vitest reprend la main entre deux parties (sinon « Timeout calling onTaskUpdate »).
 * Les bots sont un PROXY (pas de vraie esquive) : voir l'en-tête de `lootCalibration.ts`. Une partie « non terminée » est un script de bot
 * désynchronisé (pas une défaite du jeu) : elle est comptée dans « finis » et exclue de la durée.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, describe, it } from 'vitest';
import { aggregate, CALIB_LEVELS, measureRun, type CalibResult } from './lootCalibration';

const env = process.env;
const ON = !!env.LOOT_CALIB;
const list = (v: string | undefined, def: string): number[] => (v ?? def).split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x));
const LEVELS = list(env.LOOT_CALIB_LEVELS, '1,2,3,4,5,6');
const PLAYERS = list(env.LOOT_CALIB_PLAYERS, '1,4');
const SEEDS = list(env.LOOT_CALIB_SEEDS, '7,11,13,17,19');
const OUT = env.LOOT_CALIB_OUT;
/** Brique de ramassage des bots : rayon de repérage (px, défaut 160) et seuil de PV (défaut 0,7). */
const EAT = {
  ...(env.LOOT_CALIB_EAT === '0' ? { eat: false } : {}),
  ...(env.LOOT_CALIB_EAT_RADIUS ? { eatRadius: Number(env.LOOT_CALIB_EAT_RADIUS) } : {}),
  ...(env.LOOT_CALIB_EAT_BELOW ? { eatBelowFrac: Number(env.LOOT_CALIB_EAT_BELOW) } : {}),
};

function f(x: number, d = 1): string {
  return x.toFixed(d);
}

/** Résultats cumulés par groupe « niveau|joueurs » puis par mode. */
const groups = new Map<string, Record<'off' | 'on', CalibResult[]>>();

describe.skipIf(!ON)('calibrage long des sources de vie (à la demande)', () => {
  afterAll(() => {
    for (const [key, rows] of groups) {
      const [no, n] = key.split('|');
      const a = aggregate(rows.off);
      const b = aggregate(rows.on);
      console.info(
        `[calib N${no} x${n}] sans : ${a.completed}/${a.runs} finis, ${f(a.timeS, 0)} s, ${f(a.wipes, 2)} défaites, ${f(a.hpLostPerRoom)} PV perdus/salle (${f(a.barsPerRoom, 2)} barres)\n` +
          `[calib N${no} x${n}] avec : ${b.completed}/${b.runs} finis, ${f(b.timeS, 0)} s, ${f(b.wipes, 2)} défaites, ${f(b.hpLostPerRoom)} PV perdus/salle (${f(b.barsPerRoom, 2)} barres, <50 % PV ${f(b.lowPct, 1)} % du temps, <25 % ${f(b.criticalPct, 1)} %), ` +
          `${f(b.healed, 0)} PV rendus (nourriture ${f(b.foodHealed, 0)} + cristaux ${f(b.crystalHealed, 0)}), ${f(b.dropsPerKill, 3)} objet/ennemi`,
      );
    }
  });
  for (const no of LEVELS) {
    for (const n of PLAYERS) {
      for (const seed of SEEDS) {
        it(`niveau ${no}, ${n} joueur(s), graine ${seed} : sans / avec sources de vie`, () => {
          const calib = CALIB_LEVELS.find((c) => c.no === no);
          if (!calib) throw new Error(`niveau inconnu ${no}`);
          const g = groups.get(`${no}|${n}`) ?? { off: [], on: [] };
          groups.set(`${no}|${n}`, g);
          for (const loot of [false, true]) {
            const r = measureRun(calib, n, seed, loot, {}, EAT);
            g[loot ? 'on' : 'off'].push(r);
            if (OUT) appendFileSync(OUT, JSON.stringify(r) + '\n');
          }
        }, 600_000);
      }
    }
  }
});
