#!/usr/bin/env node
/*
 * hinge.js — scrape → crop → draft a like-comment → type it onto the
 * hooked card → append hinge-log.html → next profile. Locks when the
 * feed runs out, you hit the count, or you Ctrl+C.
 *
 * Never taps the Rose. Locks on any exit (success, error, or Ctrl+C).
 *
 * Usage:
 *   node hinge.js                      # no cap, 1–5s gap, like everyone
 *   node hinge.js [count]              # stop after `count` likes
 *   DRY_RUN=1 node hinge.js            # type, don't send (one profile)
 *   SERIAL=192.168.29.4:5555 node hinge.js
 *   NO_LOCK=1 node hinge.js            # leave the screen on at exit
 *
 * Env vars: same as hinge-opener.js (NUM_LIKES, MIN_GAP, MAX_GAP,
 * SKIP_MIN, SKIP_MAX, DRY_RUN, NO_LOCK, LOAD_TIMEOUT, SHOTS_DIR, ADB, SERIAL).
 */
'use strict';
require('./hinge-read.js').boot();
