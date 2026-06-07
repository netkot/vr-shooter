// ===========================================================================
// VR Shooting Range — config for the main game settings.
//
// This file loads BEFORE game.js (see index.html) and holds the values you most
// often want to tweak: volume, level difficulty, scoring, timings. game.js reads
// them through the helper CFG('section.key', fallback_value), so a missing key or
// typo won't crash the game — the built-in fallback is used instead.
//
// Changing values here is safe; the "fine" aim/visual calibration (pistol
// rotation, beam pitch, casing ejection, etc.) is intentionally NOT exposed here
// and lives in game.js. After editing, the scene needs a RELOAD (busting the
// game.js cache).
// ===========================================================================
window.GAME_CONFIG = {
  // --- Audio -------------------------------------------------------------
  audio: {
    masterVolume: 0.5,     // overall volume of sound effects (shots, hits)
    musicVolume: 0.5,      // background music volume (quieter than effects)
    musicTrackCount: 20    // how many tracks bg_01.mp3 … bg_NN.mp3 live in music/
  },

  // --- Levels and difficulty ---------------------------------------------
  levels: {
    baseKills: 10,         // targets to destroy on level 1
    killsStep: 0,          // +N to the goal each next level (0 — equal across levels)
    maxLevel: 10,          // after clearing this level — victory (GAME OVER)
    bigRadius: 0.4,        // target radius on level 1 (large)
    smallRadius: 0.18      // target radius on the last level (small)
  },

  // --- Targets -----------------------------------------------------------
  targets: {
    respawn: 1200,         // ms before a destroyed target reappears
    health: 1              // how many hits are needed to destroy it
  },

  // --- Scoring -----------------------------------------------------------
  // Total: base × time_multiplier(1..2) × distance_multiplier(distMin..distMax).
  scoring: {
    base: 50,              // base points per hit
    reactFull: 2500,       // ms: reaction-speed bonus window (faster → more)
    distRef: 10,           // m: distance giving a ×1 multiplier
    distMin: 0.5,          // lower bound of the distance multiplier (close shot)
    distMax: 3.0           // upper bound of the distance multiplier (far shot)
  },

  // --- Misc --------------------------------------------------------------
  game: {
    restartDelayMs: 5000,                   // pause before showing START after GAME OVER
    highScoreKey: 'vr-shooter-highscore',   // High-Score key in localStorage
    maxBulletHoles: 100                     // max simultaneous bullet marks on the walls
  }
};
