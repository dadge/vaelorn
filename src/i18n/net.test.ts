/**
 * Tests i18n du multijoueur réseau : parité fr / en des parts `net.*.json`, placeholders identiques, couverture des codes de message du contrat
 * (`NetNoticeCode`, `RtcSignalingErrorCode`), des clés `net.game.*` consommées par la scène de jeu (lot B) et de toutes les clés lues par le salon.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getDictionary, type Language } from './i18n';
import { NET_LOBBY_I18N_KEYS, RTC_ERROR_CODES, messageFromCodeCheck, messageFromJoinError, messageFromStartReason, statusKey, type CodeError, type StartBlock } from '../render/netLobbyLogic';
import { noticeKey, type NetNoticeCode } from '../net/contracts';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(DIR, '..');
type Flat = Record<string, string>;

function readPart(lang: Language): Flat {
  return JSON.parse(fs.readFileSync(path.join(DIR, 'parts', `net.${lang}.json`), 'utf8')) as Flat;
}

const placeholders = (v: string): string[] => Array.from(new Set(Array.from(v.matchAll(/\{(\w+)\}/g), (m) => m[1]))).sort();

/** Tous les codes de `NetNoticeCode` : ce `Record` ne compile que s'il les couvre exactement (un code ajouté au contrat fait échouer `tsc`). */
const NOTICE_CODES: Record<NetNoticeCode, true> = {
  levelCompleted: true,
  hostQuit: true,
  aborted: true,
  hostLeft: true,
  hostLost: true,
  transportFailed: true,
  protocolError: true,
  'reject.protocol': true,
  'reject.build': true,
  'reject.levels': true,
  'reject.started': true,
  'reject.full': true,
  'reject.malformed': true,
};

const fr = readPart('fr');
const en = readPart('en');
const dict: Record<Language, Readonly<Record<string, string>>> = { fr: getDictionary('fr'), en: getDictionary('en') };

describe('i18n réseau : parts net.fr.json / net.en.json', () => {
  it('mêmes clés des deux côtés, valeurs non vides, mêmes {placeholders}', () => {
    expect(Object.keys(fr).sort()).toEqual(Object.keys(en).sort());
    for (const k of Object.keys(fr)) {
      expect(typeof fr[k], `fr:${k}`).toBe('string');
      expect(fr[k].trim().length, `fr:${k} vide`).toBeGreaterThan(0);
      expect(en[k].trim().length, `en:${k} vide`).toBeGreaterThan(0);
      expect(placeholders(en[k]), `placeholders de ${k}`).toEqual(placeholders(fr[k]));
    }
  });

  it('les parts sont chargées dans les dictionnaires du jeu, dans les deux langues, et chaque valeur y est identique à celle du fichier', () => {
    for (const k of Object.keys(fr)) {
      expect(dict.fr[k], `fr:${k}`).toBe(fr[k]);
      expect(dict.en[k], `en:${k}`).toBe(en[k]);
    }
  });

  it('aucun doublon avec les autres dictionnaires (les clés de base gagneraient et masqueraient la part)', () => {
    const others = fs
      .readdirSync(path.join(DIR, 'parts'))
      .filter((n) => /\.(fr|en)\.json$/.test(n) && !n.startsWith('net.'))
      .flatMap((n) => Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, 'parts', n), 'utf8')) as Flat));
    const base = [...Object.keys(JSON.parse(fs.readFileSync(path.join(DIR, 'fr.json'), 'utf8')) as Flat), ...others];
    const owned = new Set(Object.keys(fr));
    expect(base.filter((k) => owned.has(k))).toEqual([]);
  });

  it('les clés du réseau portent le préfixe net. (ou sont la ligne de menu)', () => {
    for (const k of Object.keys(fr)) expect(k === 'menu.net' || k === 'menu.net.hint' || k.startsWith('net.'), k).toBe(true);
  });
});

describe('i18n réseau : couverture des codes du contrat', () => {
  it('un message pour chacun des 13 codes de NetNoticeCode, dans les deux langues', () => {
    const codes = Object.keys(NOTICE_CODES) as NetNoticeCode[];
    expect(codes).toHaveLength(13);
    for (const code of codes) {
      const key = noticeKey(code);
      expect(fr[key], `fr:${key}`).toBeTruthy();
      expect(en[key], `en:${key}`).toBeTruthy();
    }
  });

  it('les refus de version et de niveaux portent {host} et {you}', () => {
    for (const key of ['net.notice.reject.build', 'net.notice.reject.levels']) {
      expect(placeholders(fr[key])).toEqual(['host', 'you']);
      expect(placeholders(en[key])).toEqual(['host', 'you']);
    }
  });

  it('un message pour chaque erreur de signalisation (net.rtc.error.<code>)', () => {
    expect(RTC_ERROR_CODES).toHaveLength(6);
    for (const code of RTC_ERROR_CODES) {
      expect(fr[`net.rtc.error.${code}`], `fr:${code}`).toBeTruthy();
      expect(en[`net.rtc.error.${code}`], `en:${code}`).toBeTruthy();
    }
  });

  it('clés net.game.* réservées à la scène de jeu (docs/NET.md § 9)', () => {
    for (const key of ['net.game.waiting', 'net.game.lag', 'net.game.peerLost', 'net.game.pauseNote']) {
      expect(fr[key], `fr:${key}`).toBeTruthy();
      expect(en[key], `en:${key}`).toBeTruthy();
    }
    expect(placeholders(fr['net.game.peerLost'])).toEqual(['name']);
  });

  it('chaque message produit par la logique du salon existe', () => {
    const keys: string[] = [];
    for (const error of ['empty', 'tooLong', 'badChars'] satisfies CodeError[]) keys.push(messageFromCodeCheck(error).key);
    for (const reason of ['needTwo', 'notReady', 'characterTaken'] satisfies StartBlock[]) keys.push(messageFromStartReason(reason).key);
    keys.push(messageFromJoinError(new Error('timeout')).key, messageFromJoinError(new Error('autre')).key);
    for (const status of ['host', 'ready', 'choosing', 'lost'] as const) keys.push(statusKey(status));
    for (const status of ['creating', 'ready', 'accepting', 'connected', 'failed']) keys.push(`net.lobby.invite.${status}`);
    for (const key of keys) {
      expect(fr[key], `fr:${key}`).toBeTruthy();
      expect(en[key], `en:${key}`).toBeTruthy();
    }
  });
});

describe('i18n réseau : clés lues par le salon et par le menu', () => {
  it('NET_LOBBY_I18N_KEYS existe dans les dictionnaires des deux langues', () => {
    for (const lang of ['fr', 'en'] as const) {
      const missing = NET_LOBBY_I18N_KEYS.filter((k) => !(k in dict[lang]));
      expect(missing, `clés absentes (${lang})`).toEqual([]);
    }
  });

  it('toute clé littérale t(\'...\') des fichiers du salon existe dans les deux langues', () => {
    const files = ['scenes/NetLobbyScene.ts', 'scenes/netLobbyDom.ts', 'render/netLobbyLogic.ts', 'scenes/MenuScene.ts'];
    const re = /(?<![\w$.])t\(\s*(['"`])((?:(?!\1)[^\\\n$])*)\1/g;
    const missing: string[] = [];
    for (const file of files) {
      const full = path.join(SRC, file);
      if (!fs.existsSync(full)) continue;
      const source = fs.readFileSync(full, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1');
      for (const m of source.matchAll(re)) {
        const key = m[2];
        if (key !== '' && (!(key in dict.fr) || !(key in dict.en))) missing.push(`${file} -> ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
