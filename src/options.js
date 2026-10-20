// What a "@game ..." message asks for, and how to say it back.
//
// The arenas and weapons are the recording's tiles ({ name, aliases? }), so
// chat accepts exactly what the bot can click. A name can be typed in full
// ("sky arena tunnels", "SkyArenaTunnels"), by any part that only one name
// has ("tunnels", "island", "gun"), with or without a plural "s", or by one
// of its aliases ("spikes" for Spikys).

const FILLER = new Set([
  'min', 'mins', 'minute', 'minutes', 'round', 'rounds', 'map', 'arena', 'on', 'in', 'with', 'and',
  'only', 'weapon', 'weapons', 'game', 'please', 'pls', 'mode', 'a', 'of',
]);
const HELP = /^(help|maps|arenas|weapons|options|\?)$/;
const MAX_NAME_WORDS = 4;

export const squash = (s) => String(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Full names (and aliases) win over parts; a part two names share is dropped.
function nameIndex(items) {
  const full = new Map();
  const parts = new Map();
  for (const { name, aliases = [] } of items) {
    for (const key of [name, ...aliases]) full.set(squash(key), name);
    const words = name.split(/[\s-]+/);
    for (let i = 0; i < words.length; i++) {
      for (let j = i + 1; j <= words.length; j++) {
        const key = squash(words.slice(i, j).join(''));
        if (key.length < 3) continue;
        parts.set(key, parts.has(key) && parts.get(key) !== name ? null : name);
      }
    }
  }
  return (key) => {
    for (const k of [key, `${key}s`, key.replace(/s$/, '')]) {
      if (full.has(k)) return full.get(k);
    }
    // An ambiguous part stays ambiguous: "station" is not "Space Stations".
    for (const k of [key, `${key}s`, key.replace(/s$/, '')]) {
      if (parts.has(k)) return parts.get(k);
    }
    return null;
  };
}

// "@game", "@game 20 team", "@game tunnels all", "@game new nuke mines 6" ->
// { minutes, teams, arena, weapons, explicit, fresh }, { help: true } or { error }.
// Explicit means the asker named an option; a live room that differs is then
// replaced, while a plain "@game" just gets the live room's link. "new" asks
// for a fresh room even if the live one matches or a round is running.
export function parseGameArgs(args, { timer, arenas, weapons, defaults }) {
  const words = String(args ?? '').toLowerCase().split(/[\s,+&/]+/).filter(Boolean);
  if (words.length === 1 && HELP.test(words[0])) return { help: true };
  const arenaOf = nameIndex(arenas);
  const weaponOf = nameIndex(weapons);
  let minutes = null;
  let teams = null;
  let arena = null;
  let allWeapons = false;
  let fresh = false;
  const picked = new Set();

  for (let i = 0; i < words.length;) {
    const w = words[i];
    const m = w.match(/^(\d+)(m|min|mins|minutes?)?$/);
    if (m) {
      if (minutes !== null) return { error: 'Give one round length.' };
      minutes = Number(m[1]);
      if (!timer.options.includes(minutes)) return { error: `Round length can be ${timer.options.join(', ')} minutes.` };
      i++;
      continue;
    }
    if (/^teams?$/.test(w)) { teams = true; i++; continue; }
    if (w === 'ffa') { teams = false; i++; continue; }
    if (w === 'all') { allWeapons = true; i++; continue; }
    if (w === 'new') { fresh = true; i++; continue; }
    let n = Math.min(MAX_NAME_WORDS, words.length - i);
    for (; n >= 1; n--) {
      const key = squash(words.slice(i, i + n).join(''));
      if (!key) continue;
      const a = arenaOf(key);
      if (a) {
        if (arena && arena !== a) return { error: `Pick one arena (${arena} or ${a}?).` };
        arena = a;
        break;
      }
      const wp = weaponOf(key);
      if (wp) {
        picked.add(wp);
        break;
      }
    }
    if (n >= 1) { i += n; continue; }
    if (FILLER.has(w) || !squash(w)) { i++; continue; }
    return { error: `I don't know "${w}".` };
  }

  const explicit = fresh || minutes !== null || teams !== null || arena !== null || allWeapons || picked.size > 0;
  return {
    minutes: minutes ?? timer.defaultMinutes,
    teams: teams ?? false,
    arena: arena ?? defaults.arena,
    // In the popup's order, so the same choice always gives the same room key.
    weapons: allWeapons ? weapons.map((t) => t.name)
      : picked.size ? weapons.map((t) => t.name).filter((n) => picked.has(n)) : [...defaults.weapons],
    explicit,
    fresh,
  };
}

// Rooms with equal keys have equal settings.
export const roomKey = ({ minutes, teams, arena, weapons }) => `${minutes}/${teams}/${arena}/${weapons.join('+')}`;

// "Nuke only", "Nuke + Mines only", "All weapons".
export function weaponsText(weapons, all) {
  if (all.length && weapons.length === all.length) return 'All weapons';
  return `${weapons.join(' + ')} only`;
}

export const arenaText = (arena) => (arena === 'Random' ? 'a random arena' : arena);

export function helpText({ arenas, weapons, defaults, timer, trigger, startTrigger }) {
  return [
    `🏎️ ${trigger} makes a Smash Karts room. Add any of these, in any order:`,
    `• Round length: ${timer.options.join(', ')} (default ${timer.defaultMinutes})`,
    '• team: Team Battle (default Free For All)',
    `• An arena (default ${defaults.arena}): ${arenas.map((t) => t.name).join(', ')}`,
    `• Weapons (default ${defaults.weapons.join(' + ')}), one or more, or "all": ${weapons.map((t) => t.name).join(', ')}`,
    `Short names work: ${trigger} 20 team tunnels nuke mines`,
    `While a round runs, other settings wait for it to end; ${trigger} new … replaces the room anyway.`,
    `${startTrigger} starts the round.`,
  ].join('\n');
}
