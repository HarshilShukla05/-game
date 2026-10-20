//! What a chat command ("@game 20 team tunnels nuke mines") asks for, and the
//! texts the bot answers with.
//!
//! Arenas and weapons can be typed in full ("sky arena tunnels"), by any part
//! that only one name has ("tunnels", "island", "gun"), with or without a
//! plural "s", or by an alias ("spikes" for Spikys).

use crate::Settings;
use crate::catalog::{ALL_WEAPONS, ARENAS, WEAPONS, weapons_in};
use std::collections::HashMap;
use std::fmt::Write as _;
use std::sync::OnceLock;

/// Round lengths the game offers.
pub const MINUTES: [u8; 4] = [3, 6, 10, 20];
pub const DEFAULT_MINUTES: u8 = 10;
pub const DEFAULT_ARENA: &str = "Smash Island";
/// Nuke only.
pub const DEFAULT_WEAPONS: u32 = 1 << 8;

const FILLER: [&str; 21] = [
    "min", "mins", "minute", "minutes", "round", "rounds", "map", "arena", "on", "in", "with",
    "and", "only", "weapon", "weapons", "game", "please", "pls", "mode", "a", "of",
];
const HELP: [&str; 6] = ["help", "maps", "arenas", "weapons", "options", "?"];
const MAX_NAME_WORDS: usize = 4;

/// A parsed command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Request {
    Help,
    Room(Choice),
}

/// The room a command asks for, with defaults filled in.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Choice {
    pub minutes: u8,
    pub teams: bool,
    /// `None` for a random arena.
    pub arena: Option<&'static str>,
    pub weapons: u32,
    /// The asker named at least one option. A plain command is happy with
    /// whatever room is open.
    pub explicit: bool,
    /// "new": a fresh room even if an open one matches.
    pub fresh: bool,
}

impl Choice {
    /// Whether a room with these settings gives the asker what they asked for.
    pub fn accepts(&self, s: &Settings) -> bool {
        !self.explicit
            || (self.minutes == s.minutes
                && self.teams == s.teams
                && self.arena.is_none_or(|a| a == s.arena)
                && self.weapons == s.weapons)
    }

    /// Concrete settings, drawing a random arena with `seed` when asked to.
    pub fn settings(&self, seed: u64) -> Settings {
        Settings {
            minutes: self.minutes,
            teams: self.teams,
            arena: self
                .arena
                .unwrap_or(ARENAS[(seed % ARENAS.len() as u64) as usize]),
            weapons: self.weapons,
        }
    }
}

/// Lower case letters and digits only.
fn squash(s: &str) -> String {
    s.chars()
        .filter(char::is_ascii_alphanumeric)
        .map(|c| c.to_ascii_lowercase())
        .collect()
}

/// Names by their squashed full form, aliases and unambiguous parts.
struct Names<T> {
    full: HashMap<String, T>,
    /// `None` when two names share the part ("station").
    parts: HashMap<String, Option<T>>,
}

impl<T: Copy + PartialEq> Names<T> {
    fn new<'a>(items: impl IntoIterator<Item = (T, &'a str, &'a [&'a str])>) -> Self {
        let mut full = HashMap::new();
        let mut parts = HashMap::<String, Option<T>>::new();
        for (id, name, aliases) in items {
            for key in std::iter::once(&name).chain(aliases) {
                full.insert(squash(key), id);
            }
            let words: Vec<&str> = name
                .split(|c: char| c.is_whitespace() || c == '-')
                .filter(|w| !w.is_empty())
                .collect();
            for i in 0..words.len() {
                for j in i + 1..=words.len() {
                    let key = squash(&words[i..j].concat());
                    if key.len() < 3 {
                        continue;
                    }
                    parts
                        .entry(key)
                        .and_modify(|v| {
                            if *v != Some(id) {
                                *v = None;
                            }
                        })
                        .or_insert(Some(id));
                }
            }
        }
        Self { full, parts }
    }

    /// Full names and aliases win over parts; an ambiguous part matches nothing.
    fn find(&self, key: &str) -> Option<T> {
        let plural = format!("{key}s");
        let singular = key.strip_suffix('s').unwrap_or(key);
        let keys = [key, plural.as_str(), singular];
        if let Some(id) = keys.iter().find_map(|k| self.full.get(*k)) {
            return Some(*id);
        }
        keys.iter()
            .find_map(|k| self.parts.get(*k))
            .copied()
            .flatten()
    }
}

fn arenas() -> &'static Names<&'static str> {
    static NAMES: OnceLock<Names<&'static str>> = OnceLock::new();
    NAMES.get_or_init(|| Names::new(ARENAS.iter().map(|&a| (a, a, &[][..]))))
}

fn weapons() -> &'static Names<u8> {
    static NAMES: OnceLock<Names<u8>> = OnceLock::new();
    NAMES.get_or_init(|| Names::new(WEAPONS.iter().map(|w| (w.bit, w.name, w.aliases))))
}

