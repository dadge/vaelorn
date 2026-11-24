/**
 * Erreur de la signalisation WebRTC manuelle (`RtcSignalingErrorCode` du contrat). Fichier à part pour que `rtcCodec.ts` (pur) et `rtcSignaling.ts` la partagent
 * sans import circulaire ; `rtcSignaling.ts` la ré-exporte (c'est là que le contrat la situe).
 */
import type { RtcSignalingErrorCode } from './contracts';

export class RtcSignalingError extends Error {
  readonly code: RtcSignalingErrorCode;

  constructor(code: RtcSignalingErrorCode, detail?: string) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'RtcSignalingError';
    this.code = code;
  }
}
