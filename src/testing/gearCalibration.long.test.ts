/**
 * Calibrage LONG de l'ÉQUIPEMENT (à lancer À LA DEMANDE, ignoré par `npm test` : sans `GEAR_CALIB`, tous les tests sont « skipped »).
 *
 * Joue des niveaux complets avec des bots, avec et sans équipement (butin de vie ACTIF dans les deux modes), pour plusieurs graines, et écrit
 * un résultat JSON par partie (une ligne par partie) puis un tableau avant / après lisible dans la console (deux lignes par niveau et nombre de joueurs).
 *
 * Usage (PowerShell) :
 *   $env:GEAR_CALIB='1'; $env:GEAR_CALIB_LEVELS='1,3,4'; $env:GEAR_CALIB_PLAYERS='1,4'; $env:GEAR_CALIB_SEEDS='7,11,13,17,19'
 *   $env:GEAR_CALIB_OUT='C:\temp\gear.jsonl'; npx vitest run src/testing/gearCalibration.long.test.ts
 * Variables : GEAR_CALIB (obligatoire), GEAR_CALIB_LEVELS (défaut 1..6), GEAR_CALIB_PLAYERS (défaut 1,4), GEAR_CALIB_SEEDS (défaut 7,11,13,17,19),
 * GEAR_CALIB_OUT (fichier .jsonl, ajouté en fin ; défaut : console seulement), GEAR_CALIB_RADIUS (rayon de repérage des bots pour l'équipement, px, défaut 140),
 * GEAR_CALIB_TUNE (exploration : JSON qui REMPLACE à chaud des tableaux / objets de `balance.ts`, ex. '{"GEAR_SLOT_WEIGHTS":{"weapon":0},"GEAR_LEVEL_WEIGHTS":[60,30,10]}' ;
 * les constantes numériques simples ne sont pas modifiables : les éditer dans `balance.ts`),
 * GEAR_CALIB_SKIP_OFF=1 (ne rejoue pas la référence « sans équipement » : à utiliser avec un fichier de référence déjà mesuré).
 * Un test par (niveau, joueurs, graine) : vitest reprend la main entre deux parties (sinon « Timeout calling onTaskUpdate »).
 * Les bots sont un PROXY (pas de vraie esquive) : voir l'en-tête de `gearCalibration.ts`. Une partie « non terminée » est un script de bot
 * désynchronisé (pas une défaite du jeu) : elle est comptée dans « finis » et exclue de la durée.
 */
import { appendFileSync } from 'node:fs';
import { afterAll, describe, it } from 'vitest';
import * as balance from '../core/balance';
import { aggregateGear, CALIB_LEVELS, measureGearRun, type GearAggregate, type GearRunResult } from './gearCalibration';

const env = process.env;
const ON = !!env.GEAR_CALIB;
const list = (v: string | undefined, def: string): number[] => (v ?? def).split(',').map((s) => Number(s.trim())).filter((x) => Number.isFinite(x));
const LEVELS = list(env.GEAR_CALIB_LEVELS, '1,2,3,4,5,6');
const PLAYERS = list(env.GEAR_CALIB_PLAYERS, '1,4');
const SEEDS = list(env.GEAR_CALIB_SEEDS, '7,11,13,17,19');
const OUT = env.GEAR_CALIB_OUT;
const BG = env.GEAR_CALIB_RADIUS ? { gearRadius: Number(env.GEAR_CALIB_RADIUS) } : {};
const SKIP_OFF = env.GEAR_CALIB_SKIP_OFF === '1';

/** Réglages d'exploration (voir l'en-tête) : modifie en place les tableaux et objets de `balance.ts` (jamais utilisé hors de ce script). */
if (env.GEAR_CALIB_TUNE) {
  const tune = JSON.parse(env.GEAR_CALIB_TUNE) as Record<string, unknown>;
  const mod = balance as unknown as Record<string, unknown>;
  for (const [k, v] of Object.entries(tune)) {
    const target = mod[k];
    if (Array.isArray(target) && Array.isArray(v)) v.forEach((x, i) => ((target as unknown[])[i] = x));
    else if (target && typeof target === 'object' && v && typeof v === 'object') Object.assign(target, v);
    else throw new Error(`GEAR_CALIB_TUNE : ${k} n'est pas un tableau ni un objet modifiable`);
  }
}

const f = (x: number, d = 1): string => x.toFixed(d);

/** Une ligne lisible pour un agrégat. */
export function formatAggregate(label: string, a: GearAggregate): string {
  return (
    `${label} ${a.completed}/${a.runs} finis, ${f(a.timeS, 0)} s, ${f(a.wipes, 2)} défaites (boss ${f(a.bossWipes, 2)}), ${f(a.hpLostPerRoom)} PV perdus/salle, ` +
    `<50 % PV ${f(a.lowPct, 1)} %, <25 % ${f(a.criticalPct, 1)} %, à terre ${f(a.downs, 1)}` +
    (a.dropsPerRun > 0
      ? ` | ${f(a.dropsPerRoomPerHero, 2)} objet/salle/héros (${f(a.dropsPerRun, 1)}/partie), bonus ${f(a.buffDropsPerRoomPerHero, 2)}, ramassés ${f(a.picked, 1)}, ` +
        `pertes ${f(a.lossEvents, 1)} chutes / ${f(a.lostItems, 1)} pièces, puissance ${f(a.power, 2)} ` +
        `(milieu ${f(a.mid.pieces, 1)} pièces niv ${f(a.mid.avgLevel, 1)} P${f(a.mid.power, 2)} ; 4e ${f(a.fourth.pieces, 1)} P${f(a.fourth.power, 2)} ; fin ${f(a.end.pieces, 1)} niv ${f(a.end.avgLevel, 1)} P${f(a.end.power, 2)})`
      : '')
  );
}

const groups = new Map<string, Record<'off' | 'on', GearRunResult[]>>();

describe.skipIf(!ON)('calibrage long de l\'équipement (à la demande)', () => {
  afterAll(() => {
    for (const [key, rows] of groups) {
      const [no, n] = key.split('|');
      if (rows.off.length > 0) console.info(formatAggregate(`[gear N${no} x${n}] sans :`, aggregateGear(rows.off)));
      console.info(formatAggregate(`[gear N${no} x${n}] avec :`, aggregateGear(rows.on)));
    }
  });
  for (const no of LEVELS) {
    for (const n of PLAYERS) {
      for (const seed of SEEDS) {
        it(`niveau ${no}, ${n} joueur(s), graine ${seed} : sans / avec équipement`, () => {
          const calib = CALIB_LEVELS.find((c) => c.no === no);
          if (!calib) throw new Error(`niveau inconnu ${no}`);
          const g = groups.get(`${no}|${n}`) ?? { off: [], on: [] };
          groups.set(`${no}|${n}`, g);
          for (const gear of SKIP_OFF ? [true] : [false, true]) {
            const r = measureGearRun(calib, n, seed, gear, {}, BG);
            g[gear ? 'on' : 'off'].push(r);
            if (OUT) appendFileSync(OUT, JSON.stringify(r) + '\n');
          }
        }, 600_000);
      }
    }
  }
});
