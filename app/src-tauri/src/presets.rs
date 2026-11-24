//! Built-in profiles. They are merged into existing configs once per PRESETS_VERSION, so new
//! presets show up after an update without touching profiles the user already edited.

use crate::config::{Action, KeyConfig, MediaKey, Profile};

pub const PRESETS_VERSION: u32 = 2;

fn k(label: &str, color: &str, action: Action) -> KeyConfig {
    KeyConfig { label: label.into(), color: color.into(), action, icon: None }
}
/// Key with an emoji picture.
fn e(label: &str, color: &str, emoji: &str, action: Action) -> KeyConfig {
    KeyConfig { icon: Some(serde_json::json!({ "kind": "emoji", "char": emoji })), ..k(label, color, action) }
}
/// Key with a brand logo (Simple Icons slug + colour).
fn b(label: &str, color: &str, slug: &str, title: &str, hex: &str, action: Action) -> KeyConfig {
    KeyConfig { icon: Some(serde_json::json!({ "kind": "brand", "slug": slug, "title": title, "hex": hex })), ..k(label, color, action) }
}
fn sc(mods: &[&str], key: &str) -> Action {
    Action::Shortcut { mods: mods.iter().map(|s| s.to_string()).collect(), key: key.into() }
}
fn app(name: &str) -> Action {
    #[cfg(windows)]
    let path = name.to_string(); // resolved against the Start menu at runtime (actions::open_app)
    #[cfg(not(windows))]
    let path = format!("/Applications/{name}.app");
    Action::OpenApp { path, name: name.into() }
}
fn url(u: &str) -> Action {
    Action::OpenUrl { url: u.into() }
}
fn text(t: &str) -> Action {
    Action::TypeText { text: t.into(), submit: false }
}
fn media(m: MediaKey) -> Action {
    Action::Media { key: m }
}
fn profile(id: &str, name: &str, apps: &[&str], keys: Vec<KeyConfig>) -> Profile {
    Profile { id: id.into(), name: name.into(), apps: apps.iter().map(|s| s.to_string()).collect(), keys }
}

/// The 5 media keys used as the bottom row of a few profiles.
fn media_row(c: &str) -> Vec<KeyConfig> {
    vec![
        k("Anterior", c, media(MediaKey::Previous)),
        k("Play", c, media(MediaKey::PlayPause)),
        k("Próxima", c, media(MediaKey::Next)),
        k("Volume −", c, media(MediaKey::VolumeDown)),
        k("Volume +", c, media(MediaKey::VolumeUp)),
    ]
}

