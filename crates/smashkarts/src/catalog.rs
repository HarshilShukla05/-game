//! The game's arenas and weapons, as the game itself names and encodes them.
//!
//! Arena names are the game's own (its level table in the build's data, and
//! the `gl` property of live rooms): a room carries the name, and every
//! player's client loads the arena from it. Weapon bits are the `wpns` mask
//! of invite links, read off rooms made in the game.

/// Every arena a private room can be made on, in the game's menu order.
pub const ARENAS: [&str; 29] = [
    "Boneyard Basin",
    "Graveyard",
    "Graveyard CTF",
    "Kartuga",
    "Lava Pit",
    "Lava Pit CTF",
    "Skate City",
    "Skate Park",
    "Sky Arena - Dropzone",
    "Sky Arena - Pinball",
    "Sky Arena - Showdown",
    "Sky Arena - Temples",
    "Sky Arena - Tunnels",
    "Slick 'n Slide",
    "Smash Fort",
    "Smash Fort CTF",
    "Smash Island",
    "Snow Shrine",
    "Snowpark",
    "SnowparkCTF",
    "Space Station",
    "Space Stations",
    "Star Warp Station",
    "Steky's Speedway",
    "The Battle Box",
    "The Gravel Pit",
    "The Old Graveyard",
    "The Sand Box",
    "Toxic Towers",
];

pub struct Weapon {
    pub name: &'static str,
    /// Its bit in the `wpns` mask.
    pub bit: u8,
    /// Other words players use for it.
    pub aliases: &'static [&'static str],
}

/// Every weapon, in the game's menu order.
pub const WEAPONS: [Weapon; 12] = [
    Weapon {
        name: "Rockets",
        bit: 3,
        aliases: &["missile", "missiles"],
    },
    Weapon {
        name: "Invincibility",
        bit: 6,
        aliases: &["invincible", "shield"],
    },
    Weapon {
        name: "Machine Gun",
        bit: 2,
        aliases: &["mg", "minigun"],
    },
    Weapon {
        name: "Mines",
        bit: 5,
        aliases: &[],
    },
    Weapon {
        name: "Fake Lootbox",
        bit: 7,
        aliases: &["fake box"],
    },
    Weapon {
        name: "Nuke",
        bit: 8,
        aliases: &[],
    },
    Weapon {
        name: "Bullets",
        bit: 10,
        aliases: &[],
    },
    Weapon {
        name: "Cannons",
        bit: 11,
        aliases: &[],
    },
    Weapon {
        name: "Lob-Grenuke",
        bit: 13,
        aliases: &["grenade", "grenades"],
    },
    Weapon {
        name: "Spikys",
        bit: 14,
        aliases: &["spikes", "spike", "spikey", "spikeys"],
    },
    Weapon {
        name: "Snowball Blaster",
        bit: 17,
        aliases: &[],
    },
    Weapon {
        name: "Lob Sentry",
        bit: 23,
        aliases: &["turret"],
    },
];

/// The `wpns` mask allowing every weapon.
pub const ALL_WEAPONS: u32 = {
    let mut mask = 0;
    let mut i = 0;
    while i < WEAPONS.len() {
        mask |= 1 << WEAPONS[i].bit;
        i += 1;
    }
    mask
};

/// The arena's id in invite links: the name in lower case without spaces or
/// apostrophes ("Sky Arena - Tunnels" → "skyarena-tunnels").
pub fn slug(arena: &str) -> String {
    arena
        .chars()
        .filter(|c| !matches!(c, ' ' | '\''))
        .flat_map(char::to_lowercase)
        .collect()
}

/// The weapons a mask allows, in menu order.
pub fn weapons_in(mask: u32) -> impl Iterator<Item = &'static Weapon> {
    WEAPONS.iter().filter(move |w| mask & (1 << w.bit) != 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slugs_match_the_game() {
        // Each seen in a link the game built.
        for (arena, slug_) in [
            ("Smash Island", "smashisland"),
            ("Sky Arena - Tunnels", "skyarena-tunnels"),
            ("Sky Arena - Pinball", "skyarena-pinball"),
            ("Lava Pit CTF", "lavapitctf"),
            ("Steky's Speedway", "stekysspeedway"),
            ("The Old Graveyard", "theoldgraveyard"),
            ("Boneyard Basin", "boneyardbasin"),
            ("Toxic Towers", "toxictowers"),
        ] {
            assert_eq!(slug(arena), slug_);
        }
    }

    #[test]
    fn weapon_bits_are_distinct() {
        assert_eq!(ALL_WEAPONS.count_ones() as usize, WEAPONS.len());
        // The game's "all weapons" rooms carry this mask.
        assert_eq!(ALL_WEAPONS, 8_547_820);
    }
}
