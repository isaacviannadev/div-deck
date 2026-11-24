// DIV Deck Pro firmware - ESP32-S3 SuperMini + 4" ST7796S touchscreen (MSP4021)
// The 15 "keys" are tiles drawn on the screen in a 5 x 3 grid. The DIV Deck app sends their
// colour, label and glyph; a touch on a tile is reported exactly like a key on the MX deck.
//
// Same line protocol as the MX deck (115200, USB CDC), plus a few commands for the screen:
//
//   device -> host
//     HELLO DIVDECK <version> KEYS=15 MODEL=PRO ID=<chip>   on boot and in reply to "HELLO"
//     D <k> / U <k>                       tile k touched / released (0 = top-left, row-major)
//     PONG, OK, ERR <reason>
//
//   host -> device
//     HELLO, PING                         identify / keep-alive (every ~2 s)
//     L <k> <rrggbb>                      tile colour            (drawn on R)
//     A <rrggbb>                          every tile colour      (drawn on R)
//     P <rrggbb>                          colour while touched
//     B <0-96>                            backlight
//     T <k> <text>                        tile label (ASCII, may be empty)
//     G <k> <kind> [text]                 big glyph: txt <text> | play | next | prev | volup | voldown | mute | none
//     N <text>                            profile name (shown when the app is gone)
//     O <1|3>                             rotation: 1 = normal, 3 = upside down
//     IH <k> <hash|->                     tile icon (56x56 BGRA, stored in flash by hash). Unknown hash -> device answers "NEED <hash>"
//     IB <hash> <base64>                  a chunk of that icon (appended)
//     IE <hash>                           icon complete: stored and drawn on every tile waiting for it
//     R                                   redraw everything that changed
//     S                                   save tiles, backlight and rotation to flash
//
// Wiring (same as the Sentinela panel):
//   LCD 1 VCC->5V  2 GND  3 CS->10  4 RESET->3V3  5 DC->9  6 SDI->11  7 SCK->12  8 LED->15
//   9 SDO free  10 T_CLK->12  11 T_CS->3  12 T_DIN->11  13 T_DO->13  14 T_IRQ free

#include <Arduino.h>
#include <LovyanGFX.hpp>
#include <Preferences.h>
#include <LittleFS.h>
#include "mbedtls/base64.h"

#ifndef DIVDECK_VERSION
#define DIVDECK_VERSION "dev"
#endif

// One wire per ESP32 pin (jumper wires, no Y-splices): the touch controller gets its own SPI bus.
// ESP32-S3 SuperMini (9 pins per side: 5V GND 3V3 13 12 11 10 9 8 / TX RX 1 2 3 4 5 6 7).
#define PIN_SCK      12   // LCD SCK
#define PIN_MOSI     11   // LCD SDI
#define PIN_LCD_CS   10
#define PIN_LCD_DC    9
#define PIN_LCD_RST   8
#define PIN_BL        7   // LED (backlight PWM)
#define PIN_TOUCH_CS  3   // T_CS
#define PIN_T_CLK     4   // T_CLK
#define PIN_T_DIN     5   // T_DIN
#define PIN_T_DO      6   // T_DO
#define PIN_RGB      48

// If the colours come out inverted or red/blue swapped, flip these (same switches as the Sentinela test).
#define INVERT_COLOURS false
#define SWAP_RGB       false

static const uint8_t KEYS = 15, COLS = 5, ROWS = 3;
static const uint32_t HOST_TIMEOUT_MS = 5000;

