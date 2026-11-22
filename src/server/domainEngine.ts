import type { AwakeningHostHelpers, AwakeningRoomState, AwakeningActor } from './awakeningEngine.ts';
import type { DomainClashState, DomainExpansionState, FighterId, GameModeId, KothZoneState } from '../shared/gameData.ts';
import { FIGHTER_BY_ID, MAP_BY_ID, getDamagePhase, getObstacleSupportY, resolveObstacleCollisions } from '../shared/gameData.ts';
import {
  DOMAIN_CLASH_DURATION_SEC,
  DOMAIN_CONFIGS,
  DOMAIN_DAMEN_JACKPOT_HITS,
  addDomainCharge,
  areActorsAllied,
  canActivateDomain,
  canTriggerDomainClash,
  resolveDomainClashWinner,
  stepDomainClashBalance,
} from '../game/domainLogic.ts';

export interface DomainModeRoomState extends AwakeningRoomState {
  gameMode: GameModeId;
  activeDomain: DomainExpansionState | null;
  activeDomainClash: (DomainClashState & { p1Overdrive?: number }) | null;
  kothZone: KothZoneState | null;
  teamScores: { alpha: number; beta: number };
  modeTimer: number;
  raidBossId: string | null;
  phase: 'lobby' | 'countdown' | 'combat' | 'roundEnd' | 'victory';
  winnerId: string | null;
  roundWinnerId: string | null;
}

const KOTH_SPOTS: Array<{ x: number; z: number }> = [
  { x: 0, z: 0 },
  { x: -11.5, z: -9.5 },
  { x: 11.5, z: -9.5 },
  { x: -11.5, z: 9.5 },
  { x: 11.5, z: 9.5 },
  { x: 0, z: -13.0 },
  { x: 0, z: 13.0 },
];

export function createInitialKothZone(): KothZoneState {
  return {
    x: 0,
    z: 0,
    radius: 5.5,
    shiftRemaining: 30.0,
    scores: {},
    controllerId: null,
    controllerName: null,
    controllerTeam: null,
    contested: false,
  };
}

export function handleDomainActivate(
  room: DomainModeRoomState,
  actor: AwakeningActor,
  helpers: AwakeningHostHelpers
): boolean {
  if (room.phase !== 'combat' || room.awakeningPhase === 'CUTSCENE') return false;
  if (room.activeDomainClash) return false;

  const existing = room.activeDomain;
  if (existing) {
    const existingOwner = room.actors.find((a) => a.playerId === existing.ownerId);
    const allied = existingOwner ? areActorsAllied(actor, existingOwner, room.gameMode) : false;
    const elapsedSec = Math.max(0, existing.duration - existing.remaining);
    if (
      canActivateDomain({
        domainGauge: actor.domainGauge ?? 0,
        isKO: actor.isKO,
        isStunned: actor.isStunned,
        silencedTimer: actor.silencedTimer,
        activeDomainOwnerId: existing.ownerId,
        playerId: actor.playerId,
      }) &&
      canTriggerDomainClash({
        existingDomainElapsedSec: elapsedSec,
        existingOwnerId: existing.ownerId,
        challengerId: actor.playerId,
        areAllied: allied,
      }) &&
      existingOwner &&
      !existingOwner.isKO
    ) {
      actor.domainGauge = 0;
      const challengerCfg = DOMAIN_CONFIGS[actor.fighterId];
      room.activeDomain = null;
      existingOwner.iframeTimer = Math.max(existingOwner.iframeTimer, 0.7);
      actor.iframeTimer = Math.max(actor.iframeTimer, 0.7);
      room.activeDomainClash = {
        id: helpers.makeId('dclash'),
        p1Id: existingOwner.playerId,
        p2Id: actor.playerId,
        p1Name: existingOwner.name,
        p2Name: actor.name,
        p1FighterId: existingOwner.fighterId,
        p2FighterId: actor.fighterId,
        p1DomainName: existing.domainName,
        p2DomainName: challengerCfg.domainName,
        balance: 0,
        p1Mashes: 0,
        p2Mashes: 0,
        remaining: DOMAIN_CLASH_DURATION_SEC,
        duration: DOMAIN_CLASH_DURATION_SEC,
      };
      helpers.pushEvent(room, {
        kind: 'domainClashStart',
        attackerId: existingOwner.playerId,
        targetId: actor.playerId,
        fighterId: actor.fighterId,
        x: (existingOwner.x + actor.x) * 0.5,
        y: 1.4,
        z: (existingOwner.z + actor.z) * 0.5,
        colorHex: challengerCfg.primaryHex,
        hitStopMs: 95,
        callout: 'DOMAIN CLASH! MASH TO SHATTER!',
      });
      return true;
    }
    return false;
  }

  if (
    !canActivateDomain({
      domainGauge: actor.domainGauge ?? 0,
      isKO: actor.isKO,
      isStunned: actor.isStunned,
      silencedTimer: actor.silencedTimer,
      activeDomainOwnerId: null,
      playerId: actor.playerId,
    })
  ) {
    return false;
  }

  activateDomainDirect(room, actor, helpers);
  return true;
}