/// Parses what follows the trigger word. `Err` is a message for the asker.
pub fn parse(args: &str) -> Result<Request, String> {
    let lower = args.to_lowercase();
    let words: Vec<&str> = lower
        .split(|c: char| c.is_whitespace() || matches!(c, ',' | '+' | '&' | '/'))
        .filter(|w| !w.is_empty())
        .collect();
    if let [word] = words[..]
        && HELP.contains(&word)
    {
        return Ok(Request::Help);
    }

    let mut minutes = None;
    let mut teams = None;
    let mut arena = None;
    let mut random = false;
    let mut all = false;
    let mut fresh = false;
    let mut picked = 0u32;

    let mut i = 0;
    while i < words.len() {
        let w = words[i];
        if let Some(m) = round_length(w) {
            if minutes.is_some() {
                return Err("Give one round length.".into());
            }
            if !MINUTES.contains(&m) {
                return Err(format!("Round length can be {} minutes.", list(&MINUTES)));
            }
            minutes = Some(m);
            i += 1;
            continue;
        }
        match w {
            "team" | "teams" => teams = Some(true),
            "ffa" => teams = Some(false),
            "all" => all = true,
            "new" => fresh = true,
            "random" => random = true,
            _ => {
                let n = longest_name(&words[i..], &mut arena, &mut picked)?;
                if n == 0 && !FILLER.contains(&w) && !squash(w).is_empty() {
                    return Err(format!("I don't know \"{w}\"."));
                }
                i += n.max(1);
                continue;
            }
        }
        i += 1;
    }
    if random && arena.is_some() {
        return Err("Pick an arena or random, not both.".into());
    }

    let explicit = fresh
        || random
        || all
        || minutes.is_some()
        || teams.is_some()
        || arena.is_some()
        || picked != 0;
    Ok(Request::Room(Choice {
        minutes: minutes.unwrap_or(DEFAULT_MINUTES),
        teams: teams.unwrap_or(false),
        arena: if random {
            None
        } else {
            Some(arena.unwrap_or(DEFAULT_ARENA))
        },
        weapons: if all {
            ALL_WEAPONS
        } else if picked != 0 {
            picked
        } else {
            DEFAULT_WEAPONS
        },
        explicit,
        fresh,
    }))
}

/// "20", "20m", "20min", "20 minutes" (the unit as its own word is filler).
fn round_length(w: &str) -> Option<u8> {
    let digits = w.len() - w.trim_start_matches(|c: char| c.is_ascii_digit()).len();
    let (num, unit) = w.split_at(digits);
    if num.is_empty() || !matches!(unit, "" | "m" | "min" | "mins" | "minute" | "minutes") {
        return None;
    }
    Some(num.parse().unwrap_or(u8::MAX))
}

/// Matches the longest run of words (up to four) that names an arena or a
/// weapon, records it, and returns how many words it took (0 for none).
fn longest_name(
    words: &[&str],
    arena: &mut Option<&'static str>,
    picked: &mut u32,
) -> Result<usize, String> {
    for n in (1..=MAX_NAME_WORDS.min(words.len())).rev() {
        let key = squash(&words[..n].concat());
        if key.is_empty() {
            continue;
        }
        if let Some(a) = arenas().find(&key) {
            if let Some(prev) = arena.filter(|p| *p != a) {
                return Err(format!("Pick one arena ({prev} or {a}?)."));
            }
            *arena = Some(a);
            return Ok(n);
        }
        if let Some(bit) = weapons().find(&key) {
            *picked |= 1 << bit;
            return Ok(n);
        }
    }
    Ok(0)
}

fn list(items: &[u8]) -> String {
    items
        .iter()
        .map(u8::to_string)
        .collect::<Vec<_>>()
        .join(", ")
}

/// "Nuke only", "Nuke + Mines only", "All weapons".
pub fn weapons_text(mask: u32) -> String {
    if mask == ALL_WEAPONS {
        return "All weapons".into();
    }
    let names: Vec<&str> = weapons_in(mask).map(|w| w.name).collect();
    format!("{} only", names.join(" + "))
}

/// The message that carries a room's link.
pub fn room_text(s: &Settings, link: &str) -> String {
    format!(
        "🏎️ Smash Karts: {} on {}, {}, {} min rounds\n{link}",
        weapons_text(s.weapons),
        s.arena,
        if s.teams {
            "Team Battle"
        } else {
            "Free For All"
        },
        s.minutes
    )
}

pub const FAILURE_TEXT: &str = "⚠️ Couldn't create the room this time. Try again in a minute.";