class LGFX : public lgfx::LGFX_Device {
  lgfx::Panel_ST7796 _panel; lgfx::Bus_SPI _bus; lgfx::Touch_XPT2046 _touch; lgfx::Light_PWM _light;
public:
  LGFX() {
    { auto c = _bus.config();
      c.spi_host = SPI2_HOST; c.spi_mode = 0;
      c.freq_write = 40000000; c.freq_read = 16000000;
      c.pin_sclk = PIN_SCK; c.pin_mosi = PIN_MOSI; c.pin_miso = -1; c.pin_dc = PIN_LCD_DC;
      _bus.config(c); _panel.setBus(&_bus); }
    { auto c = _panel.config();
      c.pin_cs = PIN_LCD_CS; c.pin_rst = PIN_LCD_RST; c.pin_busy = -1;
      c.panel_width = 320; c.panel_height = 480;
      c.readable = false; c.bus_shared = false;
      c.invert = INVERT_COLOURS; c.rgb_order = SWAP_RGB;
      _panel.config(c); }
    { auto c = _light.config();
      c.pin_bl = PIN_BL; c.invert = false; c.freq = 12000; c.pwm_channel = 7;
      _light.config(c); _panel.setLight(&_light); }
    { auto c = _touch.config();
      c.spi_host = SPI3_HOST; c.freq = 1000000; c.bus_shared = false;
      c.pin_sclk = PIN_T_CLK; c.pin_mosi = PIN_T_DIN; c.pin_miso = PIN_T_DO;
      c.pin_cs = PIN_TOUCH_CS; c.pin_int = -1;
      c.x_min = 300; c.x_max = 3900; c.y_min = 200; c.y_max = 3700;
      c.offset_rotation = 0;
      _touch.config(c); _panel.setTouch(&_touch); }
    setPanel(&_panel);
  }
};
static LGFX tft;
static Preferences prefs;

struct Tile {
  uint32_t color;
  char label[24];
  char kind[8];      // txt play next prev volup voldown mute none
  char text[16];
  char icon[12];     // icon hash ("" = none): file /i/<hash>
};
// Tile faces: the app renders each whole tile (background, icon, text, anti-aliased) as an
// 86 x 96 RGB565 (big-endian) picture, cached in flash by hash. Without one the deck draws its own.
static const int FACE_W = 86, FACE_H = 96;
static const size_t ICON_BYTES = FACE_W * FACE_H * 2;
static bool haveFace[KEYS];
static uint16_t faceBuf[FACE_W * FACE_H];
static uint8_t stage[FACE_W * FACE_H * 2 + 4];   // face being received
static size_t stageLen = 0;
static char stageHash[12] = "";
static bool fsOk = false;
static Tile tiles[KEYS];
static bool tileDirty[KEYS];
static char profileName[32] = "";
static uint32_t pressColor = 0xFFFFFF;
static uint8_t brightness = 48, rotation = 1;
static uint32_t lastPing = 0;
static bool wasStandalone = true;
static int8_t touched = -1;
static bool locked = false;       // swipe down from the top edge: screen locked, logo animation
static uint32_t lockFrame = 0;

// ---------------------------------------------------------------- persistence
static void loadSettings() {
  prefs.begin("divpro", true);
  brightness = prefs.getUChar("bri", 48);
  rotation = prefs.getUChar("rot", 1);
  pressColor = prefs.getUInt("press", 0xFFFFFF);
  prefs.getString("name", profileName, sizeof profileName);
  bool have = prefs.getBytesLength("tiles2") == sizeof tiles;
  if (have) prefs.getBytes("tiles2", tiles, sizeof tiles);
  prefs.end();
  if (!have) {
    static const char *demo[KEYS] = {"VS Code", "Figma", "Claude", "Discord", "Steam", "Print", "Mudo", "Notas",
                                     "Terminal", "Spotify", "Play", "Anterior", "Proxima", "Vol -", "Vol +"};
    static const uint32_t pal[] = {0x0a84ff, 0x30d158, 0xff9f0a, 0xbf5af2, 0x38d6ff};
    for (uint8_t k = 0; k < KEYS; k++) {
      tiles[k].color = pal[k % 5];
      strlcpy(tiles[k].label, demo[k], sizeof tiles[k].label);
      strlcpy(tiles[k].kind, "txt", sizeof tiles[k].kind);
      strlcpy(tiles[k].text, String(demo[k]).substring(0, 2).c_str(), sizeof tiles[k].text);
    }
    for (uint8_t k = 0; k < KEYS; k++) tiles[k].icon[0] = '\0';
    const char *media[] = {"play", "prev", "next", "voldown", "volup"};
    for (uint8_t i = 0; i < 5; i++) strlcpy(tiles[10 + i].kind, media[i], sizeof tiles[0].kind);
  }
}

static void saveSettings() {
  prefs.begin("divpro", false);
  prefs.putUChar("bri", brightness);
  prefs.putUChar("rot", rotation);
  prefs.putUInt("press", pressColor);
  prefs.putString("name", profileName);
  prefs.putBytes("tiles2", tiles, sizeof tiles);
  prefs.end();
}