function activateDomainDirect(
  room: DomainModeRoomState,
  actor: AwakeningActor,
  helpers: AwakeningHostHelpers
): void {
  const cfg = DOMAIN_CONFIGS[actor.fighterId];
  actor.domainGauge = 0;
  actor.domainJackpotActive = false;
  actor.domainJackpotHits = 0;
  actor.iframeTimer = Math.max(actor.iframeTimer, 0.55);

  room.activeDomain = {
    id: helpers.makeId('dom'),
    ownerId: actor.playerId,
    ownerName: actor.name,
    fighterId: actor.fighterId,
    domainName: cfg.domainName,
    centerX: actor.x,
    centerZ: actor.z,
    radius: cfg.radius,
    remaining: cfg.durationSec,
    duration: cfg.durationSec,
    sureHitTimer: 0.35,
    primaryHex: cfg.primaryHex,
    secondaryHex: cfg.secondaryHex,
    jackpotActive: false,
    jackpotHits: 0,
  };

  if (actor.fighterId === 'prime') {
    helpers.damageObstaclesInArea(room, actor.x, actor.z, cfg.radius, 9999, cfg.primaryHex);
    actor.superArmor = true;
  } else if (actor.fighterId === 'khen') {
    actor.dashCooldown = 0;
    actor.dashCharges = 1;
    actor.dashRechargeRemaining = 0;
  } else if (actor.fighterId === 'marjohn') {
    actor.isFlying = true;
    actor.flightMax = Math.max(actor.flightMax || 9.0, cfg.durationSec);
    actor.flightRemaining = Math.max(actor.flightRemaining, cfg.durationSec);
    actor.flightCooldown = 0;
    actor.grounded = false;
  }

  helpers.pushEvent(room, {
    kind: 'domainStart',
    attackerId: actor.playerId,
    fighterId: actor.fighterId,
    x: actor.x,
    y: actor.y + 1.0,
    z: actor.z,
    radius: cfg.radius,
    colorHex: cfg.primaryHex,
    hitStopMs: 95,
    callout: `DOMAIN EXPANSION: ${cfg.domainName.toUpperCase()}!`,
  });
}

export function handleDomainClashMash(
  room: DomainModeRoomState,
  playerId: string,
  helpers: AwakeningHostHelpers,
  explicitSide?: 'p1' | 'p2'
): void {
  const dc = room.activeDomainClash;
  if (!dc) return;

  let side: 'p1' | 'p2' | null = null;
  if (explicitSide && (room.isSoloPractice || room.isTrainingMode)) {
    side = explicitSide;
  } else if (playerId === dc.p1Id) {
    side = 'p1';
  } else if (playerId === dc.p2Id) {
    side = 'p2';
  }
  if (!side) return;

  if (side === 'p1') dc.p1Mashes += 1;
  else dc.p2Mashes += 1;
  dc.balance = Number(stepDomainClashBalance(dc.balance, side).toFixed(3));

  if (Math.abs(dc.balance) >= 0.96) {
    resolveDomainClash(room, helpers);
  }
}

