//! Settings from the environment.

use std::env;

#[derive(Debug, Clone)]
pub struct Config {
    /// The bot phone's number (digits only), to link by a code instead of a QR.
    pub pairing_number: Option<String>,
    /// Groups the bot answers in. Empty: any group, logging each one's id so
    /// it can be put here ("setup mode").
    pub group_ids: Vec<String>,
    /// The command word, e.g. "@game".
    pub trigger: String,
    /// Where the WhatsApp session is kept (a SQLite file).
    pub store: String,
}

impl Config {
    pub fn from_env() -> Self {
        let var = |name: &str| env::var(name).ok().filter(|v| !v.trim().is_empty());
        Config {
            pairing_number: var("WA_PAIRING_NUMBER")
                .map(|n| n.chars().filter(char::is_ascii_digit).collect()),
            group_ids: var("WA_GROUP_IDS")
                .map(|ids| {
                    ids.split(',')
                        .map(str::trim)
                        .filter(|id| !id.is_empty())
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default(),
            trigger: var("WA_TRIGGER").unwrap_or_else(|| "@game".into()),
            store: var("WA_STORE").unwrap_or_else(|| "whatsapp.db".into()),
        }
    }
}
