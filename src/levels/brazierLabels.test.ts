/**
 * AUDIT des libellés de braseros (tous les niveaux, la salle du tutoriel comprise) : un brasero qui peut être allumé en jeu
 * (non allumé au départ) doit changer de libellé une fois allumé (`litLabelKey`), pour ne plus afficher « éteint » / « à allumer ».
 */
import { describe, expect, it } from 'vitest';
import { collectRequiredI18nKeys } from '../core/levelValidation';
import type { BrazierDef, LevelDef, RoomDef } from '../core/types';
import { DEV_TEST_KINDS, buildDevTestLevel } from '../entities/devRooms';
import { getDictionary } from '../i18n/i18n';
import { LEVELS } from './index';
import { tutorialLevel } from './tutorial';

const ALL_LEVELS: readonly LevelDef[] = [...LEVELS, tutorialLevel, ...DEV_TEST_KINDS.map((k) => buildDevTestLevel(k))];
const fr = getDictionary('fr');
const en = getDictionary('en');

interface Found {
  where: string;
  room: RoomDef;
  def: BrazierDef;
}

function allBraziers(): Found[] {
  const out: Found[] = [];
  for (const l of ALL_LEVELS) {
    for (const room of l.rooms) {
      for (const def of room.mechanisms) if (def.type === 'brazier') out.push({ where: `${l.id}/${room.id}/${def.id}`, room, def });
    }
  }
  return out;
}

const unlit = allBraziers().filter((b) => b.def.lit !== true);
const lit = allBraziers().filter((b) => b.def.lit === true);

/** Verbe anglais de recharge (refuel / refill) d'un libellé. */
function enVerb(s: string): string | undefined {
  return /refuel|refill/i.exec(s)?.[0].toLowerCase();
}

/** Libellé sans sa parenthèse finale : « Brasero bleu (à allumer) » -> « Brasero bleu » (la couleur reste dans le texte). */
function stem(s: string): string {
  return s.replace(/\s*\(.*\)\s*$/, '').trim();
}

describe('audit des braseros : recensement', () => {
  it("les niveaux contiennent bien des braseros éteints au départ (au moins 24 aujourd'hui ; chacun est audité ci-dessous) et des braseros allumés", () => {
    expect(unlit.length).toBeGreaterThanOrEqual(24);
    expect(lit.length).toBeGreaterThan(50);
  });
});

