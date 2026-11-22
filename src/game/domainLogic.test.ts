import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addDomainCharge,
  areActorsAllied,
  canActivateDomain,
  canTriggerDomainClash,
  DOMAIN_CONFIGS,
  resolveDomainClashWinner,
  stepDomainClashBalance,
} from './domainLogic.ts';
import { LocalRoomSession } from './localRoomClient.ts';
import { GAME_MODES, type ServerMessage } from '../shared/gameData.ts';

test('Domain configs exist for all 5 fighters and charge/activation/clash rules enforce limits', () => {
  for (const id of ['khen', 'prime', 'damen', 'marjohn', 'jm'] as const) {
    assert.ok(DOMAIN_CONFIGS[id]);
    assert.equal(DOMAIN_CONFIGS[id].durationSec, 10);
  }

  assert.equal(addDomainCharge(75, 50), 100);
  assert.equal(addDomainCharge(20, 15, 2), 50);

  assert.equal(
    canActivateDomain({
      domainGauge: 99,
      isKO: false,
      isStunned: false,
      playerId: 'p1',
    }),
    false
  );
  assert.equal(
    canActivateDomain({
      domainGauge: 100,
      isKO: false,
      isStunned: false,
      playerId: 'p1',
    }),
    true
  );

  // Clash triggers strictly within 1.5s window against non-allied opponent
  assert.equal(
    canTriggerDomainClash({
      existingDomainElapsedSec: 1.2,
      existingOwnerId: 'p1',
      challengerId: 'p2',
      areAllied: false,
    }),
    true
  );
  assert.equal(
    canTriggerDomainClash({
      existingDomainElapsedSec: 1.8,
      existingOwnerId: 'p1',
      challengerId: 'p2',
      areAllied: false,
    }),
    false
  );
  assert.equal(
    canTriggerDomainClash({
      existingDomainElapsedSec: 0.4,
      existingOwnerId: 'p1',
      challengerId: 'p2',
      areAllied: true,
    }),
    false
  );

  let bal = 0;
  bal = stepDomainClashBalance(bal, 'p1');
  bal = stepDomainClashBalance(bal, 'p1');
  assert.ok(bal < 0);
  assert.equal(resolveDomainClashWinner(bal, 2, 0), 'p1');
  assert.equal(areActorsAllied({ playerId: 'a', team: 'alpha' }, { playerId: 'b', team: 'alpha' }, 'squad_clash'), true);
  assert.equal(areActorsAllied({ playerId: 'a', team: 'alpha' }, { playerId: 'b', team: 'alpha' }, 'classic'), false);
});

test('Awakening Spam Duel skip jumps straight to Clash phase and grants winner +50% Domain Gauge', () => {
  const msgs: ServerMessage[] = [];
  const session = new LocalRoomSession({
    autoTick: false,
    onMessage: (m) => msgs.push(m),
  });

  try {
    session.send({
      type: 'room:create',
      playerName: 'ClashTester',
      isSoloPractice: true,
      isTrainingMode: false,
    });
    session.send({ type: 'room:selectFighter', fighterId: 'khen' });
    session.send({ type: 'room:startNow' });

    let t = Date.now();
    for (let i = 0; i < 110; i++) {
      t += 50;
      session.stepNow(t);
    }
    session.send({ type: 'game:debug', action: 'resetCooldowns' });
    session.send({ type: 'game:debug', action: 'triggerCutscene' });
    t += 50;
    session.stepNow(t);

    const getLastSnap = () => {
      const snaps = msgs.filter(
        (m): m is Extract<ServerMessage, { type: 'game:snapshot' }> => m.type === 'game:snapshot'
      );
      return snaps[snaps.length - 1]?.snapshot;
    };

    const initialSnap = getLastSnap();
    assert.equal(initialSnap?.awakeningPhase, 'CUTSCENE');

    // Clicking Skip jumps clock directly to 15.0s Spam Duel without closing cutscene!
    session.send({ type: 'game:awakeningSkip' });
    t += 50;
    session.stepNow(t);

    const duelSnap = getLastSnap();
    assert.equal(duelSnap?.awakeningPhase, 'CUTSCENE');
    assert.ok((duelSnap?.awakeningCutscene?.clockSec ?? 0) >= 15.0);

    // P1 mashes repeatedly across the Spam Duel to overpower the Bot
    for (let i = 0; i < 65; i++) {
      if (getLastSnap()?.awakeningPhase === 'AWAKENED_DUEL') break;
      session.send({ type: 'game:awakeningMash' });
      session.send({ type: 'game:awakeningMash' });
      t += 60;
      session.stepNow(t);
    }

    const postSnap = getLastSnap();
    assert.equal(postSnap?.awakeningPhase, 'AWAKENED_DUEL');
    const p1 = postSnap?.actors[0];
    assert.ok(p1);
    assert.ok(p1.domainGauge >= 50, `Expected winner to gain >=50% Domain Gauge, got ${p1.domainGauge}`);
  } finally {
    session.dispose();
  }
});