/// How to use the command, for "@game help".
pub fn help_text(trigger: &str) -> String {
    let mut t = String::with_capacity(1024);
    let _ = writeln!(
        t,
        "🏎️ {trigger} makes a Smash Karts room. Add any of these, in any order:"
    );
    let _ = writeln!(
        t,
        "• Round length: {} (default {DEFAULT_MINUTES})",
        list(&MINUTES)
    );
    let _ = writeln!(t, "• team: Team Battle (default Free For All)");
    let _ = writeln!(
        t,
        "• An arena (default {DEFAULT_ARENA}), or random: {}",
        ARENAS.join(", ")
    );
    let names: Vec<&str> = WEAPONS.iter().map(|w| w.name).collect();
    let _ = writeln!(
        t,
        "• Weapons (default {}), one or more, or \"all\": {}",
        weapons_text(DEFAULT_WEAPONS).trim_end_matches(" only"),
        names.join(", ")
    );
    let _ = writeln!(t, "Short names work: {trigger} 20 team tunnels nuke mines");
    let _ = writeln!(
        t,
        "{trigger} alone gives the room that is open; {trigger} new … always makes a fresh one."
    );
    let _ = write!(
        t,
        "The first player in hosts the room and starts the rounds."
    );
    t
}

#[cfg(test)]
mod tests {
    use super::*;

    fn room(args: &str) -> Choice {
        match parse(args) {
            Ok(Request::Room(c)) => c,
            other => panic!("{args:?}: {other:?}"),
        }
    }

    fn bit(name: &str) -> u32 {
        1 << WEAPONS.iter().find(|w| w.name == name).unwrap().bit
    }

    #[test]
    fn plain_command_takes_the_defaults() {
        let c = room("");
        assert_eq!(
            (c.minutes, c.teams, c.arena, c.weapons, c.explicit, c.fresh),
            (
                10,
                false,
                Some("Smash Island"),
                DEFAULT_WEAPONS,
                false,
                false
            )
        );
    }

    #[test]
    fn options_in_any_order_and_short_names() {
        let c = room("20 team tunnels nuke mines");
        assert_eq!(c.minutes, 20);
        assert!(c.teams && c.explicit);
        assert_eq!(c.arena, Some("Sky Arena - Tunnels"));
        assert_eq!(c.weapons, bit("Nuke") | bit("Mines"));

        let c = room("new Mines, NUKE on the old graveyard 6min");
        assert!(c.fresh);
        assert_eq!(c.minutes, 6);
        assert_eq!(c.arena, Some("The Old Graveyard"));
        assert_eq!(c.weapons, bit("Nuke") | bit("Mines"));
    }

    #[test]
    fn names_by_part_alias_and_plural() {
        assert_eq!(room("island").arena, Some("Smash Island"));
        assert_eq!(room("sky arena tunnels").arena, Some("Sky Arena - Tunnels"));
        assert_eq!(room("SkyArenaTunnels").arena, Some("Sky Arena - Tunnels"));
        assert_eq!(room("slick n slide").arena, Some("Slick 'n Slide"));
        assert_eq!(room("stekys speedway").arena, Some("Steky's Speedway"));
        assert_eq!(room("gun").weapons, bit("Machine Gun"));
        assert_eq!(room("spikes").weapons, bit("Spikys"));
        assert_eq!(room("rocket").weapons, bit("Rockets"));
        assert_eq!(room("nukes").weapons, bit("Nuke"));
        // An exact name beats a shared part: "space station" is not ambiguous.
        assert_eq!(room("space station").arena, Some("Space Station"));
        assert_eq!(room("space stations").arena, Some("Space Stations"));
    }

    #[test]
    fn all_weapons_and_random_arena() {
        assert_eq!(room("all").weapons, ALL_WEAPONS);
        let c = room("random");
        assert_eq!(c.arena, None);
        assert!(c.explicit);
        assert!(ARENAS.contains(&c.settings(12_345).arena));
    }

    #[test]
    fn mistakes_are_explained() {
        assert_eq!(
            parse("7").unwrap_err(),
            "Round length can be 3, 6, 10, 20 minutes."
        );
        assert_eq!(parse("3 6").unwrap_err(), "Give one round length.");
        assert_eq!(parse("banana").unwrap_err(), "I don't know \"banana\".");
        assert!(
            parse("tunnels island")
                .unwrap_err()
                .starts_with("Pick one arena")
        );
        assert!(parse("random island").is_err());
        // "station" is in two arena names, and in no weapon's.
        assert!(parse("station").is_err());
    }

    #[test]
    fn help_words() {
        for w in ["help", "maps", "?", " Weapons "] {
            assert_eq!(parse(w), Ok(Request::Help), "{w}");
        }
        assert!(help_text("@game").contains("Toxic Towers"));
    }

    #[test]
    fn a_plain_command_accepts_any_room_an_explicit_one_only_its_own() {
        let open = room("tunnels").settings(0);
        assert!(room("").accepts(&open));
        assert!(room("tunnels").accepts(&open));
        assert!(!room("island").accepts(&open));
        assert!(room("random").accepts(&open));
        assert!(!room("random 20").accepts(&open));
    }

    #[test]
    fn texts() {
        let s = room("6 team all toxic").settings(0);
        assert_eq!(
            room_text(&s, "L"),
            "🏎️ Smash Karts: All weapons on Toxic Towers, Team Battle, 6 min rounds\nL"
        );
        assert_eq!(
            weapons_text(bit("Nuke") | bit("Mines")),
            "Mines + Nuke only"
        );
    }
}