// ---------------------------------------------------------------- icons (flash cache by hash)
static String iconPath(const char *hash) { return String("/i/") + hash; }

static bool loadIcon(uint8_t k) {   // just checks the face file is there and complete
  haveFace[k] = false;
  if (!tiles[k].icon[0] || !fsOk) return false;
  File f = LittleFS.open(iconPath(tiles[k].icon), "r");
  if (!f) return false;
  haveFace[k] = f.size() == ICON_BYTES;
  f.close();
  return haveFace[k];
}

static bool drawFace(uint8_t k, int x, int y) {
  File f = LittleFS.open(iconPath(tiles[k].icon), "r");
  if (!f) return false;
  bool ok = f.read((uint8_t *)faceBuf, ICON_BYTES) == ICON_BYTES;
  f.close();
  if (ok) tft.pushImage(x, y, FACE_W, FACE_H, (const lgfx::swap565_t *)faceBuf);
  return ok;
}

static void dropOldIcons() {   // keep the flash from filling up: oldest files go first
  if (!fsOk) return;
  while (LittleFS.totalBytes() - LittleFS.usedBytes() < ICON_BYTES * 3) {
    File dir = LittleFS.open("/i");
    String oldest; time_t t0 = 0;
    for (File f = dir.openNextFile(); f; f = dir.openNextFile()) {
      String n = String("/i/") + f.name();
      bool inUse = false;
      for (uint8_t k = 0; k < KEYS; k++) if (n == iconPath(tiles[k].icon)) inUse = true;
      if (!inUse && (oldest.isEmpty() || f.getLastWrite() < t0)) { oldest = n; t0 = f.getLastWrite(); }
      f.close();
    }
    dir.close();
    if (oldest.isEmpty() || !LittleFS.remove(oldest)) break;
  }
}

// ---------------------------------------------------------------- drawing
static const int MARGIN = 8, GAP = 8;
static int tileW() { return (tft.width() - 2 * MARGIN - (COLS - 1) * GAP) / COLS; }
static int tileH() { return (tft.height() - 2 * MARGIN - (ROWS - 1) * GAP) / ROWS; }
static int tileX(uint8_t k) { return MARGIN + (k % COLS) * (tileW() + GAP); }
static int tileY(uint8_t k) { return MARGIN + (k / COLS) * (tileH() + GAP); }

static uint16_t rgb(uint32_t c, float f = 1.0f) {
  uint8_t r = ((c >> 16) & 0xFF) * f, g = ((c >> 8) & 0xFF) * f, b = (c & 0xFF) * f;
  return tft.color565(r, g, b);
}
static bool isLight(uint32_t c, float f) {
  float r = ((c >> 16) & 0xFF) * f, g = ((c >> 8) & 0xFF) * f, b = (c & 0xFF) * f;
  return 0.299f * r + 0.587f * g + 0.114f * b > 165;
}

static void drawSpeaker(int cx, int cy, uint16_t col) {
  tft.fillRect(cx - 16, cy - 6, 7, 12, col);
  tft.fillTriangle(cx - 10, cy, cx - 1, cy - 12, cx - 1, cy + 12, col);
}

static void drawGlyph(const Tile &t, int cx, int cy, int w, uint16_t fg) {
  if (!strcmp(t.kind, "play")) {
    tft.fillTriangle(cx - 8, cy - 13, cx - 8, cy + 13, cx + 14, cy, fg);
  } else if (!strcmp(t.kind, "next")) {
    tft.fillTriangle(cx - 12, cy - 12, cx - 12, cy + 12, cx + 6, cy, fg);
    tft.fillRect(cx + 7, cy - 12, 4, 24, fg);
  } else if (!strcmp(t.kind, "prev")) {
    tft.fillTriangle(cx + 12, cy - 12, cx + 12, cy + 12, cx - 6, cy, fg);
    tft.fillRect(cx - 11, cy - 12, 4, 24, fg);
  } else if (!strcmp(t.kind, "volup") || !strcmp(t.kind, "voldown") || !strcmp(t.kind, "mute")) {
    drawSpeaker(cx, cy, fg);
    if (!strcmp(t.kind, "mute")) {
      for (int d = -1; d <= 1; d++) { tft.drawLine(cx + 4, cy - 6 + d, cx + 15, cy + 6 + d, fg); tft.drawLine(cx + 4, cy + 6 + d, cx + 15, cy - 6 + d, fg); }
    } else {
      tft.fillRect(cx + 4, cy - 2, 12, 4, fg);
      if (!strcmp(t.kind, "volup")) tft.fillRect(cx + 8, cy - 6, 4, 12, fg);
    }
  } else if (!strcmp(t.kind, "txt") && t.text[0]) {
    tft.setTextColor(fg);
    tft.setTextDatum(middle_center);
    const lgfx::IFont *fonts[] = {&fonts::FreeSansBold18pt7b, &fonts::FreeSansBold12pt7b, &fonts::FreeSansBold9pt7b, &fonts::Font0};
    for (auto f : fonts) {
      tft.setFont(f);
      if (tft.textWidth(t.text) <= w - 12 || f == &fonts::Font0) break;
    }
    tft.drawString(t.text, cx, cy);
  }
}

