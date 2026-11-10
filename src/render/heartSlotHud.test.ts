/**
 * HUD de l'emplacement cœur (logique pure) : frames du cœur d'interface réutilisées, silhouette atténuée quand il est vide, aucun clignotement ; retour visuel de l'usage.
 */
import { describe, expect, it } from 'vitest';
import { LOOT_FULL_HEAL } from '../core/balance';
import { heartFrame } from './art/animations';
import { HEART_SLOT_EMPTY_ALPHA, HEART_SLOT_EMPTY_TINT, HEART_SLOT_BORDER_COLOR, HEART_SLOT_READY_BORDER_COLOR, heartSlotBorderColor, heartSlotHintText, heartSlotSignature, heartSlotView } from './heartSlotHud';
import { heartStoredTextKey, heartUsedFx } from './heartSlotFx';
import { pickupTextColor } from './lifeFx';
import { hasKey, setLanguage, t } from '../i18n/i18n';

describe('heartSlotView', () => {
  it('plein : les frames du cœur d interface (mêmes que les cœurs de PV), aucune teinte, opacité pleine', () => {
    const full = heartSlotView('full');
    const half = heartSlotView('half');
    expect(full).toEqual({ frame: 'ui_heart_full', tint: null, alpha: 1, empty: false });
    expect(half).toEqual({ frame: 'ui_heart_half', tint: null, alpha: 1, empty: false });
    // même dessin que le cœur de PV : un cœur plein / un demi-cœur de la rangée de PV
    expect(full.frame).toBe(heartFrame(0, 10, 10));
    expect(half.frame).toBe(heartFrame(0, 5, 10));
  });

  it('vide (ou valeur inconnue) : silhouette de cœur atténuée et teintée, reconnaissable', () => {
    for (const v of [undefined, 'banana' as never, null as never]) {
      const e = heartSlotView(v);
      expect(e.empty).toBe(true);
      expect(e.frame).toBe('ui_heart_full');
      expect(e.tint).toBe(HEART_SLOT_EMPTY_TINT);
      expect(e.alpha).toBe(HEART_SLOT_EMPTY_ALPHA);
      expect(e.alpha).toBeLessThan(0.5);
      expect(e.alpha).toBeGreaterThan(0.15); // encore visible
    }
  });

  it('aucun clignotement : l aspect ne dépend que du contenu (aucun temps en entrée, mêmes valeurs à chaque appel)', () => {
    expect(heartSlotView('full')).toEqual(heartSlotView('full'));
    expect(heartSlotView(undefined)).toEqual(heartSlotView(undefined));
    expect(heartSlotView.length).toBe(1);
  });

  it('heartSlotSignature : une valeur par contenu, tolérante', () => {
    expect(heartSlotSignature('full')).toBe('full');
    expect(heartSlotSignature('half')).toBe('half');
    expect(heartSlotSignature(undefined)).toBe('-');
    expect(heartSlotSignature('x' as never)).toBe('-');
  });
});

describe('heartSlotBorderColor : rappel fixe quand le cœur rangé peut servir', () => {
  it('doré seulement avec un cœur rangé ET un joueur blessé ; la signature change avec le rappel (redessin), sans horloge', () => {
    expect(heartSlotBorderColor('full', true)).toBe(HEART_SLOT_READY_BORDER_COLOR);
    expect(heartSlotBorderColor('half', true)).toBe(HEART_SLOT_READY_BORDER_COLOR);
    expect(heartSlotBorderColor('full', false)).toBe(HEART_SLOT_BORDER_COLOR);
    expect(heartSlotBorderColor(undefined, true)).toBe(HEART_SLOT_BORDER_COLOR);
    expect(heartSlotSignature('full', true)).not.toBe(heartSlotSignature('full', false));
    expect(heartSlotSignature('full')).toBe('full');
    expect(heartSlotBorderColor.length).toBe(2);
  });
});

describe('heartSlotHintText : le demi-cœur se distingue aussi par un « ½ » (icône minuscule à petite échelle)', () => {
  it('libellé seul si vide ou plein, « ½ » ajouté pour un demi-cœur', () => {
    expect(heartSlotHintText('B', undefined)).toBe('B');
    expect(heartSlotHintText('B', 'full')).toBe('B');
    expect(heartSlotHintText('B', 'half')).toBe('B½');
    expect(heartSlotHintText('K', 'banana' as never)).toBe('K');
  });
});

describe('retour visuel de l usage', () => {
  it('heartStoredTextKey : une clé i18n par sorte, présente en fr et en', () => {
    expect(heartStoredTextKey('full')).toBe('heart.stored.full');
    expect(heartStoredTextKey('half')).toBe('heart.stored.half');
    for (const lang of ['fr', 'en'] as const) {
      setLanguage(lang);
      for (const k of ['full', 'half'] as const) {
        expect(hasKey(heartStoredTextKey(k))).toBe(true);
        expect(t(heartStoredTextKey(k))).not.toBe(heartStoredTextKey(k));
      }
    }
    setLanguage('fr');
  });

  it('heartUsedFx : couleur du cœur utilisé, étincelles bornées 4..9 et croissantes avec le soin', () => {
    expect(heartUsedFx('full', 10).color).toBe(pickupTextColor('full'));
    expect(heartUsedFx('half', 5).color).toBe(pickupTextColor('half'));
    expect(heartUsedFx('full', LOOT_FULL_HEAL).sparkles).toBe(9);
    expect(heartUsedFx('half', 5).sparkles).toBeLessThan(heartUsedFx('full', 10).sparkles);
    expect(heartUsedFx('full', 0).sparkles).toBe(4);
    expect(heartUsedFx('full', Number.NaN).sparkles).toBe(4);
    expect(heartUsedFx('full', 9999).sparkles).toBe(9);
  });
});
