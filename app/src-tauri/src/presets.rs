//! Built-in profiles. They are merged into existing configs once per PRESETS_VERSION, so new
//! presets show up after an update without touching profiles the user already edited.

use crate::config::{Action, KeyConfig, MediaKey, Profile};

pub const PRESETS_VERSION: u32 = 1;

fn k(label: &str, color: &str, action: Action) -> KeyConfig {
    KeyConfig { label: label.into(), color: color.into(), action, icon: None }
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
        k("Play", c, media(MediaKey::PlayPause)),
        k("Anterior", c, media(MediaKey::Previous)),
        k("Próxima", c, media(MediaKey::Next)),
        k("Vol −", c, media(MediaKey::VolumeDown)),
        k("Vol +", c, media(MediaKey::VolumeUp)),
    ]
}

pub fn all() -> Vec<Profile> {
    let blue = "3ea6ff";
    let mut v = vec![];

    // ---- launcher / base profile
    let mut keys = vec![
        k("VS Code", "3ea6ff", app("Visual Studio Code")),
        k("Cursor", "e8e8e8", app("Cursor")),
        k("Figma", "a259ff", app("Figma")),
        k("ChatGPT", "10a37f", app("ChatGPT")),
        k("Claude", "d97757", app("Claude")),
        k("Discord", "5865f2", app("Discord")),
        k("Steam", "66c0f4", app("Steam")),
        k("Dota 2", "e0332b", url("steam://rungameid/570")),
        k("Print", "ffb020", sc(&["cmd", "shift"], "4")),
        k("Mudo", "7c5cff", media(MediaKey::Mute)),
    ];
    keys.extend(media_row("38d6ff"));
    v.push(profile("default", "Padrão", &[], keys));

    // ---- VS Code
    let vs = |l: &str, a| k(l, blue, a);
    v.push(profile("vscode", "VS Code", &["com.microsoft.VSCode", "com.microsoft.VSCodeInsiders", "Code"], vec![
        vs("Paleta", sc(&["cmd", "shift"], "p")),
        vs("Arquivo", sc(&["cmd"], "p")),
        vs("Buscar", sc(&["cmd", "shift"], "f")),
        vs("Explorer", sc(&["cmd", "shift"], "e")),
        k("Git", "f05033", sc(&["ctrl", "shift"], "g")),
        k("Terminal", "3ddc84", sc(&["ctrl"], "`")),
        vs("Sidebar", sc(&["cmd"], "b")),
        vs("Dividir", sc(&["cmd"], "\\")),
        vs("Comentar", sc(&["cmd"], "/")),
        vs("Formatar", sc(&["shift", "alt"], "f")),
        k("Definição", "a259ff", sc(&[], "F12")),
        k("Renomear", "a259ff", sc(&[], "F2")),
        k("Debug", "ffb020", sc(&[], "F5")),
        k("Parar", "ff2d55", sc(&["shift"], "F5")),
        k("Salvar", "3ddc84", sc(&["cmd"], "s")),
    ]));

    // ---- Cursor (VS Code base + AI)
    let ai = "e8e8e8";
    v.push(profile("cursor", "Cursor", &["com.todesktop.230313mzl4w4u92", "Cursor"], vec![
        k("Chat", ai, sc(&["cmd"], "l")),
        k("Editar", ai, sc(&["cmd"], "k")),
        k("Agente", ai, sc(&["cmd"], "i")),
        k("Aceitar", "3ddc84", sc(&["cmd"], "Return")),
        k("Rejeitar", "ff2d55", sc(&["cmd"], "Backspace")),
        k("Paleta", blue, sc(&["cmd", "shift"], "p")),
        k("Arquivo", blue, sc(&["cmd"], "p")),
        k("Buscar", blue, sc(&["cmd", "shift"], "f")),
        k("Terminal", "3ddc84", sc(&["ctrl"], "`")),
        k("Git", "f05033", sc(&["ctrl", "shift"], "g")),
        k("Sidebar", blue, sc(&["cmd"], "b")),
        k("Comentar", blue, sc(&["cmd"], "/")),
        k("Definição", "a259ff", sc(&[], "F12")),
        k("Renomear", "a259ff", sc(&[], "F2")),
        k("Salvar", "3ddc84", sc(&["cmd"], "s")),
    ]));

    // ---- Figma
    let (fp, fr, fg, fb) = ("a259ff", "f24e1e", "0acf83", "1abcfe");
    v.push(profile("figma", "Figma", &["com.figma.Desktop", "Figma"], vec![
        k("Mover", fb, sc(&[], "v")),
        k("Frame", fb, sc(&[], "f")),
        k("Retângulo", fb, sc(&[], "r")),
        k("Texto", fb, sc(&[], "t")),
        k("Caneta", fb, sc(&[], "p")),
        k("Auto layout", fp, sc(&["shift"], "a")),
        k("Componente", fp, sc(&["alt", "cmd"], "k")),
        k("Agrupar", fp, sc(&["cmd"], "g")),
        k("Desagrupar", fp, sc(&["shift", "cmd"], "g")),
        k("Duplicar", fp, sc(&["cmd"], "d")),
        k("Ajustar", fg, sc(&["shift"], "1")),
        k("Zoom 100%", fg, sc(&["shift"], "0")),
        k("Copiar estilo", fr, sc(&["alt", "cmd"], "c")),
        k("Colar estilo", fr, sc(&["alt", "cmd"], "v")),
        k("Ações", fr, sc(&["cmd"], "/")),
    ]));

    // ---- Discord
    let dc = "5865f2";
    v.push(profile("discord", "Discord", &["com.hnc.Discord", "Discord"], vec![
        k("Mudo", "ff2d55", sc(&["cmd", "shift"], "m")),
        k("Ensurdecer", "ff2d55", sc(&["cmd", "shift"], "d")),
        k("Atender", "3ddc84", sc(&["cmd"], "Return")),
        k("Recusar", "ff2d55", sc(&[], "Escape")),
        k("Ir para…", dc, sc(&["cmd"], "k")),
        k("Canal ↑", dc, sc(&["alt"], "Up")),
        k("Canal ↓", dc, sc(&["alt"], "Down")),
        k("Não lido ↑", dc, sc(&["alt", "shift"], "Up")),
        k("Não lido ↓", dc, sc(&["alt", "shift"], "Down")),
        k("Marcar lido", dc, sc(&["shift"], "Escape")),
        k("Emoji", "ffb020", sc(&["cmd"], "e")),
        k("Enviar arquivo", "ffb020", sc(&["cmd", "shift"], "u")),
        k("Caixa", "ffb020", sc(&["cmd"], "i")),
        k("Membros", "ffb020", sc(&["cmd"], "u")),
        k("Fixados", "ffb020", sc(&["cmd"], "p")),
    ]));

    // ---- Steam
    let st = "66c0f4";
    let mut keys = vec![
        k("Biblioteca", st, url("steam://open/games")),
        k("Loja", st, url("steam://store")),
        k("Amigos", st, url("steam://open/friends")),
        k("Downloads", st, url("steam://open/downloads")),
        k("Big Picture", st, url("steam://open/bigpicture")),
        k("Dota 2", "e0332b", url("steam://rungameid/570")),
        k("Discord", "5865f2", app("Discord")),
        k("Overlay", "ffb020", sc(&["shift"], "Tab")),
        k("Screenshot", "ffb020", sc(&[], "F12")),
        k("Mudo", "7c5cff", media(MediaKey::Mute)),
    ];
    keys.extend(media_row("7c5cff"));
    v.push(profile("steam", "Steam", &["com.valvesoftware.steam", "steamwebhelper", "steam"], keys));

    // ---- Dota 2 (default hotkeys: abilities QWE DF R, items ZXC VBN)
    let (ab, ul, it) = ("38d6ff", "ff2d55", "ffb020");
    v.push(profile("dota2", "Dota 2", &["com.valvesoftware.dota2", "dota2", "Dota 2"], vec![
        k("Q", ab, sc(&[], "q")),
        k("W", ab, sc(&[], "w")),
        k("E", ab, sc(&[], "e")),
        k("D", ab, sc(&[], "d")),
        k("F", ab, sc(&[], "f")),
        k("ULT", ul, sc(&[], "r")),
        k("Item 1", it, sc(&[], "z")),
        k("Item 2", it, sc(&[], "x")),
        k("Item 3", it, sc(&[], "c")),
        k("Herói", "3ddc84", sc(&[], "F1")),
        k("Item 4", it, sc(&[], "v")),
        k("Item 5", it, sc(&[], "b")),
        k("Item 6", it, sc(&[], "n")),
        k("Loja", "3ddc84", sc(&[], "F4")),
        k("Discord", "5865f2", app("Discord")),
    ]));

    // ---- ChatGPT / Claude: prompt snippets + chat basics
    let chat = |id: &str, name: &str, apps: &[&str], c: &str| {
        profile(id, name, apps, vec![
            k("Novo chat", c, sc(&["cmd"], "n")),
            k("Colar", c, sc(&["cmd"], "v")),
            k("Enviar", "3ddc84", sc(&[], "Return")),
            k("Copiar", c, sc(&["cmd"], "c")),
            k("Parar", "ff2d55", sc(&[], "Escape")),
            k("Explicar", "38d6ff", text("Explique este código passo a passo:\n")),
            k("Revisar", "38d6ff", text("Revise este código, aponte bugs e sugira melhorias:\n")),
            k("Testes", "38d6ff", text("Escreva testes para este código:\n")),
            k("Refatorar", "38d6ff", text("Refatore mantendo o comportamento, mais legível:\n")),
            k("Resumir", "a259ff", text("Resuma em tópicos curtos:\n")),
            k("Traduzir EN", "a259ff", text("Traduza para inglês, tom natural:\n")),
            k("Melhorar texto", "a259ff", text("Melhore este texto, mais claro e direto:\n")),
            k("Commit msg", "ffb020", text("Escreva uma mensagem de commit (conventional commits) para este diff:\n")),
            k("Email", "ffb020", text("Escreva um email profissional e curto sobre:\n")),
            k("Encurtar", "ffb020", text("Deixe mais curto, sem perder o essencial:\n")),
        ])
    };
    v.push(chat("chatgpt", "ChatGPT", &["com.openai.chat", "com.openai.codex", "ChatGPT"], "10a37f"));
    v.push(chat("claude", "Claude", &["com.anthropic.claudefordesktop", "Claude"], "d97757"));

    v
}