static void drawTile(uint8_t k, bool pressed) {
  const Tile &t = tiles[k];
  int x = tileX(k), y = tileY(k), w = tileW(), h = tileH();
  bool empty = !strcmp(t.kind, "none") && !t.label[0];
  uint32_t base = pressed ? pressColor : t.color;
  float f = pressed ? 1.0f : 0.78f;
  uint16_t bg = empty ? tft.color565(0x15, 0x16, 0x1a) : rgb(base, f);
  uint16_t fg = empty ? tft.color565(0x40, 0x40, 0x44) : (isLight(base, f) ? TFT_BLACK : TFT_WHITE);
  tft.fillRect(x - 2, y - 2, w + 4, h + 4, TFT_BLACK);
  if (haveFace[k] && drawFace(k, x + (w - FACE_W) / 2, y + (h - FACE_H) / 2)) {
    if (pressed) {   // pressed: the app's press colour as a ring, plus a dimmed face
      uint16_t pc = rgb(pressColor);
      for (int i = 0; i < 3; i++) tft.drawRoundRect(x + i, y + i, w - 2 * i, h - 2 * i, 14 - i, pc);
    }
    return;
  }
  int inset = pressed ? 3 : 0;   // pressed tiles shrink a little
  tft.fillRoundRect(x + inset, y + inset, w - 2 * inset, h - 2 * inset, 14, bg);
  if (empty) return;
  // soft highlight on the top half, like the app
  if (!pressed) tft.fillRoundRect(x + 2, y + 2, w - 4, h / 2 - 2, 12, rgb(base, 0.86f));
  int gy = y + h / 2 - (t.label[0] ? 9 : 0);
  drawGlyph(t, x + w / 2, gy, w, fg);
  if (t.label[0]) {
    tft.setFont(&fonts::FreeSans9pt7b);
    tft.setTextColor(fg);
    tft.setTextDatum(bottom_center);
    String s = t.label;
    while (s.length() > 1 && tft.textWidth(s) > w - 8) s.remove(s.length() - 1);
    tft.drawString(s, x + w / 2, y + h - 7);
  }
}

static void drawAll() {
  if (locked) { for (uint8_t k = 0; k < KEYS; k++) tileDirty[k] = true; return; }
  tft.startWrite();
  tft.fillScreen(TFT_BLACK);
  for (uint8_t k = 0; k < KEYS; k++) { drawTile(k, k == touched); tileDirty[k] = false; }
  tft.endWrite();
}

static void drawDirty() {
  if (locked) return;
  tft.startWrite();
  for (uint8_t k = 0; k < KEYS; k++) if (tileDirty[k]) { drawTile(k, k == touched); tileDirty[k] = false; }
  tft.endWrite();
}

static void applyBrightness() { tft.setBrightness(map(min<uint8_t>(brightness, 96), 0, 96, 8, 255)); }

static void splash() {
  tft.fillScreen(TFT_BLACK);
  // the DIV Deck dot grid
  int cx = tft.width() / 2, cy = tft.height() / 2 - 14;
  static const float r[12] = {1.55, 1.3, 1.7, 1.42, 1.38, 1.72, 1.28, 1.6, 1.68, 1.45, 1.58, 1.25};
  for (int i = 0; i < 12; i++) tft.fillCircle(cx - 22 + (i % 4) * 15, cy - 15 + (i / 4) * 15, r[i] * 3.2, TFT_WHITE);
  tft.setTextColor(TFT_WHITE);
  tft.setTextDatum(middle_center);
  tft.setFont(&fonts::FreeSansBold12pt7b);
  tft.drawString("DIV Deck Pro", cx, cy + 50);
}