describe('audit des braseros non allumés au départ : libellé « allumé »', () => {
  it.each(unlit.map((b) => [b.where, b] as const))("%s : litLabelKey défini, présent en fr et en, différent du libellé d'éteint", (_w, b) => {
    const { def } = b;
    const lk = def.litLabelKey as string;
    expect(def.labelKey, "labelKey (libellé d'éteint)").toBeTruthy();
    expect(lk, 'litLabelKey').toBeTruthy();
    expect(lk).not.toBe(def.labelKey);
    for (const [lang, dict] of [['fr', fr], ['en', en]] as const) {
      expect(dict[lk]?.trim(), `${lang} : ${lk}`).toBeTruthy();
    }
    // le libellé « allumé » ne parle plus d'allumer ni d'éteint
    expect(fr[lk]).not.toMatch(/éteint|allumer|facultatif/i);
    expect(en[lk]).not.toMatch(/unlit|cold|to light|light it|optional/i);
    // et il dit que le brasero recharge la torche (même forme que les braseros déjà allumés) ; le tutoriel garde son « Brasero allumé »
    if (!b.where.startsWith('tutorial/')) {
      expect(fr[lk]).toMatch(/recharge/i);
      expect(en[lk]).toMatch(/refuel|refill/i);
    }
  });

  it.each(unlit.filter((b) => b.def.ownerSlot === undefined).map((b) => [b.where, b] as const))(
    '%s : brasero « neutre » = exactement le libellé des braseros déjà allumés de la même salle',
    (_w, b) => {
      const sameRoomLit = lit.filter((l) => l.room.id === b.room.id && l.def.labelKey).map((l) => l.def.labelKey);
      expect(sameRoomLit, 'salle sans brasero allumé de référence').not.toHaveLength(0);
      expect(sameRoomLit).toContain(b.def.litLabelKey);
    },
  );

  it.each(unlit.filter((b) => b.def.ownerSlot !== undefined).map((b) => [b.where, b] as const))(
    '%s : brasero de couleur = même couleur dans le libellé « allumé » (fr et en)',
    (_w, b) => {
      const k = b.def.labelKey as string;
      const lk = b.def.litLabelKey as string;
      expect(fr[lk].startsWith(stem(fr[k])), `fr : « ${fr[lk]} » doit commencer par « ${stem(fr[k])} »`).toBe(true);
      expect(en[lk].startsWith(stem(en[k])), `en : « ${en[lk]} » doit commencer par « ${stem(en[k])} »`).toBe(true);
    },
  );

  it.each(unlit.filter((b) => b.def.ownerSlot === undefined).map((b) => [b.where, b] as const))(
    '%s : le verbe anglais (refuel / refill) est celui des braseros allumés de la même salle',
    (_w, b) => {
      const refs = lit
        .filter((l) => l.room.id === b.room.id && l.def.labelKey)
        .map((l) => enVerb(en[l.def.labelKey as string]))
        .filter((v) => v !== undefined);
      if (refs.length === 0) return; // tutoriel : « Brasero allumé », sans verbe
      expect(enVerb(en[b.def.litLabelKey as string])).toBe(refs[0]);
    },
  );

  it.each(unlit.filter((b) => b.def.ownerSlot !== undefined).map((b) => [b.where, b] as const))(
    '%s : le verbe anglais du libellé de couleur est celui du brasero neutre allumé de la salle',
    (_w, b) => {
      const neutral = lit.find((l) => l.room.id === b.room.id && l.def.ownerSlot === undefined && l.def.labelKey);
      expect(neutral, 'salle sans brasero neutre allumé').toBeTruthy();
      expect(enVerb(en[b.def.litLabelKey as string])).toBe(enVerb(en[neutral?.def.labelKey as string]));
    },
  );

  it("les quatre braseros de couleur d'une même salle ont quatre libellés « allumé » distincts", () => {
    const byRoom = new Map<string, Set<string>>();
    for (const b of unlit.filter((x) => x.def.ownerSlot !== undefined)) {
      const set = byRoom.get(b.room.id) ?? new Set<string>();
      set.add(fr[b.def.litLabelKey as string]);
      byRoom.set(b.room.id, set);
    }
    expect(byRoom.size).toBe(4);
    for (const set of byRoom.values()) expect(set.size).toBe(4);
  });
});

describe('audit des braseros allumés au départ', () => {
  it("repli explicite : sans litLabelKey, labelKey reste (déjà un libellé « recharge ») ; sinon litLabelKey valide", () => {
    for (const b of lit) {
      if (b.def.litLabelKey !== undefined) {
        expect(fr[b.def.litLabelKey], b.where).toBeTruthy();
        expect(en[b.def.litLabelKey], b.where).toBeTruthy();
      } else if (b.def.labelKey) {
        // aucun brasero allumé ne doit afficher « éteint / à allumer »
        expect(fr[b.def.labelKey], b.where).not.toMatch(/éteint|à allumer/i);
        expect(en[b.def.labelKey], b.where).not.toMatch(/unlit|cold|to light/i);
      }
    }
  });
});

describe('audit : clés i18n et objectifs', () => {
  it('chaque litLabelKey est listé par collectRequiredI18nKeys (donc validé fr+en par validateLevel)', () => {
    for (const l of ALL_LEVELS) {
      const keys = new Set(collectRequiredI18nKeys(l).map((r) => r.key));
      for (const room of l.rooms) {
        for (const m of room.mechanisms) if (m.type === 'brazier' && m.litLabelKey) expect(keys.has(m.litLabelKey), `${l.id}/${room.id}/${m.id}`).toBe(true);
      }
    }
  });

  it("seule la salle sombre du tutoriel exige un brasero pour sa sortie (sa ligne d'objectif suit alors le libellé courant du brasero)", () => {
    const required: string[] = [];
    for (const l of ALL_LEVELS) {
      for (const room of l.rooms) {
        const ids = new Set(room.mechanisms.filter((m) => m.type === 'brazier').map((m) => m.id));
        for (const req of room.exit.requires) if (ids.has(req)) required.push(`${l.id}/${room.id}/${req}`);
      }
    }
    expect(required).toEqual(['tutorial/t_dark/br_b']);
  });
});