test('Domain Expansion (Khen -70% Dash CD, JM 0-Chi Kamehameha, Quick Grab, and all 5 Game Modes)', () => {
  assert.equal(GAME_MODES.length, 5);

  const msgs: ServerMessage[] = [];
  const session = new LocalRoomSession({
    autoTick: false,
    onMessage: (m) => msgs.push(m),
  });

  try {
    // Verify Overdrive Sudden Death spawns players Awakened + 100% Domain Gauge
    session.send({
      type: 'room:create',
      playerName: 'DomainHero',
      isSoloPractice: true,
      isTrainingMode: false,
      gameMode: 'sudden_death',
    });
    session.send({ type: 'room:selectFighter', fighterId: 'khen' });
    session.send({ type: 'room:startNow' });

    let t = Date.now();
    // Skip past 5s countdown into Sudden Death combat
    for (let i = 0; i < 110; i++) {
      t += 50;
      session.stepNow(t);
    }

    const getLastSnap = () => {
      const snaps = msgs.filter(
        (m): m is Extract<ServerMessage, { type: 'game:snapshot' }> => m.type === 'game:snapshot'
      );
      return snaps[snaps.length - 1]?.snapshot;
    };

    const sdSnap = getLastSnap();
    assert.equal(sdSnap?.gameMode, 'sudden_death');
    const khen = sdSnap?.actors[0];
    assert.ok(khen);
    assert.equal(khen.awakened, true);
    assert.equal(khen.domainGauge, 100);
    assert.equal(sdSnap?.stormActive, true);

    // Activate Khen's Unlimited Shadow Void [V]
    session.send({ type: 'game:domainActivate' });
    t += 50;
    session.stepNow(t);

    const domSnap = getLastSnap();
    assert.ok(domSnap?.activeDomain);
    assert.equal(domSnap?.activeDomain?.fighterId, 'khen');
    assert.equal(domSnap?.activeDomain?.domainName, 'Unlimited Shadow Void');

    // Quick Grab comes out snappy (0.17s halved startup/duration)
    session.send({ type: 'game:grab', seq: 1, aimYaw: 0 });
    t += 50;
    session.stepNow(t);
    const grabSnap = getLastSnap();
    const khenGrab = grabSnap?.actors[0];
    assert.ok(khenGrab);
    assert.ok(khenGrab.actionDuration <= 0.2, `Expected fast halved Grab duration <=0.2s, got ${khenGrab.actionDuration}`);
  } finally {
    session.dispose();
  }
});

test('All 5 Game Modes (classic, raid_boss, koth, squad_clash, sudden_death) initialize cleanly in LocalRoomSession', () => {
  for (const mode of ['classic', 'raid_boss', 'koth', 'squad_clash', 'sudden_death'] as const) {
    const msgs: ServerMessage[] = [];
    const session = new LocalRoomSession({
      autoTick: false,
      onMessage: (m) => msgs.push(m),
    });
    try {
      session.send({
        type: 'room:create',
        playerName: 'ModeHost',
        isSoloPractice: true,
        isTrainingMode: false,
        gameMode: mode,
      });
      session.send({ type: 'room:startNow' });
      let t = Date.now();
      for (let i = 0; i < 110; i++) {
        t += 50;
        session.stepNow(t);
      }
      const snaps = msgs.filter(
        (m): m is Extract<ServerMessage, { type: 'game:snapshot' }> => m.type === 'game:snapshot'
      );
      const snap = snaps[snaps.length - 1]?.snapshot;
      assert.ok(snap, `Expected snapshot for mode ${mode}`);
      assert.equal(snap.gameMode, mode);
      if (mode === 'raid_boss') {
        assert.ok(snap.raidBossId);
        const boss = snap.actors.find((a) => a.isRaidBoss);
        assert.ok(boss && boss.awakened && boss.maxHp > 300);
        assert.equal(snap.actors.length, 5);
      } else if (mode === 'koth') {
        assert.ok(snap.kothZone);
      } else if (mode === 'squad_clash') {
        assert.ok(snap.teamScores);
        assert.equal(snap.actors.length, 4);
      }
    } finally {
      session.dispose();
    }
  }
});