// ---------------------------------------------------------------- touch
static int8_t tileAt(int x, int y) {
  for (uint8_t k = 0; k < KEYS; k++) {
    int tx = tileX(k), ty = tileY(k);
    if (x >= tx - GAP / 2 && x < tx + tileW() + GAP / 2 && y >= ty - GAP / 2 && y < ty + tileH() + GAP / 2) return k;
  }
  return -1;
}

// ---------------------------------------------------------------- lock screen
// Swipe down from the top edge locks the deck (no key presses, the logo breathes, light dims).
// Swipe up anywhere unlocks.
static const int8_t LOGO_N = 12;
static const float LOGO_R[LOGO_N] = {1.55, 1.3, 1.7, 1.42, 1.38, 1.72, 1.28, 1.6, 1.68, 1.45, 1.58, 1.25};

static void drawLockFrame(bool full) {
  int cx = tft.width() / 2, cy = tft.height() / 2 - 22;
  tft.startWrite();
  if (full) {
    tft.fillScreen(TFT_BLACK);
    tft.setTextColor(TFT_WHITE); tft.setTextDatum(middle_center);
    tft.setFont(&fonts::FreeSansBold12pt7b);
    tft.drawString("DIV Deck Pro", cx, cy + 66);
    tft.setTextColor(tft.color565(0x60, 0x60, 0x66));
    tft.setFont(&fonts::Font2);
    tft.drawString("deslize para cima para desbloquear", cx, tft.height() - 18);
  }
  float t = lockFrame * 0.11f;
  for (int i = 0; i < LOGO_N; i++) {
    int col = i % 4, row = i / 4;
    int x = cx - 33 + col * 22, y = cy - 22 + row * 22;
    float wave = 0.5f + 0.5f * sinf(t - (col + row) * 0.7f);       // diagonal ripple through the grid
    float r = LOGO_R[i] * (3.4f + 1.5f * wave);
    uint8_t v = 150 + 105 * wave;
    tft.fillRect(x - 10, y - 10, 21, 21, TFT_BLACK);
    tft.fillCircle(x, y, (int)(r + 0.5f), tft.color565(v, v, v));
  }
  tft.endWrite();
}

static void setLocked(bool on) {
  if (on == locked) return;
  locked = on;
  if (touched >= 0) { Serial.printf("U %d\n", touched); touched = -1; }
  Serial.printf("LOCK %d\n", on ? 1 : 0);
  if (on) {
    tft.setBrightness(map(min<uint8_t>(brightness, 96), 0, 96, 8, 255) / 3 + 4);
    lockFrame = 0;
    drawLockFrame(true);
  } else {
    applyBrightness();
    drawAll();
  }
}

static void pollTouch() {
  static uint8_t hits = 0, misses = 0;
  static int8_t candidate = -1;
  static bool tracking = false, edge = false;
  static int sy = 0;
  lgfx::touch_point_t tp;
  bool down = tft.getTouch(&tp) > 0;
  if (down) tp.x = tft.width() - 1 - tp.x;   // this panel's touch X runs the other way

  // gestures
  if (down && !tracking) { tracking = true; sy = tp.y; edge = !locked && tp.y < 22; }
  if (down && tracking) {
    if (edge && tp.y - sy > 70) { edge = false; setLocked(true); }
    else if (locked && sy - tp.y > 80) { setLocked(false); tracking = true; edge = false; sy = -1000; }
  }
  if (!down && tracking && ++misses >= 3) { tracking = false; edge = false; }
  if (locked || edge || sy == -1000) {        // no key presses while locked or swiping from the edge
    if (!down) { if (!tracking) sy = 0; misses = min<uint8_t>(misses, 3); }
    candidate = -1; hits = 0;
    if (!tracking) misses = 0;
    return;
  }

  int8_t k = down ? tileAt(tp.x, tp.y) : -1;
  if (down && k >= 0) {
    misses = 0;
    if (touched >= 0) return;               // already holding a tile: ignore sliding
    if (k == candidate) hits++; else { candidate = k; hits = 1; }
    if (hits >= 2) {                         // two readings in a row on the same tile
      touched = k;
      Serial.printf("D %d\n", k);
      tft.startWrite(); drawTile(k, true); tft.endWrite();
    }
  } else {
    candidate = -1; hits = 0;
    if (touched >= 0 && misses >= 3) {       // ~45 ms without touch = released
      int8_t k0 = touched; touched = -1; misses = 0;
      Serial.printf("U %d\n", k0);
      tft.startWrite(); drawTile(k0, false); tft.endWrite();
    }
  }
}

