#!/usr/bin/env node
/*
 * hinge.js — full co-pilot for one profile:
 *   scrape text → crop the first photo → draft a like-comment → type it
 *   onto the hooked card → append hinge-log.html → lock the phone.
 *
 * Never taps the Rose. Locks on any exit (success, error, Ctrl+C).
 *
 * Usage:
 *   node hinge.js
 *   DRY_RUN=1 node hinge.js            # type, screenshot, don't send
 *   SERIAL=192.168.1.42:5555 node hinge.js
 */
'use strict';
require('./hinge-read.js').boot();