pub fn all() -> Vec<Profile> {
    let blue = "0a84ff";
    let mut v = vec![];

    // ---- launcher / base profile: your apps on top, quick actions, media at the bottom
    let mut keys = vec![
        k("VS Code", "0a84ff", app("Visual Studio Code")),
        k("Cursor", "3a3a3c", app("Cursor")),
        k("Figma", "a259ff", app("Figma")),
        k("ChatGPT", "10a37f", app("ChatGPT")),
        k("Claude", "d97757", app("Claude")),
        k("Discord", "5865f2", app("Discord")),
        k("Spotify", "1db954", app("Spotify")),
        k("Steam", "1b2838", app("Steam")),
        b("Dota 2", "bf2e1a", "dota2", "Dota 2", "BF2E1A", url("steam://rungameid/570")),
        e("Captura", "ff9f0a", "📸", sc(&["cmd", "shift"], "4")),
    ];
    keys.extend(media_row("2c2c2e"));
    v.push(profile("default", "Padrão", &[], keys));

    // ---- VS Code
    let (gr, pu, ye, rd) = ("30d158", "bf5af2", "ff9f0a", "ff453a");
    v.push(profile("vscode", "VS Code", &["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "Code"], vec![
        e("Comandos", blue, "⚡", sc(&["cmd", "shift"], "p")),
        e("Abrir arquivo", blue, "📄", sc(&["cmd"], "p")),
        e("Buscar", blue, "🔍", sc(&["cmd", "shift"], "f")),
        e("Explorador", blue, "📁", sc(&["cmd", "shift"], "e")),
        b("Git", "f05033", "git", "Git", "F03C2E", sc(&["ctrl", "shift"], "g")),
        e("Terminal", gr, "💻", sc(&["ctrl"], "`")),
        k("Barra lateral", blue, sc(&["cmd"], "b")),
        k("Dividir", blue, sc(&["cmd"], "\\")),
        k("Comentar", blue, sc(&["cmd"], "/")),
        e("Formatar", blue, "✨", sc(&["shift", "alt"], "f")),
        e("Definição", pu, "🧭", sc(&[], "F12")),
        e("Renomear", pu, "✏️", sc(&[], "F2")),
        e("Debug", ye, "🐛", sc(&[], "F5")),
        e("Parar", rd, "⏹️", sc(&["shift"], "F5")),
        e("Salvar", gr, "💾", sc(&["cmd"], "s")),
    ]));

    // ---- Cursor (VS Code base + AI)
    let ai = "3a3a3c";
    v.push(profile("cursor", "Cursor", &["com.todesktop.230313mzl4w4u92", "Cursor"], vec![
        e("Chat", ai, "💬", sc(&["cmd"], "l")),
        e("Editar", ai, "✏️", sc(&["cmd"], "k")),
        e("Agente", ai, "🤖", sc(&["cmd"], "i")),
        e("Aceitar", gr, "✅", sc(&["cmd"], "Return")),
        e("Rejeitar", rd, "❌", sc(&["cmd"], "Backspace")),
        e("Comandos", blue, "⚡", sc(&["cmd", "shift"], "p")),
        e("Abrir arquivo", blue, "📄", sc(&["cmd"], "p")),
        e("Buscar", blue, "🔍", sc(&["cmd", "shift"], "f")),
        e("Terminal", gr, "💻", sc(&["ctrl"], "`")),
        b("Git", "f05033", "git", "Git", "F03C2E", sc(&["ctrl", "shift"], "g")),
        k("Barra lateral", blue, sc(&["cmd"], "b")),
        k("Comentar", blue, sc(&["cmd"], "/")),
        e("Definição", pu, "🧭", sc(&[], "F12")),
        e("Renomear", pu, "✏️", sc(&[], "F2")),
        e("Salvar", gr, "💾", sc(&["cmd"], "s")),
    ]));

    // ---- Figma
    let (fp, fr, fg, fb) = ("a259ff", "f24e1e", "0acf83", "1abcfe");
    v.push(profile("figma", "Figma", &["com.figma.Desktop", "Figma"], vec![
        k("Mover", fb, sc(&[], "v")),
        k("Frame", fb, sc(&[], "f")),
        k("Retângulo", fb, sc(&[], "r")),
        k("Texto", fb, sc(&[], "t")),
        k("Caneta", fb, sc(&[], "p")),
        e("Auto layout", fp, "📐", sc(&["shift"], "a")),
        e("Componente", fp, "🧩", sc(&["alt", "cmd"], "k")),
        e("Agrupar", fp, "🗂️", sc(&["cmd"], "g")),
        k("Desagrupar", fp, sc(&["shift", "cmd"], "g")),
        e("Duplicar", fp, "📑", sc(&["cmd"], "d")),
        e("Ajustar tela", fg, "🔍", sc(&["shift"], "1")),
        k("Zoom 100%", fg, sc(&["shift"], "0")),
        e("Copiar estilo", fr, "🎨", sc(&["alt", "cmd"], "c")),
        e("Colar estilo", fr, "🖌️", sc(&["alt", "cmd"], "v")),
        e("Ações", fr, "⚡", sc(&["cmd"], "/")),
    ]));

    // ---- Discord
    let dc = "5865f2";
    v.push(profile("discord", "Discord", &["com.hnc.Discord", "Discord"], vec![
        e("Microfone", rd, "🎙️", sc(&["cmd", "shift"], "m")),
        e("Som", rd, "🎧", sc(&["cmd", "shift"], "d")),
        e("Atender", gr, "📞", sc(&["cmd"], "Return")),
        e("Recusar", rd, "❌", sc(&[], "Escape")),
        e("Ir para…", dc, "🧭", sc(&["cmd"], "k")),
        k("Canal acima", dc, sc(&["alt"], "Up")),
        k("Canal abaixo", dc, sc(&["alt"], "Down")),
        k("Não lido ↑", dc, sc(&["alt", "shift"], "Up")),
        k("Não lido ↓", dc, sc(&["alt", "shift"], "Down")),
        e("Marcar lido", dc, "✅", sc(&["shift"], "Escape")),
        e("Emoji", ye, "😀", sc(&["cmd"], "e")),
        e("Enviar arquivo", ye, "📎", sc(&["cmd", "shift"], "u")),
        e("Menções", ye, "🔔", sc(&["cmd"], "i")),
        e("Membros", ye, "👥", sc(&["cmd"], "u")),
        e("Fixadas", ye, "📌", sc(&["cmd"], "p")),
    ]));

    // ---- Steam
    let st = "1b2838";
    let mut keys = vec![
        e("Biblioteca", st, "🎮", url("steam://open/games")),
        e("Loja", st, "🛒", url("steam://store")),
        e("Amigos", st, "👥", url("steam://open/friends")),
        e("Downloads", st, "⬇️", url("steam://open/downloads")),
        e("Big Picture", st, "📺", url("steam://open/bigpicture")),
        b("Dota 2", "bf2e1a", "dota2", "Dota 2", "BF2E1A", url("steam://rungameid/570")),
        k("Discord", dc, app("Discord")),
        e("Overlay", "66c0f4", "🧭", sc(&["shift"], "Tab")),
        e("Captura", ye, "📸", sc(&[], "F12")),
        e("Mudo", "5e5ce6", "🔇", media(MediaKey::Mute)),
    ];
    keys.extend(media_row("2c2c2e"));
    v.push(profile("steam", "Steam", &["com.valvesoftware.steam", "steamwebhelper", "steam"], keys));

    // ---- Dota 2 (default hotkeys: abilities QWE DF R, items ZXC VBN)
    let (ab, ul, it) = ("0a84ff", "ff453a", "ff9f0a");
    v.push(profile("dota2", "Dota 2", &["com.valvesoftware.dota2", "dota2", "Dota 2"], vec![
        k("Habilidade 1", ab, sc(&[], "q")),
        k("Habilidade 2", ab, sc(&[], "w")),
        k("Habilidade 3", ab, sc(&[], "e")),
        k("Extra 1", ab, sc(&[], "d")),
        k("Extra 2", ab, sc(&[], "f")),
        e("Ultimate", ul, "💥", sc(&[], "r")),
        k("Item 1", it, sc(&[], "z")),
        k("Item 2", it, sc(&[], "x")),
        k("Item 3", it, sc(&[], "c")),
        e("Herói", gr, "🧙", sc(&[], "F1")),
        k("Item 4", it, sc(&[], "v")),
        k("Item 5", it, sc(&[], "b")),
        k("Item 6", it, sc(&[], "n")),
        e("Loja", gr, "🛒", sc(&[], "F4")),
        k("Discord", dc, app("Discord")),
    ]));

    // ---- ChatGPT / Claude: chat basics + prompt snippets
    let chat = |id: &str, name: &str, apps: &[&str], c: &str| {
        let (cy, vi, am) = ("32ade6", "bf5af2", "ff9f0a");
        profile(id, name, apps, vec![
            e("Novo chat", c, "✨", sc(&["cmd"], "n")),
            e("Colar", c, "📋", sc(&["cmd"], "v")),
            e("Enviar", gr, "🚀", sc(&[], "Return")),
            e("Copiar", c, "📄", sc(&["cmd"], "c")),
            e("Parar", rd, "⏹️", sc(&[], "Escape")),
            e("Explicar", cy, "💡", text("Explique este código passo a passo:\n")),
            e("Revisar", cy, "🔍", text("Revise este código, aponte bugs e sugira melhorias:\n")),
            e("Testes", cy, "🧪", text("Escreva testes para este código:\n")),
            e("Refatorar", cy, "🛠️", text("Refatore mantendo o comportamento, mais legível:\n")),
            e("Resumir", vi, "📝", text("Resuma em tópicos curtos:\n")),
            e("Traduzir", vi, "🌍", text("Traduza para inglês, tom natural:\n")),
            e("Melhorar", vi, "✍️", text("Melhore este texto, mais claro e direto:\n")),
            e("Commit", am, "💾", text("Escreva uma mensagem de commit (conventional commits) para este diff:\n")),
            e("Email", am, "📧", text("Escreva um email profissional e curto sobre:\n")),
            e("Encurtar", am, "✂️", text("Deixe mais curto, sem perder o essencial:\n")),
        ])
    };
    v.push(chat("chatgpt", "ChatGPT", &["com.openai.chat", "com.openai.codex", "ChatGPT"], "10a37f"));
    v.push(chat("claude", "Claude", &["com.anthropic.claudefordesktop", "Claude"], "d97757"));

    v
}