// ---------------------------------------------------------------- serial protocol
static void hello() {
  Serial.printf("HELLO DIVDECK %s KEYS=%u MODEL=PRO ID=%012llx\n", DIVDECK_VERSION, KEYS, ESP.getEfuseMac());
}

static bool parseHex(const char *s, uint32_t &out) {
  if (!s || strlen(s) != 6) return false;
  char *end;
  out = strtoul(s, &end, 16);
  return *end == '\0';
}

// splits "<cmd> <rest>"; rest may contain spaces
static void handleLine(char *line) {
  char *rest = strchr(line, ' ');
  if (rest) *rest++ = '\0';
  const char *cmd = line;
  uint32_t col;
  auto keyArg = [&](char *&p) -> int {        // parses "<k>" and advances p past it
    if (!p) return -1;
    int k = atoi(p);
    char *sp = strchr(p, ' ');
    p = sp ? sp + 1 : p + strlen(p);
    return (k >= 0 && k < KEYS) ? k : -1;
  };

  if (!strcmp(cmd, "PING")) {
    lastPing = millis();
    Serial.println("PONG");
  } else if (!strcmp(cmd, "HELLO")) {
    lastPing = millis();
    hello();
  } else if (!strcmp(cmd, "L")) {
    int k = keyArg(rest);
    if (k < 0 || !parseHex(rest, col)) { Serial.println("ERR key"); return; }
    if (tiles[k].color != col) { tiles[k].color = col; tileDirty[k] = true; }
    Serial.println("OK");
  } else if (!strcmp(cmd, "A") && parseHex(rest, col)) {
    for (uint8_t k = 0; k < KEYS; k++) { tiles[k].color = col; tileDirty[k] = true; }
    Serial.println("OK");
  } else if (!strcmp(cmd, "P") && parseHex(rest, col)) {
    pressColor = col; Serial.println("OK");
  } else if (!strcmp(cmd, "B") && rest) {
    brightness = constrain(atoi(rest), 0, 96); applyBrightness(); Serial.println("OK");
  } else if (!strcmp(cmd, "T")) {
    int k = keyArg(rest);
    if (k < 0) { Serial.println("ERR key"); return; }
    if (strncmp(tiles[k].label, rest, sizeof tiles[k].label - 1)) { strlcpy(tiles[k].label, rest, sizeof tiles[k].label); tileDirty[k] = true; }
    Serial.println("OK");
  } else if (!strcmp(cmd, "G")) {
    int k = keyArg(rest);
    if (k < 0) { Serial.println("ERR key"); return; }
    char kind[8] = "none";
    const char *txt = "";
    char *sp = strchr(rest, ' ');
    if (sp) { *sp = '\0'; txt = sp + 1; }
    strlcpy(kind, rest[0] ? rest : "none", sizeof kind);
    if (strcmp(tiles[k].kind, kind) || strcmp(tiles[k].text, txt)) {
      strlcpy(tiles[k].kind, kind, sizeof tiles[k].kind);
      strlcpy(tiles[k].text, txt, sizeof tiles[k].text);
      tileDirty[k] = true;
    }
    Serial.println("OK");
  } else if (!strcmp(cmd, "IH")) {
    int k = keyArg(rest);
    if (k < 0) { Serial.println("ERR key"); return; }
    const char *h = (rest && rest[0] && strcmp(rest, "-")) ? rest : "";
    if (strcmp(tiles[k].icon, h)) {
      strlcpy(tiles[k].icon, h, sizeof tiles[k].icon);
      tileDirty[k] = true;
      loadIcon(k);
      if (h[0] && !haveFace[k]) { Serial.printf("NEED %s\n", h); return; }
    } else if (h[0] && !haveFace[k] && !loadIcon(k)) {
      Serial.printf("NEED %s\n", h); return;
    }
    Serial.println("OK");
  } else if (!strcmp(cmd, "IB") && rest) {          // face chunk -> RAM (no flash writes per chunk)
    char *sp = strchr(rest, ' ');
    if (!sp) return;
    *sp = '\0';
    if (strcmp(stageHash, rest)) { strlcpy(stageHash, rest, sizeof stageHash); stageLen = 0; }
    size_t n = 0;
    if (stageLen > ICON_BYTES ||
        mbedtls_base64_decode(stage + stageLen, ICON_BYTES - stageLen, &n, (const unsigned char *)sp + 1, strlen(sp + 1)) != 0) {
      stageLen = ICON_BYTES + 1;   // poisoned: IE will report it
      return;
    }
    stageLen += n;
  } else if (!strcmp(cmd, "IE") && rest) {          // face complete: show it now, then keep it in flash
    if (strcmp(stageHash, rest) || stageLen != ICON_BYTES) { stageHash[0] = '\0'; Serial.printf("FAIL %s\n", rest); return; }
    tft.startWrite();
    for (uint8_t k = 0; k < KEYS; k++) if (!strcmp(tiles[k].icon, rest)) {
      haveFace[k] = true; tileDirty[k] = locked;
      if (locked) continue;
      int x = tileX(k), y = tileY(k);
      tft.fillRect(x - 2, y - 2, tileW() + 4, tileH() + 4, TFT_BLACK);
      tft.pushImage(x + (tileW() - FACE_W) / 2, y + (tileH() - FACE_H) / 2, FACE_W, FACE_H, (const lgfx::swap565_t *)stage);
    }
    tft.endWrite();
    if (fsOk) {
      dropOldIcons();
      File f = LittleFS.open(iconPath(rest), "w");
      if (f) { f.write(stage, ICON_BYTES); f.close(); }
    }
    stageHash[0] = '\0'; stageLen = 0;
    Serial.printf("SAVED %s\n", rest);
  } else if (!strcmp(cmd, "N")) {
    strlcpy(profileName, rest ? rest : "", sizeof profileName); Serial.println("OK");
  } else if (!strcmp(cmd, "O") && rest) {
    uint8_t r = atoi(rest) == 3 ? 3 : 1;
    if (r != rotation) { rotation = r; tft.setRotation(rotation); drawAll(); }
    Serial.println("OK");
  } else if (!strcmp(cmd, "R")) {
    drawDirty(); Serial.println("OK");
  } else if (!strcmp(cmd, "S")) {
    saveSettings(); Serial.println("OK");
  } else {
    Serial.println("ERR unknown");
  }
}