export function resolveDomainClash(
  room: DomainModeRoomState,
  helpers: AwakeningHostHelpers
): void {
  const dc = room.activeDomainClash;
  if (!dc) return;
  room.activeDomainClash = null;

  const p1 = room.actors.find((a) => a.playerId === dc.p1Id);
  const p2 = room.actors.find((a) => a.playerId === dc.p2Id);
  if (!p1 || !p2 || p1.isKO || p2.isKO) return;

  const winSide = resolveDomainClashWinner(dc.balance, dc.p1Mashes, dc.p2Mashes);
  const winner = winSide === 'p1' ? p1 : p2;
  const loser = winSide === 'p1' ? p2 : p1;
  const dx = loser.x - winner.x;
  const dz = loser.z - winner.z;
  const d = Math.max(0.01, Math.hypot(dx, dz));

  loser.domainGauge = 0;
  loser.vx = (dx / d) * 14.0;
  loser.vz = (dz / d) * 14.0;
  loser.yVel = 6.2;
  loser.grounded = false;
  loser.hp = Math.max(1, loser.hp - 14);
  loser.damagePhase = getDamagePhase(loser.hp, loser.maxHp, loser.isKO);

  activateDomainDirect(room, winner, helpers);
  helpers.pushEvent(room, {
    kind: 'domainClashWin',
    attackerId: winner.playerId,
    targetId: loser.playerId,
    fighterId: winner.fighterId,
    x: (winner.x + loser.x) * 0.5,
    y: 1.4,
    z: (winner.z + loser.z) * 0.5,
    colorHex: DOMAIN_CONFIGS[winner.fighterId].primaryHex,
    hitStopMs: 95,
    callout: `${winner.name.toUpperCase()} SHATTERED THE BARRIER!`,
  });
}

export function registerDamenDomainBulletHit(
  room: DomainModeRoomState,
  attacker: AwakeningActor,
  helpers: AwakeningHostHelpers
): void {
  const dom = room.activeDomain;
  if (!dom || dom.ownerId !== attacker.playerId || dom.fighterId !== 'damen') return;
  attacker.domainJackpotHits = (attacker.domainJackpotHits ?? 0) + 1;
  dom.jackpotHits = attacker.domainJackpotHits;
  if (!attacker.domainJackpotActive && attacker.domainJackpotHits >= DOMAIN_DAMEN_JACKPOT_HITS) {
    attacker.domainJackpotActive = true;
    dom.jackpotActive = true;
    attacker.mana = attacker.maxMana;
    helpers.pushEvent(room, {
      kind: 'domainJackpot',
      attackerId: attacker.playerId,
      fighterId: 'damen',
      x: attacker.x,
      y: attacker.y + 1.5,
      z: attacker.z,
      colorHex: 0xfacc15,
      hitStopMs: 75,
      callout: 'JACKPOT! UNLIMITED CHI & ARSENAL!',
    });
  }
}

export function respawnActorInMode(
  room: DomainModeRoomState,
  actor: AwakeningActor
): void {
  const arenaRadius = MAP_BY_ID[room.mapId].arenaRadius;
  const angle = Math.random() * Math.PI * 2;
  const rad = 7.5 + Math.random() * 6.0;
  const rawX = actor.team === 'alpha' ? -8.5 : actor.team === 'beta' ? 8.5 : Math.cos(angle) * rad;
  const rawZ = actor.team === 'alpha' || actor.team === 'beta' ? (actor.slotIndex % 2 === 0 ? -4 : 4) : Math.sin(angle) * rad;
  const safe = resolveObstacleCollisions(room.mapId, rawX, 0, rawZ, 0.55, room.obstacles);
  const clampedR = Math.hypot(safe.x, safe.z);
  const fx = clampedR > arenaRadius - 2 ? (safe.x / clampedR) * (arenaRadius - 2) : safe.x;
  const fz = clampedR > arenaRadius - 2 ? (safe.z / clampedR) * (arenaRadius - 2) : safe.z;

  actor.isKO = false;
  actor.koTime = null;
  actor.hp = actor.maxHp;
  actor.mana = Math.max(50, Math.round(actor.maxMana * 0.55));
  actor.stamina = actor.maxStamina;
  actor.stagger = 0;
  actor.isStunned = false;
  actor.stunnedTimer = 0;
  actor.stunImmunityTimer = 1.2;
  actor.iframeTimer = 1.4;
  actor.channelKind = null;
  actor.channelTimer = 0;
  actor.isOverdrive = false;
  actor.overdriveAnnounced = false;
  actor.damagePhase = 'NORMAL';
  actor.actionState = 'idle';
  actor.x = fx;
  actor.z = fz;
  actor.y = getObstacleSupportY(room.mapId, fx, 2.0, fz, 0.45, room.obstacles);
  actor.vx = 0;
  actor.yVel = 0;
  actor.vz = 0;
  actor.grounded = true;
}

