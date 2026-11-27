// DIV Deck v1 firmware - ESP32 DevKit (classic)
// Reads the 3x5 key matrix and drives 15 SK6812MINI-E LEDs.
// Talks to the macOS companion app over USB serial with a line-based text protocol:
//
//   device -> host
//     HELLO DIVDECK <version> KEYS=15 LEDS=15 MODEL=MX ID=<chip>   on boot and in reply to "HELLO"
//     D <k>                                       key k pressed   (k = 0..14, row-major, 0 = top-left)
//     U <k>                                       key k released
//     PONG                                        reply to PING
//     OK / ERR <reason>                           reply to commands
//
//   host -> device
//     HELLO                                       identify
//     PING                                        keep-alive; the host sends it every ~2 s
//     L <k> <rrggbb>                              set the idle colour of key k
//     A <rrggbb>                                  set the idle colour of every key
//     P <rrggbb>                                  colour flashed while a key is held
//     B <0-255>                                   brightness (capped at BRIGHTNESS_MAX)
//     S                                           save colours + brightness to flash
//     C <epoch>                                   local time (seconds, already in the user's zone) - OLED clock
//     N <name>                                    active profile name - OLED
//     H <mask>                                    OLED: bit0 on, bit1 time, bit2 date, bit3 profile (saved)
//
// Optional 0.96" SSD1306 OLED (I2C 0x3C/0x3D on OLED_SDA/OLED_SCL, v1.4 pod). It is mounted upside
// down in the pod, so the image is rotated 180 deg. Without the OLED everything else works as before.
//
// Without a host (no line from it for 15 s) the keys show a cyan "waiting" wave instead of the profile
// (and the OLED asks to open the app); presses still light up, so the hardware can be tested
// with no app at all.

#include <Arduino.h>
#include <Adafruit_NeoPixel.h>
#include <Preferences.h>
#include <Wire.h>
#include <U8g2lib.h>
#include <time.h>
#include "config.h"

#ifndef DIVDECK_VERSION
#define DIVDECK_VERSION "dev"
#endif

static Adafruit_NeoPixel strip(LED_COUNT, LED_PIN, NEO_GRB + NEO_KHZ800);
static Preferences prefs;

static uint32_t idleColor[KEYS];
static uint32_t pressColor = 0xFFFFFF;
static uint8_t brightness = BRIGHTNESS_DEFAULT;

static bool keyState[KEYS];          // debounced state
static bool keyRaw[KEYS];            // last raw reading
static uint32_t keyChangedAt[KEYS];  // when the raw reading last changed

static uint32_t lastPing = 0;
static bool hostSeen = false;        // got a HELLO/PING since boot
// No app: the keys show a "waiting" wave instead of the profile, the OLED asks to open the app.
static bool noHost() { return !hostSeen || (int32_t)(millis() - lastPing) > (int32_t)HOST_TIMEOUT_MS; }
static bool ledsDirty = true;
static char rxBuf[96];

// OLED state
static U8G2_SSD1306_128X64_NONAME_F_HW_I2C oled(OLED_ROTATION, U8X8_PIN_NONE);
static bool oledOk = false;
static uint8_t oledMask = 0x0F;      // bit0 on, bit1 time, bit2 date, bit3 profile
static bool oledDirty = true;
static int64_t clockBase = 0;        // local epoch received from the app (0 = unknown)
static uint32_t clockAt = 0;         // millis() when clockBase was received
static char profileName[40] = "";
static uint8_t rxLen = 0;

// ---------------------------------------------------------------- persistence
static void loadSettings() {
  prefs.begin("divdeck", true);
  brightness = min<uint8_t>(prefs.getUChar("bri", BRIGHTNESS_DEFAULT), BRIGHTNESS_MAX);
  pressColor = prefs.getUInt("press", 0xFFFFFF);
  oledMask = prefs.getUChar("oled", 0x0F);
  for (uint8_t k = 0; k < KEYS; k++) {
    char key[6];
    snprintf(key, sizeof key, "c%u", k);
    // default palette: a calm blue-to-violet gradient across the deck
    uint32_t def = strip.Color(40 + k * 10, 60, 255 - k * 8);
    idleColor[k] = prefs.getUInt(key, def);
  }
  prefs.end();
}