static void pollSerial() {
  static char buf[1280];
  static uint16_t len = 0;
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') { buf[len] = '\0'; handleLine(buf); len = 0; }
    else if (len < sizeof(buf) - 1) buf[len++] = ch;
  }
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.setRxBufferSize(32768);   // a whole profile + face chunks arrive in bursts
  Serial.begin(115200);
  neopixelWrite(PIN_RGB, 0, 0, 12);
  loadSettings();
  fsOk = LittleFS.begin(true);
  if (fsOk) LittleFS.mkdir("/i");
  for (uint8_t k = 0; k < KEYS; k++) loadIcon(k);
  tft.init();
  tft.setRotation(rotation);
  applyBrightness();
  splash();
  delay(700);
  drawAll();
  neopixelWrite(PIN_RGB, 0, 0, 0);
  hello();
}

void loop() {
  static uint32_t lastTouch = 0;
  uint32_t now = millis();
  pollSerial();
  if (now - lastTouch >= 15) { lastTouch = now; pollTouch(); }
  static uint32_t lastAnim = 0;
  if (locked && now - lastAnim >= 33) { lastAnim = now; lockFrame++; drawLockFrame(false); }
  // small status LED on the SuperMini: green while the app is connected
  bool standalone = now - lastPing > HOST_TIMEOUT_MS;
  if (standalone != wasStandalone) {
    wasStandalone = standalone;
    neopixelWrite(PIN_RGB, 0, standalone ? 0 : 6, 0);
  }
}