export function tickDomainAndModes(
  room: DomainModeRoomState,
  dt: number,
  helpers: AwakeningHostHelpers
): void {
  // 1. Domain Clash QTE
  if (room.activeDomainClash) {
    const dc = room.activeDomainClash;
    const p1 = room.actors.find((a) => a.playerId === dc.p1Id);
    const p2 = room.actors.find((a) => a.playerId === dc.p2Id);
    if (p1?.isBot && !p1.isDummy && Math.random() < dt * 6.8) {
      dc.p1Mashes += 1;
      dc.balance = Number(stepDomainClashBalance(dc.balance, 'p1').toFixed(3));
    }
    if (p2?.isBot && !p2.isDummy && Math.random() < dt * 6.8) {
      dc.p2Mashes += 1;
      dc.balance = Number(stepDomainClashBalance(dc.balance, 'p2').toFixed(3));
    }
    dc.remaining -= dt;
    if (dc.remaining <= 0 || Math.abs(dc.balance) >= 0.96) {
      resolveDomainClash(room, helpers);
    }
  }

  // 2. Active Domain Expansion Sure-Hit & Environment Effects
  if (room.activeDomain) {
    const dom = room.activeDomain;
    const owner = room.actors.find((a) => a.playerId === dom.ownerId);
    if (!owner || owner.isKO) {
      if (owner) {
        owner.domainJackpotActive = false;
        owner.domainJackpotHits = 0;
        owner.superArmor = false;
      }
      room.activeDomain = null;
    } else {
      const cfg = DOMAIN_CONFIGS[dom.fighterId];
      dom.remaining -= dt;

      const ownerDist = Math.hypot(owner.x - dom.centerX, owner.z - dom.centerZ);
      const ownerInside = ownerDist <= dom.radius;

      // Fighter-specific continuous Domain effects
      if (dom.fighterId === 'prime' && ownerInside) {
        owner.superArmor = true;
      } else if (dom.fighterId === 'khen' && ownerInside) {
        // Dash cooldown ticks much faster (-70% cooldown inside Unlimited Shadow Void)
        if (owner.dashCooldown > 0) {
          owner.dashCooldown = Math.max(0, owner.dashCooldown - dt * 2.33);
        }
      } else if (dom.fighterId === 'marjohn') {
        owner.isFlying = true;
        owner.flightRemaining = Math.max(owner.flightRemaining, 1.5);
        owner.flightCooldown = 0;
        owner.grounded = false;
      } else if (dom.fighterId === 'jm' && ownerInside) {
        owner.hp = Math.min(owner.maxHp, owner.hp + 5.5 * dt);
        owner.mana = Math.min(owner.maxMana, owner.mana + 8.5 * dt);
        owner.damagePhase = getDamagePhase(owner.hp, owner.maxHp, owner.isKO);
      } else if (dom.fighterId === 'damen' && owner.domainJackpotActive) {
        owner.mana = owner.maxMana;
      }

      // Enemy slows / typhoon pull inside Domain
      for (const target of room.actors) {
        if (target.playerId === owner.playerId || target.isKO) continue;
        if (areActorsAllied(owner, target, room.gameMode)) continue;
        const dx = dom.centerX - target.x;
        const dz = dom.centerZ - target.z;
        const d = Math.hypot(dx, dz);
        if (d <= dom.radius) {
          if (dom.fighterId === 'khen') {
            target.slowTimer = Math.max(target.slowTimer, 0.35);
          } else if (dom.fighterId === 'marjohn' && d > 0.6) {
            target.vx += (dx / d) * 8.5 * dt;
            target.vz += (dz / d) * 8.5 * dt;
          }
        }
      }

      // Periodic Sure-Hit strikes inside Domain
      dom.sureHitTimer -= dt;
      if (dom.sureHitTimer <= 0) {
        dom.sureHitTimer = cfg.sureHitIntervalSec;
        for (const target of room.actors) {
          if (target.playerId === owner.playerId || target.isKO) continue;
          if (areActorsAllied(owner, target, room.gameMode)) continue;
          const dx = target.x - dom.centerX;
          const dz = target.z - dom.centerZ;
          const d = Math.hypot(dx, dz);
          if (d > dom.radius) continue;

          if (dom.fighterId === 'damen') {
            // If Jackpot is active, floating spectral arsenal fires rapid auto-tracking bullets!
            if (owner.domainJackpotActive) {
              const ang = Math.atan2(target.x - owner.x, target.z - owner.z);
              room.projectiles.push({
                id: helpers.makeId('proj'),
                ownerId: owner.playerId,
                fighterId: 'damen',
                kind: 'magnum',
                x: owner.x + Math.sin(ang) * 1.1,
                y: owner.y + 1.45,
                z: owner.z + Math.cos(ang) * 1.1,
                vx: Math.sin(ang) * 32.0,
                vz: Math.cos(ang) * 32.0,
                rotY: ang,
                colorHex: 0xfacc15,
                originX: owner.x,
                originY: owner.y + 1.45,
                originZ: owner.z,
                isOverdrive: true,
                isHoming: true,
                pierceObstacles: true,
                age: 0,
                maxAge: 0.7,
                maxRange: dom.radius * 1.4,
                damage: cfg.sureHitDamage,
                staggerDamage: 6,
                knockback: 2.2,
                hitIds: new Set(),
              });
            }
            continue;
          }

          // Guaranteed Sure-Hit bypasses normal guard
          const prevShield = target.shieldActive;
          const prevParry = target.parryWindow;
          target.shieldActive = false;
          target.parryWindow = false;
          const dirX = d > 0.05 ? dx / d : 0;
          const dirZ = d > 0.05 ? dz / d : 1;
          const dmg = cfg.sureHitDamage;
          helpers.pushEvent(room, {
            kind: 'domainSureHit',
            attackerId: owner.playerId,
            targetId: target.playerId,
            fighterId: dom.fighterId,
            x: target.x,
            y: target.y + 1.0,
            z: target.z,
            colorHex: cfg.primaryHex,
            damage: dmg,
          });
          helpers.applyHit(
            room,
            owner,
            target,
            dmg,
            10,
            dom.fighterId === 'marjohn' ? -3.5 : 3.2,
            dirX,
            dirZ,
            cfg.primaryHex,
            false,
            dom.fighterId === 'marjohn',
            false,
            true,
            false
          );
          if (!target.isStunned && !target.isKO && target.blockHeld) {
            target.shieldActive = prevShield;
            target.parryWindow = prevParry;
          }
        }
      }

      if (dom.remaining <= 0) {
        room.activeDomain = null;
        owner.domainJackpotActive = false;
        owner.domainJackpotHits = 0;
        owner.superArmor = false;
        helpers.pushEvent(room, {
          kind: 'domainEnd',
          attackerId: owner.playerId,
          fighterId: dom.fighterId,
          x: dom.centerX,
          y: 1.0,
          z: dom.centerZ,
          colorHex: cfg.primaryHex,
          callout: `${dom.domainName.toUpperCase()} FADED`,
        });
      }
    }
  }

  // 3. Game Mode Specific Tick Rules (KOTH, Squad Clash, Raid Boss, Sudden Death)
  if (room.gameMode === 'koth') {
    room.modeTimer = Math.max(0, room.modeTimer - dt);
    if (!room.kothZone) {
      room.kothZone = createInitialKothZone();
    }
    const kz = room.kothZone;
    kz.shiftRemaining -= dt;
    if (kz.shiftRemaining <= 0) {
      const nextSpot = KOTH_SPOTS[Math.floor(Math.random() * KOTH_SPOTS.length)];
      kz.x = nextSpot.x;
      kz.z = nextSpot.z;
      kz.shiftRemaining = 30.0;
      helpers.pushEvent(room, {
        kind: 'kothCapture',
        x: kz.x,
        y: 1.2,
        z: kz.z,
        radius: kz.radius,
        colorHex: 0xfacc15,
        callout: 'HILL SHIFTED! CAPTURE THE NEW ZONE!',
      });
    }

    const insideActors: AwakeningActor[] = [];
    for (const actor of room.actors) {
      if (actor.isDummy) continue;
      if (actor.isKO) {
        if (actor.koTime !== null && room.matchTime - actor.koTime >= 2.5) {
          respawnActorInMode(room, actor);
        }
        continue;
      }
      if (Math.hypot(actor.x - kz.x, actor.z - kz.z) <= kz.radius) {
        insideActors.push(actor);
        kz.scores[actor.playerId] = Number(((kz.scores[actor.playerId] ?? 0) + dt * 2.0).toFixed(2));
        actor.mana = Math.min(actor.maxMana, actor.mana + 5.0 * dt);
        actor.domainGauge = addDomainCharge(actor.domainGauge ?? 0, 3.2 * dt);
      }
    }
    kz.contested = insideActors.length > 1;
    if (insideActors.length === 1) {
      kz.controllerId = insideActors[0].playerId;
      kz.controllerName = insideActors[0].name;
      kz.controllerTeam = insideActors[0].team ?? null;
    } else {
      kz.controllerId = null;
      kz.controllerName = null;
      kz.controllerTeam = null;
    }

    if (room.modeTimer <= 0) {
      let bestId: string | null = null;
      let bestScore = -1;
      for (const actor of room.actors) {
        if (actor.isDummy) continue;
        const sc = kz.scores[actor.playerId] ?? 0;
        if (sc > bestScore) {
          bestScore = sc;
          bestId = actor.playerId;
        }
      }
      room.phase = 'victory';
      room.winnerId = bestId ?? room.actors[0]?.playerId ?? null;
      room.roundWinnerId = room.winnerId;
    }
  } else if (room.gameMode === 'squad_clash') {
    for (const actor of room.actors) {
      if (actor.isDummy) continue;
      if (actor.isKO && actor.koTime !== null && room.matchTime - actor.koTime >= 2.3) {
        respawnActorInMode(room, actor);
      }
    }
    if (room.teamScores.alpha >= 10 || room.teamScores.beta >= 10) {
      const winTeam = room.teamScores.alpha >= 10 ? 'alpha' : 'beta';
      const captain = room.actors.find((a) => a.team === winTeam) ?? room.actors[0];
      room.phase = 'victory';
      room.winnerId = captain?.playerId ?? null;
      room.roundWinnerId = room.winnerId;
    }
  } else if (room.gameMode === 'raid_boss') {
    const boss = room.actors.find((a) => a.playerId === room.raidBossId || a.isRaidBoss);
    const raidersAlive = room.actors.filter((a) => !a.isDummy && !a.isRaidBoss && !a.isKO);
    if (boss && boss.isKO) {
      const mvp = room.actors
        .filter((a) => !a.isDummy && !a.isRaidBoss)
        .sort((a, b) => b.damageDealt - a.damageDealt)[0];
      room.phase = 'victory';
      room.winnerId = mvp?.playerId ?? null;
      room.roundWinnerId = room.winnerId;
    } else if (boss && raidersAlive.length === 0) {
      room.phase = 'victory';
      room.winnerId = boss.playerId;
      room.roundWinnerId = boss.playerId;
    }
  }
}

export function getModeAbilityCooldownFactor(room: DomainModeRoomState, actor: AwakeningActor): number {
  let factor = 1.0;
  if (room.gameMode === 'sudden_death') factor *= 0.5;
  if (actor.isRaidBoss) factor *= 0.8;
  return factor;
}

export function getDomainChargeMultiplier(room: DomainModeRoomState, actor: AwakeningActor): number {
  let mult = 1.0;
  if (actor.isRaidBoss) mult *= 1.65;
  if (
    room.gameMode === 'koth' &&
    room.kothZone &&
    Math.hypot(actor.x - room.kothZone.x, actor.z - room.kothZone.z) <= room.kothZone.radius
  ) {
    mult *= 2.0;
  }
  return mult;
}