static void saveSettings() {
  prefs.begin("divdeck", false);
  prefs.putUChar("bri", brightness);
  prefs.putUInt("press", pressColor);
  prefs.putUChar("oled", oledMask);
  for (uint8_t k = 0; k < KEYS; k++) {
    char key[6];
    snprintf(key, sizeof key, "c%u", k);
    prefs.putUInt(key, idleColor[k]);
  }
  prefs.end();
}

// ---------------------------------------------------------------- matrix
static void setupMatrix() {
  for (uint8_t r = 0; r < ROWS; r++) {
    pinMode(ROW_PINS[r], OUTPUT);
    digitalWrite(ROW_PINS[r], HIGH);
  }
  for (uint8_t c = 0; c < COLS; c++) pinMode(COL_PINS[c], INPUT_PULLUP);
}

// COL2ROW diodes: drive one row LOW, a pressed key pulls its column LOW.
static void scanMatrix() {
  uint32_t now = millis();
  for (uint8_t r = 0; r < ROWS; r++) {
    digitalWrite(ROW_PINS[r], LOW);
    delayMicroseconds(5);
    for (uint8_t c = 0; c < COLS; c++) {
      uint8_t k = r * COLS + c;
      bool pressed = digitalRead(COL_PINS[c]) == LOW;
      if (pressed != keyRaw[k]) {
        keyRaw[k] = pressed;
        keyChangedAt[k] = now;
      } else if (pressed != keyState[k] && now - keyChangedAt[k] >= DEBOUNCE_MS) {
        keyState[k] = pressed;
        Serial.printf("%c %u\n", pressed ? 'D' : 'U', k);
        ledsDirty = true;
      }
    }
    digitalWrite(ROW_PINS[r], HIGH);
  }
}

// ---------------------------------------------------------------- LEDs
static uint32_t scale(uint32_t c, uint8_t f) {
  uint8_t r = (c >> 16) & 0xFF, g = (c >> 8) & 0xFF, b = c & 0xFF;
  return strip.Color(r * f / 255, g * f / 255, b * f / 255);
}

static void renderLeds() {
  // no app: a slow diagonal wave in the DIV cyan, the profile colours come back with the app
  bool waiting = noHost();
  float t = (millis() % 3600) / 3600.0f * 2 * PI;
  for (uint8_t k = 0; k < KEYS; k++) {
    uint32_t c;
    if (keyState[k]) c = pressColor;
    else if (waiting) {
      float w = 0.5f + 0.5f * sinf(t - (k / COLS + k % COLS) * 0.8f);
      c = scale(0x38D6FF, 25 + (uint8_t)(150 * w));
    } else c = idleColor[k];
    // gamma correction: LEDs respond linearly, eyes don't. Without it mid tones and pastels
    // look washed out and the colours don't match what the app shows on screen.
    strip.setPixelColor(ledForKey(k), strip.gamma32(c));
  }
  strip.setBrightness(brightness);
  strip.show();
}

// ---------------------------------------------------------------- OLED
static const char *WD[] = {"DOM", "SEG", "TER", "QUA", "QUI", "SEX", "SAB"};
static const char *MO[] = {"JAN", "FEV", "MAR", "ABR", "MAI", "JUN", "JUL", "AGO", "SET", "OUT", "NOV", "DEZ"};

static void setupOled() {
  Wire.begin(OLED_SDA, OLED_SCL);
  uint8_t addr = 0;
  for (uint8_t a : {0x3C, 0x3D}) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) { addr = a; break; }
  }
  if (!addr) return;                 // no display: keep running without it
  oled.setI2CAddress(addr << 1);
  oled.setBusClock(400000);
  oledOk = oled.begin();
}

