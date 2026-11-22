import type { FighterId, GameModeId, TeamId } from '../shared/gameData.ts';

export interface FighterDomainConfig {
  fighterId: FighterId;
  domainName: string;
  subtitle: string;
  radius: number;
  durationSec: number;
  sureHitIntervalSec: number;
  sureHitDamage: number;
  enemySlowFrac: number;
  primaryHex: number;
  secondaryHex: number;
  primaryCss: string;
}

export const DOMAIN_DURATION_SEC = 10.0;
export const DOMAIN_CLASH_WINDOW_SEC = 1.5;
export const DOMAIN_CLASH_DURATION_SEC = 4.5;
export const DOMAIN_CLASH_MASH_PUSH = 0.095;
export const DOMAIN_DAMEN_JACKPOT_HITS = 3;

export const DOMAIN_CONFIGS: Record<FighterId, FighterDomainConfig> = {
  khen: {
    fighterId: 'khen',
    domainName: 'Unlimited Shadow Void',
    subtitle: '45% Slow · Shadow Clone Slashes · -70% Dash CD',
    radius: 17.5,
    durationSec: DOMAIN_DURATION_SEC,
    sureHitIntervalSec: 0.75,
    sureHitDamage: 6,
    enemySlowFrac: 0.45,
    primaryHex: 0xa855f7,
    secondaryHex: 0x09090b,
    primaryCss: '#a855f7',
  },
  prime: {
    fighterId: 'prime',
    domainName: 'Malevolent Crater Shrine',
    subtitle: 'Auto-Shatters Buildings · Magma Eruptions · Super Armor',
    radius: 19.0,
    durationSec: DOMAIN_DURATION_SEC,
    sureHitIntervalSec: 0.5,
    sureHitDamage: 5,
    enemySlowFrac: 0.15,
    primaryHex: 0xf43f5e,
    secondaryHex: 0x450a0a,
    primaryCss: '#f43f5e',
  },
  damen: {
    fighterId: 'damen',
    domainName: 'Idle Deadeye Gamble',
    subtitle: 'Sure-Hit Tracking Bullets · 3 Hits = JACKPOT Unlimited Chi & Arsenal',
    radius: 18.0,
    durationSec: DOMAIN_DURATION_SEC,
    sureHitIntervalSec: 0.42,
    sureHitDamage: 4,
    enemySlowFrac: 0.1,
    primaryHex: 0xfacc15,
    secondaryHex: 0x78350f,
    primaryCss: '#facc15',
  },
  marjohn: {
    fighterId: 'marjohn',
    domainName: 'Horizon of the Calamity Typhoon',
    subtitle: 'Sure-Hit Gale & Inward Pull · Permanent Typhoon Flight',
    radius: 19.5,
    durationSec: DOMAIN_DURATION_SEC,
    sureHitIntervalSec: 0.55,
    sureHitDamage: 5,
    enemySlowFrac: 0.22,
    primaryHex: 0x22d3ee,
    secondaryHex: 0x0c4a6e,
    primaryCss: '#22d3ee',
  },
  jm: {
    fighterId: 'jm',
    domainName: 'Celestial Benevolent Sanctuary',
    subtitle: 'Sure-Hit Golden Bolts · HP/Chi Regen · 2x 0-Chi Kamehameha',
    radius: 18.5,
    durationSec: DOMAIN_DURATION_SEC,
    sureHitIntervalSec: 0.6,
    sureHitDamage: 5,
    enemySlowFrac: 0.12,
    primaryHex: 0xfef08a,
    secondaryHex: 0xf59e0b,
    primaryCss: '#fde047',
  },
};

export function addDomainCharge(current: number, delta: number, rateMultiplier = 1.0): number {
  const safeCurrent = Number.isFinite(current) ? current : 0;
  const safeDelta = Math.max(0, Number.isFinite(delta) ? delta : 0) * Math.max(0, rateMultiplier);
  return Math.max(0, Math.min(100, Number((safeCurrent + safeDelta).toFixed(2))));
}

export function canActivateDomain(params: {
  domainGauge: number;
  isKO: boolean;
  isStunned: boolean;
  silencedTimer?: number;
  activeDomainOwnerId?: string | null;
  playerId: string;
}): boolean {
  if (params.isKO || params.isStunned || (params.silencedTimer ?? 0) > 0) return false;
  if (params.domainGauge < 100 - 1e-6) return false;
  if (params.activeDomainOwnerId && params.activeDomainOwnerId === params.playerId) return false;
  return true;
}

export function canTriggerDomainClash(params: {
  existingDomainElapsedSec: number;
  existingOwnerId: string;
  challengerId: string;
  areAllied: boolean;
}): boolean {
  if (params.areAllied || params.existingOwnerId === params.challengerId) return false;
  return params.existingDomainElapsedSec <= DOMAIN_CLASH_WINDOW_SEC + 0.001;
}

export function stepDomainClashBalance(
  balance: number,
  side: 'p1' | 'p2',
  push = DOMAIN_CLASH_MASH_PUSH
): number {
  const dir = side === 'p1' ? -1 : 1;
  return Math.max(-1, Math.min(1, balance + dir * push));
}

export function resolveDomainClashWinner(
  balance: number,
  p1Mashes: number,
  p2Mashes: number
): 'p1' | 'p2' {
  if (Math.abs(balance) >= 0.04) {
    return balance < 0 ? 'p1' : 'p2';
  }
  return p1Mashes >= p2Mashes ? 'p1' : 'p2';
}

export function areActorsAllied(
  a: { playerId: string; team?: TeamId | null },
  b: { playerId: string; team?: TeamId | null },
  gameMode: GameModeId
): boolean {
  if (a.playerId === b.playerId) return true;
  if (gameMode !== 'squad_clash' && gameMode !== 'raid_boss') return false;
  if (!a.team || !b.team) return false;
  return a.team === b.team;
}