static bool nowTm(struct tm &t) {
  if (!clockBase) return false;
  time_t s = (time_t)(clockBase + (millis() - clockAt) / 1000);
  gmtime_r(&s, &t);                  // clockBase is already local time
  return true;
}

// Draws the whole screen. Content drifts by up to 2 px every few minutes against burn-in.
static void drawOled() {
  if (!oledOk) return;
  oledDirty = false;
  if (!(oledMask & 1)) { oled.setPowerSave(1); return; }
  oled.setPowerSave(0);
  oled.setContrast(map(brightness, 0, BRIGHTNESS_MAX, 8, 255));
  struct tm t;
  bool haveTime = nowTm(t);
  uint32_t drift = haveTime ? (uint32_t)(t.tm_hour * 60 + t.tm_min) / 3 : millis() / 180000;
  int dx = (int)(drift % 5) - 2, dy = (int)((drift / 5) % 3) - 1;
  oled.clearBuffer();
  bool showProfile = (oledMask & 8) && profileName[0];
  bool showTime = (oledMask & 2) && haveTime;
  bool showDate = (oledMask & 4) && haveTime;
  if (noHost() || (!showTime && !showDate && !showProfile)) {
    // no app (or nothing chosen): brand + a blinking prompt
    oled.setFont(u8g2_font_logisoso16_tr);
    oled.drawStr(18 + dx, 28 + dy, "DIV DECK");
    oled.setFont(u8g2_font_6x12_tr);
    bool blink = (millis() / 600) % 2;
    if (noHost()) oled.drawStr(16 + dx, 50 + dy, blink ? "> abra o app _" : "> abra o app");
    else oled.drawStr(40 + dx, 50 + dy, blink ? "> mx _" : "> mx");
    oled.sendBuffer();
    return;
  }
  int y = 0;
  if (showProfile) {
    oled.setFont(u8g2_font_6x12_tr);
    char line[24];
    snprintf(line, sizeof line, "> %.19s", profileName);
    oled.drawStr(2 + dx, 10 + dy, line);
    oled.drawHLine(0, 13 + dy, 128);
    y = 14;
  }
  if (showTime) {
    char hm[6];
    snprintf(hm, sizeof hm, "%02d:%02d", t.tm_hour, t.tm_min);
    oled.setFont(u8g2_font_logisoso28_tn);
    int w = oled.getStrWidth(hm);
    int base = showDate ? y + 34 : y + 40;
    oled.drawStr((128 - w) / 2 + dx, base + dy, hm);
  }
  if (showDate) {
    char d[20];
    snprintf(d, sizeof d, "%s %02d %s", WD[t.tm_wday], t.tm_mday, MO[t.tm_mon]);
    oled.setFont(u8g2_font_6x12_tr);
    int w = oled.getStrWidth(d);
    oled.drawStr((128 - w) / 2 + dx, (showTime ? 62 : y + 30) + dy, d);
  }
  oled.sendBuffer();
}

// ---------------------------------------------------------------- serial protocol
static bool parseHex(const char *s, uint32_t &out) {
  if (strlen(s) != 6) return false;
  char *end;
  out = strtoul(s, &end, 16);
  return *end == '\0';
}

static void hello() {
  // MODEL + ID let the app tell several decks apart (DIV Deck app 0.2+)
  Serial.printf("HELLO DIVDECK %s KEYS=%u LEDS=%u MODEL=MX ID=%012llx\n", DIVDECK_VERSION, KEYS, LED_COUNT, ESP.getEfuseMac());
}

static void handleLine(char *line) {
  char raw[sizeof rxBuf];
  strncpy(raw, line, sizeof raw - 1);
  raw[sizeof raw - 1] = '\0';
  char *cmd = strtok(line, " ");
  if (!cmd) return;
  char *a = strtok(nullptr, " ");
  char *b = strtok(nullptr, " ");
  uint32_t col;

  if (!strcmp(cmd, "PING")) {
    lastPing = millis(); hostSeen = true;
    Serial.println("PONG");
  } else if (!strcmp(cmd, "HELLO")) {
    lastPing = millis(); hostSeen = true;
    hello();
  } else if (!strcmp(cmd, "L") && a && b && parseHex(b, col)) {
    int k = atoi(a);
    if (k < 0 || k >= KEYS) { Serial.println("ERR key"); return; }
    idleColor[k] = col; ledsDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "A") && a && parseHex(a, col)) {
    for (uint8_t k = 0; k < KEYS; k++) idleColor[k] = col;
    ledsDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "P") && a && parseHex(a, col)) {
    pressColor = col; Serial.println("OK");
  } else if (!strcmp(cmd, "B") && a) {
    brightness = constrain(atoi(a), 0, BRIGHTNESS_MAX);
    ledsDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "C") && a) {
    clockBase = atoll(a); clockAt = millis(); oledDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "N")) {
    // the name may contain spaces: take the rest of the raw line after "N "
    strncpy(profileName, strlen(raw) > 2 ? raw + 2 : "", sizeof profileName - 1);
    profileName[sizeof profileName - 1] = '\0';
    oledDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "H") && a) {
    uint8_t m = atoi(a) & 0x0F;
    if (m != oledMask) { oledMask = m; saveSettings(); }
    oledDirty = true; Serial.println("OK");
  } else if (!strcmp(cmd, "S")) {
    saveSettings(); Serial.println("OK");
  } else {
    Serial.println("ERR unknown");
  }
}

static void pollSerial() {
  while (Serial.available()) {
    char ch = Serial.read();
    if (ch == '\r') continue;
    if (ch == '\n') {
      rxBuf[rxLen] = '\0';
      if (hostSeen) lastPing = millis();   // any line from the app proves it is there
      handleLine(rxBuf);
      rxLen = 0;
    } else if (rxLen < sizeof(rxBuf) - 1) {
      rxBuf[rxLen++] = ch;
    }
  }
}

// ---------------------------------------------------------------- main
void setup() {
  Serial.begin(SERIAL_BAUD);
  setupMatrix();
  strip.begin();
  loadSettings();
  // power-on self test: sweep each LED in chain order, then show the idle colours
  strip.setBrightness(brightness);
  for (uint8_t i = 0; i < LED_COUNT; i++) {
    strip.clear();
    strip.setPixelColor(i, strip.Color(255, 255, 255));
    strip.show();
    delay(40);
  }
  setupOled();
  drawOled();
  hello();
}

void loop() {
  static uint32_t lastScan = 0, lastFrame = 0;
  uint32_t now = millis();
  pollSerial();
  if (now - lastScan >= 1) { lastScan = now; scanMatrix(); }
  static bool wasWaiting = true;
  bool waiting = noHost();
  if (waiting != wasWaiting) { wasWaiting = waiting; ledsDirty = true; }
  if (ledsDirty || (waiting && now - lastFrame >= 20)) {
    lastFrame = now; ledsDirty = false;
    renderLeds();
  }
  // OLED: redraw when something changed, every minute for the clock, every second on the splash
  static uint32_t lastOled = 0;
  static int lastMin = -1;
  if (oledOk && now - lastOled >= 250) {
    lastOled = now;
    struct tm t;
    static bool oledWaiting = true;
    bool w = noHost();
    if (w != oledWaiting) { oledWaiting = w; oledDirty = true; }
    int m = (!w && nowTm(t)) ? t.tm_min : 100 + (int)((now / 600) % 2);
    if (m != lastMin) { lastMin = m; oledDirty = true; }
    if (oledDirty) drawOled();
  }
}
